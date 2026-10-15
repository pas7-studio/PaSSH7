#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use std::{io::{BufRead, BufReader}, net::{TcpStream, ToSocketAddrs}, path::PathBuf, sync::Mutex, time::{Duration, Instant}};
use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, Zeroizing};
use tauri::State;
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
        _ => "Vault operation failed".into(),
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
fn vault_lock(sessions: State<'_, SessionStore>) -> Result<(), String> { sessions.lock() }

#[tauri::command]
fn vault_status(sessions: State<'_, SessionStore>) -> Result<bool, String> {
    let mut guard = sessions.0.lock().map_err(|_| "Vault session unavailable")?;
    if guard.as_ref().is_some_and(|s| s.last_used.elapsed() >= IDLE_TIMEOUT) { *guard = None; }
    Ok(guard.is_some())
}
#[tauri::command]
fn vault_list_hosts(sessions: State<'_, SessionStore>) -> Result<Vec<HostSummary>, String> {
    sessions.use_password(|password| {
        let vault = passh7_core::load(&vault_path()?, password).map_err(safe_err)?;
        Ok(vault.hosts.into_iter().map(|h| HostSummary {
            alias:h.alias,hostname:h.hostname,port:h.port,username:h.username,
            identity_alias:h.identity_alias,host_key_pinned:h.pinned_host_key.is_some()
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
fn vault_import_identity(alias: String, mut private_key_pem: String,
    sessions: State<'_, SessionStore>) -> Result<(), String> {
    if private_key_pem.len() > 128 * 1024 {
        private_key_pem.zeroize();
        return Err("SSH identity exceeds 128 KiB".into());
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
            let count = reader.read_until(b'\n', &mut raw)
                .map_err(|_| "No SSH identification received within timeout".to_owned())?;
            if count == 0 { return Err("SSH server closed the connection".to_owned()); }
            if raw.len() > 255 || raw.last() != Some(&b'\n') {
                return Err("Invalid or oversized SSH identification".to_owned());
            }
            let line = std::str::from_utf8(&raw).map_err(|_| "Invalid UTF-8 SSH identification".to_owned())?.trim().to_owned();
            if (line.starts_with("SSH-2.0-") || line.starts_with("SSH-1.99-")) && line.len() > 8 && !line.chars().any(char::is_control) {
                return Ok(SshProbeResult { banner: line, elapsed_ms: started.elapsed().as_millis() });
            }
        }
        Err("Endpoint did not provide an SSH protocol identification".to_owned())
    }).await.map_err(|_| "SSH probe task failed".to_owned())?
}

fn main() {
    tauri::Builder::default()
        .manage(SessionStore::default())
        .invoke_handler(tauri::generate_handler![
            vault_exists,vault_initialize,vault_unlock,vault_lock,vault_status,
            vault_list_hosts,vault_add_host,vault_remove_host,vault_list_identities,vault_import_identity,vault_remove_identity,app_build_info,ssh_probe_host
        ])
        .run(tauri::generate_context!())
        .expect("unable to start PaSSH7");
}
