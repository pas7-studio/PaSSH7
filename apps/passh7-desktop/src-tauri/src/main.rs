#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod ssh_sessions;
use std::{io::{BufReader, Read}, net::{TcpStream, ToSocketAddrs}, path::PathBuf, sync::Mutex, time::{Duration, Instant}};
use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, Zeroizing};
use tauri::State;
use ssh_sessions::SshSessionManager;
use passh7_core::{HostProfile, HubError, Identity};

const IDLE_TIMEOUT: Duration = Duration::from_secs(15 * 60);

#[derive(Default)]
struct SessionStore(Mutex<Option<UnlockedSession>>);

struct UnlockedSession {
    password: Zeroizing<String>,
    last_used: Instant,
}

impl SessionStore {
    fn use_password<T>(&self, operation: impl FnOnce(&str) -> Result<T, String>) -> Result<T, String> {
        let mut guard = self.0.lock().map_err(|_| "Vault session unavailable")?;
        let session = guard.as_mut().ok_or("Vault is locked")?;
        if session.last_used.elapsed() >= IDLE_TIMEOUT {
            *guard = None;
            return Err("Vault session expired".into());
        }
        let result = operation(&session.password);
        session.last_used = Instant::now();
        result
    }
    fn lock(&self) -> Result<(), String> {
        *self.0.lock().map_err(|_| "Vault session unavailable")? = None;
        Ok(())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostSummary {
    alias: String,
    hostname: String,
    port: u16,
    username: String,
    identity_alias: String,
    host_key_pinned: bool,
    has_saved_credentials: bool,
    saved_auth_mode: Option<String>,
}
fn vault_path() -> Result<PathBuf, String> {
    let root = std::env::var_os("LOCALAPPDATA").map(PathBuf::from)
        .or_else(|| std::env::var_os("XDG_DATA_HOME").map(PathBuf::from))
        .ok_or("No per-user application data directory found")?;
    let dir = root.join("PaSSH7");
    std::fs::create_dir_all(&dir).map_err(|_| "Unable to access vault directory")?;
    Ok(dir.join("vault.json"))
}
fn safe_err(error: HubError) -> String {
    match error {
        HubError::Busy => "Vault is busy; retry shortly".into(),
        HubError::Authentication => "Wrong password or damaged vault".into(),
        HubError::UnsupportedFormat => "Unsupported vault version".into(),
        HubError::InvalidInput(reason) => reason.to_owned(),
        HubError::Io(error) => format!("Vault file I/O failed ({}; Windows code {:?}). Check vault directory permissions and free disk space.", error.kind(), error.raw_os_error()),
        HubError::Json(_) => "Vault data serialization failed".into(),
        HubError::Kdf => "Vault encryption key derivation failed".into(),
    }
}
#[tauri::command]
fn vault_exists() -> Result<bool, String> { Ok(vault_path()?.exists()) }

#[tauri::command]
fn vault_initialize(mut master_password: String) -> Result<(), String> {
    let result = passh7_core::create(&vault_path()?, &master_password).map_err(safe_err);
    master_password.zeroize();
    result
}
#[tauri::command]
fn vault_unlock(mut master_password: String, sessions: State<'_, SessionStore>) -> Result<(), String> {
    let result = passh7_core::load(&vault_path()?, &master_password).map_err(safe_err);
    if let Err(err) = result {
        master_password.zeroize();
        return Err(err);
    }
    let mut guard = sessions.0.lock().map_err(|_| "Vault session unavailable")?;
    *guard = Some(UnlockedSession { password: Zeroizing::new(master_password), last_used: Instant::now() });
    Ok(())
}
#[tauri::command]
fn vault_lock(sessions: State<'_, SessionStore>, ssh: State<'_, SshSessionManager>) -> Result<(), String> { ssh.stop_all(); sessions.lock() }

#[tauri::command]
fn vault_status(sessions: State<'_, SessionStore>, ssh: State<'_, SshSessionManager>) -> Result<bool, String> {
    let mut guard = sessions.0.lock().map_err(|_| "Vault session unavailable")?;
    if guard.as_ref().is_some_and(|s| s.last_used.elapsed() >= IDLE_TIMEOUT) { *guard = None; ssh.stop_all(); }
    Ok(guard.is_some())
}
#[tauri::command]
fn vault_list_hosts(sessions: State<'_, SessionStore>) -> Result<Vec<HostSummary>, String> {
    sessions.use_password(|password| {
        let vault = passh7_core::load(&vault_path()?, password).map_err(safe_err)?;
        Ok(vault.hosts.into_iter().map(|h| HostSummary {
            alias:h.alias,hostname:h.hostname,port:h.port,username:h.username,
            identity_alias:h.identity_alias,host_key_pinned:h.pinned_host_key.is_some(),
            has_saved_credentials:h.extensions.contains_key("passh7_saved_auth"),
            saved_auth_mode:h.extensions.get("passh7_saved_auth").and_then(|v| v.get("mode")).and_then(|v| v.as_str()).map(str::to_owned)
        }).collect())
    })
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostInput {
    alias:String, hostname:String, port:u16, username:String,
    identity_alias:String, pinned_host_key:Option<String>,
}
#[tauri::command]
fn vault_add_host(host: HostInput, sessions: State<'_, SessionStore>) -> Result<(), String> {
    sessions.use_password(|password| {
        passh7_core::transaction(&vault_path()?,password,|vault| {
            vault.add_host(HostProfile {
                alias:host.alias.clone(),hostname:host.hostname.clone(),port:host.port,
                username:host.username.clone(),identity_alias:host.identity_alias.clone(),
                pinned_host_key:host.pinned_host_key.clone(),extensions:Default::default()
            })?;
            Ok(true)
        }).map_err(safe_err)
    })
}
// Credentials remain inside the existing Argon2id/XChaCha20 encrypted vault.
// Neither this command nor host listing ever returns secret strings to the frontend.
#[tauri::command]
fn vault_save_host_credentials(alias: String, auth_mode: String, mut account_password: String,
    mut key_passphrase: String, sessions: State<'_, SessionStore>) -> Result<(), String> {
    if !matches!(auth_mode.as_str(), "key" | "password" | "key-password") {
        account_password.zeroize();
        key_passphrase.zeroize();
        return Err("Invalid authentication mode".into());
    }
    if auth_mode != "key" && account_password.is_empty() {
        account_password.zeroize();
        key_passphrase.zeroize();
        return Err("Account password is required to save this authentication mode".into());
    }
    let result = sessions.use_password(|password| {
        passh7_core::transaction(&vault_path()?,password,|vault| {
            let host = vault.hosts.iter_mut().find(|h| h.alias == alias)
                .ok_or(HubError::InvalidInput("host not found"))?;
            host.extensions.insert("passh7_saved_auth".to_owned(),serde_json::json!({
                "mode":auth_mode,"account_password":account_password,"key_passphrase":key_passphrase
            }));
            Ok(true)
        }).map_err(safe_err)
    });
    account_password.zeroize();
    key_passphrase.zeroize();
    result
}

#[tauri::command]
fn vault_forget_host_credentials(alias: String, sessions: State<'_, SessionStore>) -> Result<(), String> {
    sessions.use_password(|password| {
        passh7_core::transaction(&vault_path()?,password,|vault| {
            let host = vault.hosts.iter_mut().find(|h| h.alias == alias)
                .ok_or(HubError::InvalidInput("host not found"))?;
            Ok(host.extensions.remove("passh7_saved_auth").is_some())
        }).map_err(safe_err)
    })
}

#[tauri::command]
fn vault_list_identities(sessions: State<'_, SessionStore>) -> Result<Vec<String>, String> {
    sessions.use_password(|password| {
        let vault = passh7_core::load(&vault_path()?, password).map_err(safe_err)?;
        Ok(vault.identities.iter().map(|i| i.alias.clone()).collect())
    })
}

/// Accepts a pasted key from the user, never a path selected by an agent.
/// Key content remains in memory and is never returned to JS.
#[tauri::command]
fn vault_import_identity(alias: String, mut private_key_pem: String, key_passphrase: Option<String>,
    sessions: State<'_, SessionStore>) -> Result<(), String> {
    let key_passphrase = Zeroizing::new(key_passphrase.unwrap_or_default());
    if private_key_pem.len() > 128 * 1024 {
        private_key_pem.zeroize();
        return Err("SSH identity exceeds 128 KiB".into());
    }
    if !private_key_pem.contains("-----BEGIN ") || !private_key_pem.contains("PRIVATE KEY-----") {
        private_key_pem.zeroize();
        return Err("Paste the PRIVATE key (file without .pub), including BEGIN/END PRIVATE KEY lines. A public ssh-ed25519 line cannot be imported here.".into());
    }
    match russh::keys::decode_secret_key(
        &private_key_pem,
        if key_passphrase.is_empty() { None } else { Some(key_passphrase.as_str()) },
    ) {
        Ok(_) => {}
        Err(_) => {
            private_key_pem.zeroize();
            return Err("Could not unlock SSH private key. Check the complete key and its passphrase (if encrypted).".into());
        }
    }
    let result = sessions.use_password(|password| {
        passh7_core::transaction(&vault_path()?, password, |vault| {
            vault.add_identity(Identity {
                alias, private_key_pem: private_key_pem.clone(),
                extensions: Default::default(),
            })?;
            Ok(true)
        }).map_err(safe_err)
    });
    private_key_pem.zeroize();
    result
}


#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GeneratedPublicKey {
    alias: String,
    public_key: String,
    fingerprint: String,
}

/// Generate on the local device. Never send the private key to the frontend.
#[tauri::command]
fn vault_generate_ed25519(alias: String, comment: String, sessions: State<'_, SessionStore>) -> Result<GeneratedPublicKey, String> {
    if alias.trim().is_empty() || alias.len() > 80 ||
       !alias.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c)) {
        return Err("Identity name must contain 1-80 letters, digits, dot, underscore or dash".into());
    }
    if comment.len() > 120 || comment.chars().any(char::is_control) {
        return Err("Invalid public key comment".into());
    }
    let key = russh::keys::PrivateKey::random(&mut rand::rng(), russh::keys::Algorithm::Ed25519)
        .map_err(|_| "Could not generate SSH key".to_owned())?;
    let private = key.to_openssh(russh::keys::ssh_key::LineEnding::LF)
        .map_err(|_| "Could not encode private SSH key".to_owned())?;
    let public_key = key.public_key().to_openssh()
        .map_err(|_| "Could not encode SSH public key".to_owned())?;
    let fingerprint = key.public_key().fingerprint(russh::keys::HashAlg::Sha256).to_string();
    // The original public key can be installed without depending on any comment.
    let public_key = if comment.is_empty() { public_key } else {
        format!("{} {}", public_key, comment)
    };
    sessions.use_password(|password| {
        passh7_core::transaction(&vault_path()?, password, |vault| {
            vault.add_identity(Identity {
                alias: alias.clone(),
                private_key_pem: private.to_string(),
                extensions: Default::default(),
            })?;
            Ok(true)
        }).map_err(safe_err)
    })?;
    Ok(GeneratedPublicKey { alias, public_key, fingerprint })
}


