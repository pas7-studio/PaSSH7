#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod ssh_sessions;
mod local_agent_bridge;

mod openssh_config;
use std::{io::{BufReader, Read}, net::{TcpStream, ToSocketAddrs}, path::PathBuf, sync::Mutex, time::{Duration, Instant}};
use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, Zeroizing};
use tauri::State;
use ssh_sessions::SshSessionManager;
use passh7_core::{HostProfile, HubError, Identity};

const IDLE_TIMEOUT: Duration = Duration::from_secs(15 * 60);

#[derive(Default)]
struct PendingVaultRestore(Mutex<Option<BackupCandidate>>);

struct BackupCandidate {
    token:String,
    encrypted:Vec<u8>,
    baseline:Vec<u8>,
}

#[derive(Serialize)]
#[serde(rename_all="camelCase")]
struct VaultRestorePreview {
    token:String,
    hosts:usize,
    identities:usize,
    host_aliases:Vec<String>,
    bytes:usize,
    identical_to_current:bool,
    same_contents:bool,
    difference:VaultDifference,
}

/// Changes represent the selected BACKUP relative to the active local Vault:
/// remote_only is present only in the backup; local_only only in the local Vault.
/// Never return the contents of keys, passwords, fingerprints, or extensions.
#[derive(Serialize,Default)]
#[serde(rename_all="camelCase")]
struct VaultDifference {
    backup_only_hosts:Vec<String>,
    local_only_hosts:Vec<String>,
    changed_hosts:Vec<String>,
    backup_only_identities:Vec<String>,
    local_only_identities:Vec<String>,
    changed_identities:Vec<String>,
    other_metadata_changed:bool,
}

fn compare_vault_contents(local:&passh7_core::Vault,backup:&passh7_core::Vault)->VaultDifference{
    use std::collections::BTreeMap;
    fn compare<'a,T>(
        local:impl IntoIterator<Item=(&'a str,&'a T)>,
        backup:impl IntoIterator<Item=(&'a str,&'a T)>,
        equal:impl Fn(&T,&T)->bool
    )->(Vec<String>,Vec<String>,Vec<String>) where T:'a {
        let a:BTreeMap<&str,&T>=local.into_iter().collect();
        let b:BTreeMap<&str,&T>=backup.into_iter().collect();
        let remote_only=b.keys().filter(|name|!a.contains_key(*name))
            .map(|name|(*name).to_owned()).collect();
        let local_only=a.keys().filter(|name|!b.contains_key(*name))
            .map(|name|(*name).to_owned()).collect();
        let modified=b.iter().filter_map(|(name,value)|a.get(name)
            .filter(|local_value|!equal(*local_value,value))
            .map(|_|(*name).to_owned())).collect();
        (remote_only,local_only,modified)
    }
    let (backup_only_hosts,local_only_hosts,changed_hosts)=compare(
        local.hosts.iter().map(|h|(h.alias.as_str(),h)),
        backup.hosts.iter().map(|h|(h.alias.as_str(),h)),
        |a,b| a.hostname==b.hostname && a.port==b.port &&
            a.username==b.username && a.identity_alias==b.identity_alias &&
            a.pinned_host_key==b.pinned_host_key && a.extensions==b.extensions
    );
    let (backup_only_identities,local_only_identities,changed_identities)=compare(
        local.identities.iter().map(|i|(i.alias.as_str(),i)),
        backup.identities.iter().map(|i|(i.alias.as_str(),i)),
        |a,b| a.private_key_pem==b.private_key_pem && a.extensions==b.extensions
    );
    VaultDifference{
        backup_only_hosts,local_only_hosts,changed_hosts,
        backup_only_identities,local_only_identities,changed_identities,
        other_metadata_changed:local.schema_version!=backup.schema_version ||
            local.extensions!=backup.extensions
    }
}

fn vault_difference_is_empty(diff:&VaultDifference)->bool{
    diff.backup_only_hosts.is_empty()&&diff.local_only_hosts.is_empty()&&
    diff.changed_hosts.is_empty()&&diff.backup_only_identities.is_empty()&&
    diff.local_only_identities.is_empty()&&diff.changed_identities.is_empty()&&
    !diff.other_metadata_changed
}

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
    // Only genuine local user interaction calls this command. Background SSH
    // heartbeats and agent output must NOT extend the lifetime of decrypted
    // credentials. Expired sessions are never silently reactivated.
    fn touch_if_live(&self)->Result<bool,String>{
        let mut guard=self.0.lock().map_err(|_|"Vault session unavailable")?;
        let Some(session)=guard.as_mut() else{return Ok(false)};
        if session.last_used.elapsed()>=IDLE_TIMEOUT{
            *guard=None;
            return Ok(false);
        }
        session.last_used=Instant::now();
        Ok(true)
    }
    /// Background local agents may READ the Vault's live/expired state but
    /// must never extend its idle timeout. This is enforced for every MCP
    /// remote operation, not just when the initial capability was issued.
    pub(crate) fn live_without_touch(&self)->Result<bool,String>{
        let mut guard=self.0.lock().map_err(|_|"Vault session unavailable")?;
        match guard.as_ref(){
            Some(session) if session.last_used.elapsed()<IDLE_TIMEOUT=>Ok(true),
            _=>{
                *guard=None;
                Ok(false)
            }
        }
    }
}