#[tauri::command]
fn vault_public_identity(alias: String, sessions: State<'_, SessionStore>) -> Result<GeneratedPublicKey, String> {
    sessions.use_password(|password| {
        let vault = passh7_core::load(&vault_path()?, password).map_err(safe_err)?;
        let identity = vault.identities.iter().find(|identity| identity.alias == alias)
            .ok_or("SSH identity not found")?;
        let key = russh::keys::decode_secret_key(&identity.private_key_pem, None)
            .map_err(|_| "Cannot derive public key from this identity without its passphrase".to_owned())?;
        let public_key = key.public_key().to_openssh()
            .map_err(|_| "Cannot format public SSH key".to_owned())?;
        let fingerprint = key.public_key().fingerprint(russh::keys::HashAlg::Sha256).to_string();
        Ok(GeneratedPublicKey { alias, public_key, fingerprint })
    })
}

#[tauri::command]
fn vault_remove_host(alias: String, sessions: State<'_, SessionStore>) -> Result<(), String> {
    sessions.use_password(|password| {
        passh7_core::transaction(&vault_path()?, password, |vault| {
            vault.remove_host(&alias)?;
            Ok(true)
        }).map_err(safe_err)
    })
}

#[tauri::command]
fn vault_remove_identity(alias: String, sessions: State<'_, SessionStore>) -> Result<(), String> {
    sessions.use_password(|password| {
        passh7_core::transaction(&vault_path()?, password, |vault| {
            vault.remove_identity(&alias)?;
            Ok(true)
        }).map_err(safe_err)
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BuildInfo {
    version: &'static str,
    publisher: &'static str,
    repository: &'static str,
    commit: &'static str,
    built_at: &'static str,
    run_number: &'static str,
    target: &'static str,
}

#[tauri::command]
fn app_build_info() -> BuildInfo {
    BuildInfo {
        version: env!("CARGO_PKG_VERSION"),
        publisher: "PAS7 Studio",
        repository: "pas7-studio/PaSSH7",
        commit: option_env!("PASSH7_BUILD_COMMIT").unwrap_or("local"),
        built_at: option_env!("PASSH7_BUILD_TIMESTAMP").unwrap_or("local build"),
        run_number: option_env!("PASSH7_BUILD_RUN").unwrap_or("local"),
        target: if cfg!(target_os = "windows") { "Windows x64" } else if cfg!(target_os = "linux") { "Linux" } else { "Other" },
    }
}


#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SshProbeResult {
    banner: String,
    elapsed_ms: u128,
}

/// Only probes a host already stored in the unlocked vault. This does NOT
/// authenticate the server, perform key exchange or establish an SSH session.
#[tauri::command]
async fn ssh_probe_host(alias: String, sessions: State<'_, SessionStore>) -> Result<SshProbeResult, String> {
    let host = sessions.use_password(|password| {
        let vault = passh7_core::load(&vault_path()?, password).map_err(safe_err)?;
        vault.hosts.into_iter().find(|h| h.alias == alias)
            .ok_or_else(|| "Host not found in vault".to_owned())
    })?;
    tauri::async_runtime::spawn_blocking(move || {
        let started = Instant::now();
        let timeout = Duration::from_secs(4);
        let addresses = (host.hostname.as_str(), host.port).to_socket_addrs()
            .map_err(|_| "Unable to resolve host".to_owned())?;
        let mut stream = None;
        for address in addresses.take(8) {
            if let Ok(socket) = TcpStream::connect_timeout(&address, timeout) {
                stream = Some(socket);
                break;
            }
        }
        let socket = stream.ok_or_else(|| "Unable to reach SSH port within timeout".to_owned())?;
        socket.set_read_timeout(Some(timeout)).map_err(|_| "Unable to set probe timeout".to_owned())?;
        let mut reader = BufReader::new(socket);
        // SSH servers may send a limited number of pre-banner lines per RFC 4253.
        // Read a bounded amount and reject non-SSH endpoints.
        for _ in 0..8 {
            let mut raw = Vec::new();
            let mut ended = false;
            for _ in 0..255 {
                let mut byte = [0u8; 1];
                match reader.read(&mut byte) {
                    Ok(0) => break,
                    Ok(_) => { raw.push(byte[0]); if byte[0] == b'\n' { ended = true; break; } }
                    Err(_) => return Err("No SSH identification received within timeout".to_owned()),
                }
            }
            if raw.is_empty() { return Err("SSH server closed the connection".to_owned()); }
            if !ended { return Err("Invalid or oversized SSH identification".to_owned()); }
            let line = std::str::from_utf8(&raw).map_err(|_| "Invalid UTF-8 SSH identification".to_owned())?.trim().to_owned();
            if (line.starts_with("SSH-2.0-") || line.starts_with("SSH-1.99-")) && line.len() > 8 && !line.chars().any(char::is_control) {
                return Ok(SshProbeResult { banner: line, elapsed_ms: started.elapsed().as_millis() });
            }
        }
        Err("Endpoint did not provide an SSH protocol identification".to_owned())
    }).await.map_err(|_| "SSH probe task failed".to_owned())?
}


struct PinnedSshClient {
    expected_pin: String,
}
impl russh::client::Handler for PinnedSshClient {
    type Error = russh::Error;
    async fn check_server_key(
        &mut self,
        key: &russh::keys::PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        // Certificates require a separate CA validation policy; reject for now.
        if key.certificate().is_some() { return Ok(false); }
        let actual = key.public_key().fingerprint(russh::keys::HashAlg::Sha256).to_string();
        Ok(self.expected_pin == actual)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SshAuthResult {
    username: String,
    host_alias: String,
    authenticated: bool,
}

/// Perform a real SSH handshake and public-key login, never skipping host-key
/// validation. The returned connection is disconnected immediately until
/// managed session/PTY support is implemented.
#[tauri::command]
async fn ssh_authenticate(alias: String, sessions: State<'_, SessionStore>) -> Result<SshAuthResult, String> {
    let (host, secret) = sessions.use_password(|password| {
        let vault = passh7_core::load(&vault_path()?, password).map_err(safe_err)?;
        let host = vault.hosts.iter().find(|h| h.alias == alias)
            .ok_or_else(|| "Saved host not found".to_owned())?.clone();
        let key = vault.identities.iter().find(|i| i.alias == host.identity_alias)
            .ok_or_else(|| "Host identity is missing".to_owned())?;
        Ok((host, Zeroizing::new(key.private_key_pem.clone())))
    })?;
    let pin = host.pinned_host_key.clone().ok_or("Host key is not pinned; refusing connection")?;
    passh7_core::hostkey::validate_fingerprint(&pin).map_err(safe_err)?;
    // No disk-based temporary key, and no private key returned to JavaScript.
    let private_key = russh::keys::decode_secret_key(secret.as_str(), None)
        .map_err(|_| "Unsupported or encrypted SSH private key".to_owned())?;
    let config = std::sync::Arc::new(russh::client::Config {
        inactivity_timeout: Some(Duration::from_secs(12)),
        ..Default::default()
    });
    let endpoint = (host.hostname.as_str(), host.port);
    let handler = PinnedSshClient { expected_pin: pin };
    let mut connection = tokio_timeout_connect(config, endpoint, handler).await?;
    let hash_alg = connection.best_supported_rsa_hash().await
        .map_err(|_| "SSH key algorithm negotiation failed".to_owned())?.flatten();
    let result = connection.authenticate_publickey(
        host.username.as_str(),
        russh::keys::PrivateKeyWithHashAlg::new(std::sync::Arc::new(private_key), hash_alg)
    ).await.map_err(|_| "SSH public-key authentication failed".to_owned())?;
    if !result.success() { return Err("SSH server rejected this identity".to_owned()); }
    let _ = connection.disconnect(russh::Disconnect::ByApplication, "Authentication check complete", "en").await;
    Ok(SshAuthResult { username: host.username, host_alias: host.alias, authenticated: true })
}

async fn tokio_timeout_connect<A: tokio::net::ToSocketAddrs>(
    config: std::sync::Arc<russh::client::Config>,
    endpoint: A,
    handler: PinnedSshClient,
) -> Result<russh::client::Handle<PinnedSshClient>, String> {
    tokio::time::timeout(Duration::from_secs(12), russh::client::connect(config, endpoint, handler))
        .await.map_err(|_| "SSH connection timed out".to_owned())?
        .map_err(|_| "SSH handshake or pinned host key verification failed".to_owned())
}

fn main() {
    tauri::Builder::default()
        .manage(SessionStore::default())
        .manage(SshSessionManager::default())
        .invoke_handler(tauri::generate_handler![
            vault_exists,vault_initialize,vault_unlock,vault_lock,vault_status,
            vault_list_hosts,vault_add_host,vault_remove_host,vault_save_host_credentials,vault_forget_host_credentials,vault_list_identities,vault_import_identity,vault_generate_ed25519,vault_public_identity,vault_remove_identity,app_build_info,ssh_probe_host,ssh_authenticate,
            ssh_sessions::ssh_session_open,ssh_sessions::ssh_session_write,
            ssh_sessions::ssh_session_resize,ssh_sessions::ssh_session_close,
            ssh_sessions::ssh_session_ready,ssh_sessions::ssh_session_docker_list,ssh_sessions::ssh_session_sftp_list
        ])
        .run(tauri::generate_context!())
        .expect("unable to start PaSSH7");
}