#[cfg(test)]
mod vault_local_activity_tests{
    use super::*;
    #[test]
    fn real_local_activity_refreshes_live_vault_ttl(){
        let store=SessionStore(Mutex::new(Some(UnlockedSession{
            password:Zeroizing::new("only-in-test".to_owned()),
            last_used:Instant::now()-Duration::from_secs(120)
        })));
        assert!(store.touch_if_live().unwrap());
        let guard=store.0.lock().unwrap();
        assert!(guard.as_ref().unwrap().last_used.elapsed()<Duration::from_secs(3));
    }
    #[test]
    fn expired_vault_cannot_be_reactivated_by_activity(){
        let store=SessionStore(Mutex::new(Some(UnlockedSession{
            password:Zeroizing::new("only-in-test".to_owned()),
            last_used:Instant::now()-IDLE_TIMEOUT-Duration::from_secs(1)
        })));
        assert!(!store.touch_if_live().unwrap());
        assert!(store.0.lock().unwrap().is_none());
        assert!(!store.touch_if_live().unwrap());
    }
    #[test]
    fn explicit_vault_lock_cannot_be_reversed_by_activity(){
        let store=SessionStore(Mutex::new(Some(UnlockedSession{
            password:Zeroizing::new("only-in-test".to_owned()),
            last_used:Instant::now()
        })));
        store.lock().unwrap();
        assert!(!store.touch_if_live().unwrap());
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
    backup_directory: Option<String>,
    jump_alias: Option<String>,
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

/// Export ciphertext only; no private key, password or decrypted JSON
/// crosses the IPC boundary. Refuse to replace existing local backups.
#[tauri::command]
async fn vault_export_encrypted_backup(
    app:tauri::AppHandle,sessions:State<'_,SessionStore>
)->Result<Option<String>,String>{
    use tauri_plugin_dialog::DialogExt;
    use std::io::Write;
    let (tx,rx)=tokio::sync::oneshot::channel();
    let stamp=std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
    app.dialog().file().set_file_name(format!("passh7-vault-{stamp}.enc.json"))
        .save_file(move|selected|{let _=tx.send(selected);});
    let chosen=rx.await.map_err(|_|"Vault backup save dialog failed")?;
    let Some(chosen)=chosen else{return Ok(None)};
    let target=chosen.into_path().map_err(|_|"Select a local filesystem path")?;
    let data=sessions.use_password(|password|{
        let path=vault_path()?;
        let meta=std::fs::metadata(&path)
            .map_err(|e|format!("Cannot inspect encrypted Vault: {e}"))?;
        if !meta.is_file() || meta.len()>16*1024*1024{
            return Err("Encrypted Vault is not a regular file below 16 MiB".into());
        }
        let data=std::fs::read(path).map_err(|e|format!("Cannot read encrypted Vault: {e}"))?;
        let _=passh7_core::decrypt(&data,password).map_err(safe_err)?;
        Ok(data)
    })?;
    let mut created=false;
    let result=(||->Result<(),String>{
        let mut file=std::fs::OpenOptions::new().create_new(true).write(true)
            .open(&target).map_err(|e|format!("Cannot create new backup file (it may already exist): {e}"))?;
        created=true;
        file.write_all(&data).map_err(|e|format!("Cannot write encrypted backup: {e}"))?;
        file.sync_all().map_err(|e|format!("Cannot sync encrypted backup: {e}"))?;
        drop(file);
        let readback=std::fs::read(&target).map_err(|e|format!("Cannot verify exported backup: {e}"))?;
        if readback!=data{return Err("Exported encrypted bytes did not match the Vault".into());}
        Ok(())
    })();
    if result.is_err() && created{let _=std::fs::remove_file(&target);}
    result?;
    Ok(Some(format!("Encrypted Vault exported and verified ({} bytes)",data.len())))
}

/// Produce a filename safe on both Windows and Unix, including reserved DOS
/// device names. Docker container names are untrusted display data, not paths.
fn docker_log_file_name(container_name:&str)->String {
    let fragment:String=container_name.chars().filter(|ch|
        ch.is_ascii_alphanumeric()||matches!(ch,'-'|'_')
    ).take(56).collect();
    let value=if fragment.is_empty() {"container"}else{fragment.as_str()};
    format!("passh7-{value}-logs.txt")
}

/// Save only the currently visible/filtered Docker log lines using the OS
/// dialog. No browser blob download or implicit overwrite is attempted.
#[tauri::command]
async fn docker_save_visible_logs(
    app:tauri::AppHandle,container_name:String,contents:String
)->Result<Option<String>,String>{
    use tauri_plugin_dialog::DialogExt;
    use std::io::Write;
    if contents.is_empty(){return Err("No visible Docker log lines to save".into());}
    if contents.len()>8*1024*1024{
        return Err("Visible Docker log export exceeds the 8 MiB safety limit".into());
    }
    let (tx,rx)=tokio::sync::oneshot::channel();
    app.dialog().file().set_file_name(docker_log_file_name(&container_name))
        .save_file(move|selected|{let _=tx.send(selected);});
    let chosen=rx.await.map_err(|_|"Docker log Save As dialog failed")?;
    let Some(chosen)=chosen else{return Ok(None)};
    let target=chosen.into_path().map_err(|_|"Choose a local filesystem path")?;
    let mut created=false;
    let result=(||->Result<(),String>{
        let mut file=std::fs::OpenOptions::new().create_new(true).write(true)
            .open(&target).map_err(|error|
                format!("Cannot create log file (existing files are not overwritten): {error}")
            )?;
        created=true;
        file.write_all(contents.as_bytes()).map_err(|error|
            format!("Could not write Docker log file: {error}")
        )?;
        file.sync_all().map_err(|error|format!("Could not sync Docker log file: {error}"))?;
        drop(file);
        let readback=std::fs::read(&target).map_err(|error|
            format!("Could not verify saved Docker logs: {error}")
        )?;
        if readback!=contents.as_bytes(){
            return Err("Saved log bytes did not match the requested export".into());
        }
        Ok(())
    })();
    if result.is_err()&&created{let _=std::fs::remove_file(&target);}
    result?;
    Ok(Some(format!("Saved {} UTF-8 bytes to {}",contents.len(),target.display())))
}

#[cfg(test)]
mod docker_log_filename_tests {
    use super::docker_log_file_name;
    #[test]
    fn never_uses_container_names_as_paths(){
        assert_eq!(docker_log_file_name("../api:prod\\\\secrets"),"passh7-apiprodsecrets-logs.txt");
        assert_eq!(docker_log_file_name("CON"),"passh7-CON-logs.txt");
        assert_eq!(docker_log_file_name(""),"passh7-container-logs.txt");
        assert_eq!(docker_log_file_name("...."),"passh7-container-logs.txt");
        assert!(docker_log_file_name(&"x".repeat(100)).len()<80);
    }
}

fn prepare_vault_restore_preview(
    bytes:Vec<u8>,sessions:&SessionStore,pending:&PendingVaultRestore
)->Result<VaultRestorePreview,String>{
    if bytes.len()>16*1024*1024{return Err("Encrypted backup exceeds 16 MiB".into());}
    let (candidate,current,host_aliases,identities,difference,same_contents)=sessions.use_password(|password|{
        let candidate=passh7_core::decrypt(&bytes,password).map_err(safe_err)?;
        let current=std::fs::read(vault_path()?)
            .map_err(|e|format!("Cannot inspect current Vault generation: {e}"))?;
        let local=passh7_core::decrypt(&current,password).map_err(safe_err)?;
        // Compare in native memory without serializing or duplicating secret
        // key/password material into additional unzeroized JSON buffers.
        let difference=compare_vault_contents(&local,&candidate);
        // Encryption uses random nonces; ciphertext differences aren't
        // necessarily content differences.
        let same_contents=vault_difference_is_empty(&difference);
        let names=candidate.hosts.iter().map(|h|h.alias.clone()).collect::<Vec<_>>();
        let key_count=candidate.identities.len();
        Ok((candidate,current,names,key_count,difference,same_contents))
    })?;
    let token=format!("restore-{}-{}",std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default().as_nanos());
    let preview=VaultRestorePreview{
        token:token.clone(),hosts:candidate.hosts.len(),identities,
        host_aliases,bytes:bytes.len(),identical_to_current:bytes==current,
        same_contents,difference,
    };
    let mut slot=pending.0.lock().map_err(|_|"Restore preview unavailable")?;
    *slot=Some(BackupCandidate{token,encrypted:bytes,baseline:current});
    Ok(preview)
}

#[cfg(test)]
mod vault_diff_tests {
    use super::*;
    use passh7_core::{Vault,HostProfile};

    fn host(alias:&str,port:u16)->HostProfile{
        HostProfile {
            alias:alias.into(),hostname:format!("{alias}.example.org"),
            port,username:"ubuntu".into(),identity_alias:String::new(),
            pinned_host_key:None,extensions:Default::default()
        }
    }
    #[test]
    fn snapshots_report_additions_deletions_and_changes_without_values(){
        let mut local=Vault::default();
        local.hosts.push(host("local",22));
        local.hosts.push(host("shared",22));
        let mut remote=Vault::default();
        remote.hosts.push(host("backup",22));
        remote.hosts.push(host("shared",2222));
        let diff=compare_vault_contents(&local,&remote);
        assert_eq!(diff.local_only_hosts,vec!["local"]);
        assert_eq!(diff.backup_only_hosts,vec!["backup"]);
        assert_eq!(diff.changed_hosts,vec!["shared"]);
        assert!(diff.changed_identities.is_empty());
        assert!(!diff.other_metadata_changed);
        // No changed hostname/port or credentials in the review response.
        let summary=serde_json::to_string(&diff).unwrap();
        assert!(!summary.contains("2222"));
        assert!(!summary.contains("example.org"));
    }
    #[test]
    fn saved_credential_changes_are_reported_without_disclosing_passwords(){
        let mut local=Vault::default();
        let mut original=host("web",22);
        original.extensions.insert("passh7_saved_auth".into(),
            serde_json::json!({"mode":"password","accountPassword":"secret-one"}));
        local.hosts.push(original);
        let mut remote=Vault::default();
        let mut updated=host("web",22);
        updated.extensions.insert("passh7_saved_auth".into(),
            serde_json::json!({"mode":"password","accountPassword":"secret-two"}));
        remote.hosts.push(updated);
        let diff=compare_vault_contents(&local,&remote);
        assert_eq!(diff.changed_hosts,vec!["web"]);
        let serialized=serde_json::to_string(&diff).unwrap();
        assert!(!serialized.contains("secret-one"));
        assert!(!serialized.contains("secret-two"));
        assert!(!vault_difference_is_empty(&diff));
    }
    #[test]
    fn equal_plaintext_vaults_have_no_metadata_diff(){
        let mut local=Vault::default();
        local.hosts.push(host("same",22));
        let mut remote=Vault::default();
        remote.hosts.push(host("same",22));
        let diff=compare_vault_contents(&local,&remote);
        assert!(diff.local_only_hosts.is_empty());
        assert!(diff.backup_only_hosts.is_empty());
        assert!(diff.changed_hosts.is_empty());
    }
}

#[tauri::command]
async fn vault_restore_inspect_remote(
    id:String,path:String,sessions:State<'_,SessionStore>,
    pending:State<'_,PendingVaultRestore>,ssh:State<'_,SshSessionManager>
)->Result<VaultRestorePreview,String>{
    {
        let mut slot=pending.0.lock().map_err(|_|"Restore preview unavailable")?;
        *slot=None;
    }
    // A live, pinned authenticated SSH connection is required. Remote bytes
    // remain in native Rust and are decrypted only to validate the preview.
    let bytes=ssh_sessions::read_vault_snapshot_for_restore(&id,&path,&ssh).await?;
    prepare_vault_restore_preview(bytes,&sessions,&pending)
}

/// User chooses a local encrypted backup; Rust validates the full
/// Argon2id/XChaCha20-Poly1305 payload using the unlocked master password.
/// JS gets only counts and a short-lived single-use token, never credentials.
#[tauri::command]
async fn vault_restore_inspect(
    app:tauri::AppHandle,sessions:State<'_,SessionStore>,
    pending:State<'_,PendingVaultRestore>
)->Result<Option<VaultRestorePreview>,String>{
    use tauri_plugin_dialog::DialogExt;
    {
        let mut slot=pending.0.lock().map_err(|_|"Restore preview unavailable")?;
        *slot=None;
    }
    let (tx,rx)=tokio::sync::oneshot::channel();
    app.dialog().file().pick_file(move |selected|{let _=tx.send(selected);});
    let chosen=rx.await.map_err(|_|"Backup file selection failed")?;
    let Some(chosen)=chosen else{return Ok(None)};
    let path=chosen.into_path().map_err(|_|"Choose a local encrypted backup file")?;
    let meta=std::fs::metadata(&path)
        .map_err(|e|format!("Cannot inspect selected encrypted backup: {e}"))?;
    if !meta.is_file() || meta.len()>16*1024*1024{
        return Err("Select an encrypted backup file no larger than 16 MiB".into());
    }
    let bytes=std::fs::read(&path).map_err(|e|format!("Cannot read selected backup: {e}"))?;
    prepare_vault_restore_preview(bytes,&sessions,&pending).map(Some)
}

/// This is a destructive, explicit whole-vault restore. The core transaction
/// creates and verifies an independent encrypted backup of the current Vault
/// before committing the replacement; concurrent generation changes abort.
#[tauri::command]
fn vault_restore_commit(
    token:String,sessions:State<'_,SessionStore>,
    pending:State<'_,PendingVaultRestore>,ssh:State<'_,SshSessionManager>
)->Result<(),String>{
    let backup=pending.0.lock().map_err(|_|"Restore state unavailable")?
        .take().ok_or("Choose and preview an encrypted backup first")?;
    if token!=backup.token {return Err("Backup confirmation expired; select the backup again".into());}
    sessions.use_password(|password|{
        let restored=passh7_core::decrypt(&backup.encrypted,password).map_err(safe_err)?;
        let path=vault_path()?;
        passh7_core::transaction(&path,password,|current|{
            // transaction() acquires the vault writer lock before this check.
            let latest=std::fs::read(&path).map_err(passh7_core::HubError::Io)?;
            if latest!=backup.baseline {
                return Err(passh7_core::HubError::InvalidInput(
                    "Vault changed since backup preview; inspect it again"));
            }
            *current=restored;
            Ok(true)
        }).map_err(safe_err)
    })?;
    ssh.stop_all(); // All sessions may reference replaced credentials.
    Ok(())
}

#[tauri::command]
fn vault_touch(sessions: State<'_, SessionStore>, ssh: State<'_, SshSessionManager>) -> Result<bool,String>{
    let active=sessions.touch_if_live()?;
    if !active{ssh.stop_all();}
    Ok(active)
}

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
            saved_auth_mode:h.extensions.get("passh7_saved_auth").and_then(|v| v.get("mode")).and_then(|v| v.as_str()).map(str::to_owned),
            backup_directory:h.extensions.get("passh7_backup_directory").and_then(|v|v.as_str()).map(str::to_owned),
            jump_alias:h.extensions.get("passh7_jump_alias").and_then(|v|v.as_str()).map(str::to_owned)
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
fn vault_set_host_identity(alias:String,identity_alias:String,sessions:State<'_,SessionStore>)
    ->Result<(),String>{
    sessions.use_password(|password|{
        passh7_core::transaction(&vault_path()?,password,|vault|{
            vault.set_host_identity(&alias,&identity_alias)?;
            Ok(true)
        }).map_err(safe_err)
    })
}
/// One-hop per-host routing. Gateway uses the same authenticated, pinned SSH
/// session already connected by the user; target uses its own independently
/// validated host-key pin and local Vault credentials over nested SSH.
fn validate_jump_host(vault:&passh7_core::Vault,alias:&str,gateway:Option<&str>)->Result<(),HubError>{
    let target=vault.hosts.iter().find(|h|h.alias==alias)
        .ok_or(HubError::InvalidInput("Target host not found"))?;
    let Some(gateway)=gateway else{return Ok(())};
    if gateway==alias{return Err(HubError::InvalidInput("A host cannot jump through itself"));}
    let hop=vault.hosts.iter().find(|h|h.alias==gateway)
        .ok_or(HubError::InvalidInput("Jump gateway must be a saved host"))?;
    if hop.pinned_host_key.is_none(){
        return Err(HubError::InvalidInput("Jump gateway SSH host key must be pinned first"));
    }
    if hop.extensions.get("passh7_jump_alias").and_then(|v|v.as_str()).is_some_and(|s|!s.is_empty()){
        return Err(HubError::InvalidInput("Only one SSH jump hop is supported; select a directly accessible gateway"));
    }
    if vault.hosts.iter().any(|other|other.extensions.get("passh7_jump_alias")
        .and_then(|v|v.as_str())==Some(alias)){
        return Err(HubError::InvalidInput(
            "This host already acts as a gateway; remove dependent routes before routing it through another gateway"));
    }
    if target.hostname.trim().is_empty(){
        return Err(HubError::InvalidInput("Private target hostname is missing"));
    }
    Ok(())
}

#[tauri::command]
fn vault_set_jump_host(alias:String,jump_alias:Option<String>,
    sessions:State<'_,SessionStore>)->Result<(),String>{
    let route=jump_alias.filter(|alias|!alias.trim().is_empty());
    sessions.use_password(|password|{
        passh7_core::transaction(&vault_path()?,password,|vault|{
            validate_jump_host(vault,&alias,route.as_deref())?;
            let target=vault.hosts.iter_mut().find(|h|h.alias==alias)
                .ok_or(HubError::InvalidInput("Target host not found"))?;
            if let Some(ref gateway)=route{
                target.extensions.insert("passh7_jump_alias".into(),
                    serde_json::Value::String(gateway.clone()));
            }else{target.extensions.remove("passh7_jump_alias");}
            Ok(true)
        }).map_err(safe_err)
    })
}

#[cfg(test)]
mod jump_route_tests{
    use super::*;
    use passh7_core::{Vault,HostProfile};
    fn host(alias:&str,pinned:bool)->HostProfile{
        HostProfile{alias:alias.into(),hostname:"192.168.1.12".into(),
            username:"ubuntu".into(),port:22,identity_alias:String::new(),
            pinned_host_key:if pinned{Some("SHA256:example".into())}else{None},
            extensions:Default::default()}
    }
    #[test]
    fn one_hop_requires_existing_pinned_direct_gateway(){
        let mut vault=Vault::default();
        vault.hosts.push(host("gateway",true));
        vault.hosts.push(host("private",false));
        assert!(validate_jump_host(&vault,"private",Some("gateway")).is_ok());
        assert!(validate_jump_host(&vault,"gateway",Some("gateway")).is_err());
        assert!(validate_jump_host(&vault,"private",Some("missing")).is_err());
        vault.hosts[0].extensions.insert("passh7_jump_alias".into(),
            serde_json::Value::String("other".into()));
        assert!(validate_jump_host(&vault,"private",Some("gateway")).is_err());
        vault.hosts[0].extensions.clear();
        vault.hosts[1].extensions.insert("passh7_jump_alias".into(),
            serde_json::Value::String("gateway".into()));
        assert!(validate_jump_host(&vault,"gateway",Some("private")).is_err());
    }
}

fn validated_backup_directory(directory:Option<String>)->Result<Option<String>,String>{
    match directory {
        Some(dir) if !dir.trim().is_empty()=>{
            if dir.len()>4096 || dir.chars().any(|c|c.is_control()){
                return Err("Remote backup directory is too long or contains control characters".into());
            }
            Ok(Some(dir.trim().to_owned()))
        },
        _=>Ok(None)
    }
}

#[cfg(test)]
mod backup_directory_tests{
    use super::validated_backup_directory;

    #[test]
    fn accepts_remote_paths_and_clears_empty_preferences(){
        assert_eq!(validated_backup_directory(Some(" /srv/backups/passh7 ".into())).unwrap(),
            Some("/srv/backups/passh7".into()));
        assert_eq!(validated_backup_directory(Some(".".into())).unwrap(),Some(".".into()));
        assert_eq!(validated_backup_directory(Some("   ".into())).unwrap(),None);
        assert_eq!(validated_backup_directory(None).unwrap(),None);
    }
    #[test]
    fn rejects_unbounded_and_control_character_paths(){
        assert!(validated_backup_directory(Some("x".repeat(4097))).is_err());
        for path in ["foo\\nbar","bad\\0path","bad\\rdir"]{
            // Convert explicit escape characters to their control bytes.
            let actual=path.replace("\\n","\n").replace("\\0","\0").replace("\\r","\r");
            assert!(validated_backup_directory(Some(actual)).is_err());
        }
    }
}
/// Save a non-secret remote backup directory per host inside the encrypted
/// Vault. This does not connect, upload, schedule, or synchronize anything.
#[tauri::command]
fn vault_set_backup_directory(alias:String,directory:Option<String>,
    sessions:State<'_,SessionStore>)->Result<(),String>{
    let normalized=validated_backup_directory(directory)?;
    sessions.use_password(|password|{
        passh7_core::transaction(&vault_path()?,password,|vault|{
            let host=vault.hosts.iter_mut().find(|h|h.alias==alias)
                .ok_or(HubError::InvalidInput("host not found"))?;
            match &normalized{
                Some(folder)=>{
                    host.extensions.insert("passh7_backup_directory".into(),
                        serde_json::Value::String(folder.clone()));
                },
                None=>{host.extensions.remove("passh7_backup_directory");}
            }
            Ok(true)
        }).map_err(safe_err)
    })
}
// Credentials remain inside the existing Argon2id/XChaCha20 encrypted vault.
// Neither this command nor host listing ever returns secret strings to the frontend.
// When an authenticated login reused saved fields, leave any unedited fields intact
// instead of silently replacing the existing password/passphrase with an empty string.
fn reuse_saved_auth_fields(auth_mode: &str, saved: Option<&serde_json::Value>, account_password: &mut String, key_passphrase: &mut String) {
    let Some(previous) = saved.filter(|v| v.get("mode").and_then(|m| m.as_str()) == Some(auth_mode)) else {
        return;
    };
    if account_password.is_empty() {
        if let Some(value) = previous.get("account_password").and_then(|v| v.as_str()) {
            *account_password = value.to_owned();
        }
    }
    if key_passphrase.is_empty() {
        if let Some(value) = previous.get("key_passphrase").and_then(|v| v.as_str()) {
            *key_passphrase = value.to_owned();
        }
    }
}

#[tauri::command]
fn vault_save_host_credentials(alias: String, auth_mode: String, mut account_password: String,
    mut key_passphrase: String, preserve_existing: bool, sessions: State<'_, SessionStore>) -> Result<(), String> {
    if !matches!(auth_mode.as_str(), "key" | "password" | "key-password") {
        account_password.zeroize();
        key_passphrase.zeroize();
        return Err("Invalid authentication mode".into());
    }
    let result = sessions.use_password(|password| {
        passh7_core::transaction(&vault_path()?,password,|vault| {
            let host = vault.hosts.iter_mut().find(|h| h.alias == alias)
                .ok_or(HubError::InvalidInput("host not found"))?;
            if preserve_existing {
                reuse_saved_auth_fields(
                    &auth_mode,
                    host.extensions.get("passh7_saved_auth"),
                    &mut account_password,
                    &mut key_passphrase,
                );
            }
            if auth_mode != "key" && account_password.is_empty() {
                return Err(HubError::InvalidInput("Account password is required to remember this authentication mode"));
            }
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

#[cfg(test)]
mod saved_auth_tests {
    use super::reuse_saved_auth_fields;

    #[test]
    fn reuses_unedited_secrets_for_same_auth_mode() {
        let previous = serde_json::json!({"mode":"key-password","account_password":"windows-secret","key_passphrase":"private-key-secret"});
        let mut password = String::new();
        let mut passphrase = String::new();
        reuse_saved_auth_fields("key-password", Some(&previous), &mut password, &mut passphrase);
        assert_eq!(password, "windows-secret");
        assert_eq!(passphrase, "private-key-secret");
    }

    #[test]
    fn manual_password_update_preserves_existing_key_passphrase() {
        let previous = serde_json::json!({"mode":"key-password","account_password":"old","key_passphrase":"key-secret"});
        let mut password = "new".to_owned();
        let mut passphrase = String::new();
        reuse_saved_auth_fields("key-password", Some(&previous), &mut password, &mut passphrase);
        assert_eq!(password, "new");
        assert_eq!(passphrase, "key-secret");
    }

    #[test]
    fn does_not_reuse_secrets_across_auth_modes() {
        let previous = serde_json::json!({"mode":"password","account_password":"old","key_passphrase":"old-key"});
        let mut password = String::new();
        let mut passphrase = String::new();
        reuse_saved_auth_fields("key-password", Some(&previous), &mut password, &mut passphrase);
        assert!(password.is_empty());
        assert!(passphrase.is_empty());
    }
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
fn vault_remove_host(alias: String, sessions: State<'_, SessionStore>, ssh: State<'_, SshSessionManager>) -> Result<(), String> {
    sessions.use_password(|password| {
        passh7_core::transaction(&vault_path()?, password, |vault| {
            if vault.hosts.iter().any(|host|host.extensions.get("passh7_jump_alias")
                .and_then(|v|v.as_str())==Some(alias.as_str())){
                return Err(HubError::InvalidInput("Gateway is used by private SSH hosts; remove those routes before deleting it"));
            }
            vault.remove_host(&alias)?;
            Ok(true)
        }).map_err(safe_err)
    })?;
    // Removing a host must also terminate any already-authenticated shells,
    // background SFTP operations and localhost forwards associated with it.
    ssh.stop_host(&alias);
    Ok(())
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


#[derive(Clone)]
struct DiscoverSshHostKey {
    observed: std::sync::Arc<Mutex<Option<String>>>,
}
impl russh::client::Handler for DiscoverSshHostKey {
    type Error = russh::Error;
    async fn check_server_key(&mut self, key: &russh::keys::PublicKeyOrCertificate)
        -> Result<bool, Self::Error> {
        // Never trust implicitly, never authenticate during discovery.
        if key.certificate().is_none() {
            let fingerprint = key.public_key().fingerprint(russh::keys::HashAlg::Sha256).to_string();
            if let Ok(mut guard) = self.observed.lock() { *guard = Some(fingerprint); }
        }
        Ok(false)
    }
}

#[derive(Serialize)]
#[serde(rename_all="camelCase")]
struct DiscoveredHostKey { fingerprint: String }

#[tauri::command]
async fn ssh_discover_host_key(alias: String, sessions: State<'_, SessionStore>) -> Result<DiscoveredHostKey, String> {
    let host = sessions.use_password(|password| {
        let vault = passh7_core::load(&vault_path()?, password).map_err(safe_err)?;
        vault.hosts.iter().find(|h| h.alias == alias).cloned()
            .ok_or_else(|| "Saved SSH host not found".to_owned())
    })?;
    if host.pinned_host_key.is_some() { return Err("This host already has a trusted fingerprint".into()); }
    let observed = std::sync::Arc::new(Mutex::new(None));
    let config = std::sync::Arc::new(russh::client::Config {
        inactivity_timeout: Some(Duration::from_secs(12)), ..Default::default()
    });
    // connect intentionally fails when check_server_key returns false;
    // server fingerprint is captured before any authentication is attempted.
    let _ = tokio::time::timeout(Duration::from_secs(12),russh::client::connect(
        config,(host.hostname.as_str(),host.port),
        DiscoverSshHostKey {observed: observed.clone()}
    )).await;
    let fingerprint = observed.lock().map_err(|_| "Host fingerprint probe failed")?
        .clone().ok_or_else(|| "Could not read SSH server host key; check host/port/network".to_owned())?;
    passh7_core::hostkey::validate_fingerprint(&fingerprint).map_err(safe_err)?;
    Ok(DiscoveredHostKey {fingerprint})
}

#[tauri::command]
async fn ssh_discover_host_key_via(alias:String,sessions:State<'_,SessionStore>,
    manager:State<'_,SshSessionManager>)->Result<DiscoveredHostKey,String>{
    let (host,gateway)=sessions.use_password(|password|{
        let vault=passh7_core::load(&vault_path()?,password).map_err(safe_err)?;
        let host=vault.hosts.iter().find(|h|h.alias==alias)
            .ok_or("Private target host not found")?.clone();
        if host.pinned_host_key.is_some(){return Err("Target already has a pinned host key".into());}
        let gateway=host.extensions.get("passh7_jump_alias")
            .and_then(|v|v.as_str()).ok_or("Configure a jump gateway first")?.to_owned();
        validate_jump_host(&vault,&alias,Some(&gateway)).map_err(safe_err)?;
        Ok((host,gateway))
    })?;
    let stream=manager.jump_stream(&gateway,&host.hostname,host.port).await?;
    let observed=std::sync::Arc::new(Mutex::new(None));
    let config=std::sync::Arc::new(russh::client::Config{
        nodelay:true,inactivity_timeout:Some(Duration::from_secs(12)),
        ..Default::default()
    });
    // The discovery handler records the target's key and *rejects* login.
    // Never assume the gateway's own key authenticates the internal target.
    let _=tokio::time::timeout(Duration::from_secs(15),
        russh::client::connect_stream(config,stream,
            DiscoverSshHostKey{observed:observed.clone()})
    ).await;
    let fingerprint=observed.lock().map_err(|_|"SSH target fingerprint unavailable")?
        .clone().ok_or("Could not observe target SSH host key through the gateway")?;
    passh7_core::hostkey::validate_fingerprint(&fingerprint).map_err(safe_err)?;
    Ok(DiscoveredHostKey{fingerprint})
}

#[tauri::command]
fn vault_pin_host_key(alias: String, fingerprint: String, sessions: State<'_, SessionStore>) -> Result<(), String> {
    sessions.use_password(|password| {
        passh7_core::transaction(&vault_path()?,password,|vault| {
            if vault.hosts.iter().find(|h| h.alias == alias)
                .and_then(|h| h.pinned_host_key.as_ref()).is_some() {
                return Err(HubError::InvalidInput("host key already pinned; replace requires a separate verified workflow"));
            }
            vault.pin_host_key(&alias,&fingerprint)?;
            Ok(true)
        }).map_err(safe_err)
    })
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
    // An MCP stdio child must not initialize a second desktop/WebView instance.
    if std::env::args().nth(1).as_deref()==Some("--passh7-mcp"){
        local_agent_bridge::run_stdio_mcp();
        return;
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(SessionStore::default())
        .manage(PendingVaultRestore::default())
        .manage(SshSessionManager::default())
        .manage(local_agent_bridge::LocalAgentBridge::default())
        .invoke_handler(tauri::generate_handler![
            vault_exists,vault_initialize,vault_unlock,vault_lock,vault_status,vault_touch,vault_export_encrypted_backup,vault_restore_inspect,vault_restore_inspect_remote,vault_restore_commit,docker_save_visible_logs,openssh_config::ssh_discover_local_config_hosts,
            vault_list_hosts,vault_add_host,vault_set_host_identity,vault_set_jump_host,vault_set_backup_directory,vault_remove_host,vault_save_host_credentials,vault_forget_host_credentials,vault_list_identities,vault_import_identity,vault_generate_ed25519,vault_public_identity,vault_remove_identity,app_build_info,ssh_probe_host,ssh_authenticate,ssh_discover_host_key,ssh_discover_host_key_via,vault_pin_host_key,
            ssh_sessions::ssh_session_open,ssh_sessions::ssh_session_list,ssh_sessions::ssh_session_write,
            ssh_sessions::ssh_session_resize,ssh_sessions::ssh_session_close,
            ssh_sessions::ssh_session_ready,ssh_sessions::ssh_session_vault_backup,ssh_sessions::ssh_session_vault_backup_batch,ssh_sessions::ssh_session_docker_list,ssh_sessions::ssh_session_docker_catalog,ssh_sessions::ssh_session_docker_inspect,ssh_sessions::ssh_session_docker_logs,ssh_sessions::ssh_session_docker_log_start,ssh_sessions::ssh_session_docker_log_stop,ssh_sessions::ssh_session_docker_action,ssh_sessions::ssh_session_agent_probe,ssh_sessions::ssh_session_exec,local_agent_bridge::local_agent_probe,local_agent_bridge::local_agent_launch,ssh_sessions::ssh_session_sftp_list,ssh_sessions::ssh_session_sftp_mutate,ssh_sessions::ssh_session_sftp_read_text,ssh_sessions::ssh_session_sftp_read_image,ssh_sessions::ssh_session_sftp_download,ssh_sessions::ssh_session_sftp_upload,ssh_sessions::ssh_session_sftp_cancel,ssh_sessions::ssh_session_forward_start,ssh_sessions::ssh_session_forward_stop,ssh_sessions::ssh_session_forward_list
        ])
        .run(tauri::generate_context!())
        .expect("unable to start PaSSH7");
}
