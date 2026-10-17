use std::{collections::HashMap, path::PathBuf, sync::{atomic::{AtomicU64, Ordering}, Arc, Mutex}, time::Duration};
use serde::{Deserialize,Serialize};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::mpsc;
use base64::{engine::general_purpose::STANDARD, Engine as _};

use crate::{SessionStore, PinnedSshClient, safe_err, vault_path, tokio_timeout_connect};

static NEXT_ID: AtomicU64 = AtomicU64::new(1);
const EVENT: &str = "passh7:ssh-session";
const MAX_TRANSFER: u64 = 64 * 1024 * 1024;
const SFTP_EVENT: &str = "passh7:sftp-transfer";

#[derive(Default, Clone)]
pub struct SshSessionManager {
    channels: Arc<Mutex<HashMap<String, ManagedSession>>>,
    generation: Arc<AtomicU64>,
}

struct ManagedSession {
    alias: String,
    sender: mpsc::Sender<SessionCommand>,
    input_sender: mpsc::Sender<Vec<u8>>,
    cancel: tokio::sync::watch::Sender<bool>,
}

enum SessionCommand {
    Ready,
    Resize(u32, u32),
    Close,
    DockerList(tokio::sync::oneshot::Sender<Result<String,String>>),
    DockerCatalog(String,tokio::sync::oneshot::Sender<Result<String,String>>),
    DockerInspect(String,tokio::sync::oneshot::Sender<Result<String,String>>),
    DockerLogs(String,u32,tokio::sync::oneshot::Sender<Result<String,String>>),
    DockerLogStart(String,u32,String,tokio::sync::oneshot::Sender<Result<String,String>>),
    DockerLogStop(String,tokio::sync::oneshot::Sender<Result<(),String>>),
    DockerLogFinished(String),
    DockerAction(String,String,tokio::sync::oneshot::Sender<Result<String,String>>),
    AgentProbe(String,tokio::sync::oneshot::Sender<Result<AgentAvailability,String>>),
    SftpList(String, tokio::sync::oneshot::Sender<Result<Vec<SftpEntry>,String>>),
    SftpRead(String, tokio::sync::oneshot::Sender<Result<String,String>>),
    SftpMutate(String,String,String,Option<String>,bool,tokio::sync::oneshot::Sender<Result<(),String>>),
    SftpDownload(String, String, PathBuf, tokio::sync::oneshot::Sender<Result<u64,String>>),
    SftpUpload(String, String, PathBuf, tokio::sync::oneshot::Sender<Result<u64,String>>),
    SftpCancel(String, tokio::sync::oneshot::Sender<Result<(),String>>),
    SftpFinished(String),
    VaultBackup(String,Vec<u8>,tokio::sync::oneshot::Sender<Result<VaultBackupResult,String>>),
    VaultRead(String,tokio::sync::oneshot::Sender<Result<Vec<u8>,String>>),
    ForwardStart(u16,String,u16,tokio::sync::oneshot::Sender<Result<(),String>>),
    ForwardStop(u16,tokio::sync::oneshot::Sender<Result<(),String>>),
    ForwardList(tokio::sync::oneshot::Sender<Vec<ActiveLocalForward>>),
    ForwardOpen(tokio::net::TcpStream,String,u16),
    JumpOpen(String,u16,tokio::sync::oneshot::Sender<Result<russh::ChannelStream<russh::client::Msg>,String>>),
}

#[derive(Clone, Serialize)]
#[serde(rename_all="camelCase")]
pub struct SftpEntry { pub name: String, pub is_dir: bool, pub size_bytes: Option<u64>, pub modified_at: Option<u64>, pub unix_permissions: Option<u32>, pub owner_id: Option<u32>, pub group_id: Option<u32> }
#[derive(Clone,Serialize)]
#[serde(rename_all="camelCase")]
pub struct DockerLogStreamEvent{
    pub session_id:String,
    pub stream_id:String,
    pub container_id:String,
    pub kind:&'static str,
    pub data:Option<String>,
    pub detail:Option<String>,
}

const DOCKER_LOG_EVENT:&str="passh7:docker-log";


#[derive(Clone,Serialize)]
#[serde(rename_all="camelCase")]
pub struct VaultBackupResult { pub remote_path: String, pub bytes: usize, pub verified: bool }

#[derive(Clone,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct VaultBatchTarget {
    pub id:String,
    pub alias:String,
    pub directory:String,
}

#[derive(Clone,Serialize)]
#[serde(rename_all="camelCase")]
pub struct VaultBatchOutcome {
    pub alias:String,
    pub remote_path:Option<String>,
    pub error:Option<String>,
}

#[derive(Clone,Serialize)]
#[serde(rename_all="camelCase")]
pub struct VaultBatchProgress {
    pub alias:String,
    pub index:usize,
    pub total:usize,
    pub stage:&'static str,
}

fn validate_vault_batch_targets(targets:&[VaultBatchTarget])->Result<(),String>{
    if targets.is_empty()||targets.len()>32{
        return Err("Select 1–32 connected SSH backup destinations".into());
    }
    let mut visited=std::collections::HashSet::new();
    for target in targets{
        if target.alias.trim().is_empty()||target.alias.len()>128 ||
            target.alias.chars().any(|c|c.is_control()) ||
            !valid_sftp_path(&target.directory) ||
            target.directory.chars().any(|c|c.is_control()) {
            return Err("Invalid Vault backup destination or host label".into());
        }
        if !visited.insert(target.id.as_str()){
            return Err("Duplicate SSH session in the Vault backup batch".into());
        }
    }
    Ok(())
}

fn snapshot_remote_name()->String{
    let secs=std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
    format!("passh7-vault-{secs}-{}.enc.json",NEXT_ID.fetch_add(1,Ordering::Relaxed))
}

#[derive(Clone, Serialize)]
#[serde(rename_all="camelCase")]
pub struct ActiveLocalForward {
    pub local_port:u16,
    pub target_host:String,
    pub remote_port:u16,
}

#[derive(Clone,Serialize)]
#[serde(rename_all="camelCase")]
pub struct AgentAvailability {
    pub installed:bool,
    pub version:Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all="camelCase")]
pub struct SftpTransferEvent {
    pub session_id: String,
    pub transfer_id: String,
    pub direction: &'static str,
    pub stage: &'static str,
    pub bytes: u64,
    pub total_bytes: Option<u64>,
}

fn send_sftp_progress(app:&AppHandle,session_id:&str,transfer_id:&str,
    direction:&'static str,stage:&'static str,bytes:u64,total_bytes:Option<u64>) {
    let _=app.emit(SFTP_EVENT,SftpTransferEvent{
        session_id:session_id.to_owned(),
        transfer_id:transfer_id.to_owned(),direction,stage,bytes,total_bytes
    });
}

/// Stream binary bytes with bounded memory and throttled IPC progress events.
/// The task's outer select handles user cancellation, vault lock and timeout.
async fn copy_sftp_progress<R,W>(reader:&mut R,writer:&mut W,app:&AppHandle,
    session_id:&str,transfer_id:&str,direction:&'static str,total_bytes:Option<u64>)
    -> Result<u64,String>
where R:tokio::io::AsyncRead+Unpin,W:tokio::io::AsyncWrite+Unpin
{
    use tokio::io::{AsyncReadExt,AsyncWriteExt};
    let mut chunk=[0u8;64*1024];
    let mut total=0u64;
    let mut last_report=0u64;
    loop{
        let n=reader.read(&mut chunk).await.map_err(|e|format!("SFTP read failed: {e}"))?;
        if n==0{break;}
        if total.saturating_add(n as u64)>MAX_TRANSFER{
            return Err("Transfer exceeds 64 MiB file size limit".into());
        }
        writer.write_all(&chunk[..n]).await.map_err(|e|format!("SFTP write failed: {e}"))?;
        total+=n as u64;
        if total-last_report>=256*1024{
            send_sftp_progress(app,session_id,transfer_id,direction,"progress",total,total_bytes);
            last_report=total;
        }
    }
    send_sftp_progress(app,session_id,transfer_id,direction,"progress",total,total_bytes);
    Ok(total)
}

/// Atomic no-overwrite publication. A check-then-rename is unsafe because an
/// unrelated application may create the destination after the initial check.
/// Hard-link creation fails if the destination already exists.
async fn publish_download_exclusive(staging:&std::path::Path,destination:&std::path::Path)->Result<(),String>{
    tokio::fs::hard_link(staging,destination).await
        .map_err(|e|format!("Cannot publish download without overwriting destination: {e}"))?;
    let _=tokio::fs::remove_file(staging).await;
    Ok(())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionEvent {
    pub id: String,
    pub kind: &'static str,
    pub data: Option<String>,
    pub detail: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedSession { pub id: String, pub alias: String }

impl SshSessionManager {
    pub fn stop_all(&self) {
        if let Ok(mut guard) = self.channels.lock() {
            self.generation.fetch_add(1, Ordering::SeqCst);
            for (_, session) in guard.drain() {
                let _ = session.cancel.send(true);
            }
        }
    }

    fn sender(&self, id: &str) -> Result<mpsc::Sender<SessionCommand>, String> {
        self.channels.lock().map_err(|_| "Session manager unavailable".to_owned())?
            .get(id).map(|session| session.sender.clone()).ok_or_else(|| "SSH session no longer exists".to_owned())
    }

    // PTY keystrokes have their own bounded mailbox. File, Docker and
    // inspection commands must not queue ahead of a user's typing.
    fn input_sender(&self,id:&str)->Result<mpsc::Sender<Vec<u8>>,String>{
        self.channels.lock().map_err(|_|"Session manager unavailable".to_owned())?
            .get(id).map(|session|session.input_sender.clone())
            .ok_or_else(||"SSH session no longer exists".to_owned())
    }

    /// Jump traffic runs only over an already authenticated, pinned gateway
    /// session; the local machine never contacts the target's private address.
    pub async fn jump_stream(&self,gateway_alias:&str,target:&str,port:u16)
        ->Result<russh::ChannelStream<russh::client::Msg>,String>{
        if target.trim().is_empty()||target.len()>253||port==0||
            target.chars().any(|c|c.is_whitespace()||c.is_control()){
            return Err("Invalid private SSH target hostname or port".into());
        }
        let sender={
            let sessions=self.channels.lock().map_err(|_|"SSH session manager unavailable".to_owned())?;
            sessions.iter().find(|(_,session)|session.alias==gateway_alias)
                .map(|(_,session)|session.sender.clone())
                .ok_or_else(||format!("Jump gateway {gateway_alias} is not connected. Connect it first."))?
        };
        let (tx,rx)=tokio::sync::oneshot::channel();
        sender.send(SessionCommand::JumpOpen(target.to_owned(),port,tx)).await
            .map_err(|_|"Gateway SSH session closed before tunnel setup")?;
        tokio::time::timeout(Duration::from_secs(15),rx).await
            .map_err(|_|"Gateway could not open private SSH tunnel within 15 seconds".to_owned())?
            .map_err(|_|"Gateway SSH tunnel setup interrupted".to_owned())?
    }

    pub fn active_sessions(&self) -> Result<Vec<OpenedSession>, String> {
        let guard = self.channels.lock().map_err(|_| "Session manager unavailable".to_owned())?;
        let mut sessions: Vec<OpenedSession> = guard.iter().map(|(id, session)| OpenedSession {
            id: id.clone(), alias: session.alias.clone()
        }).collect();
        sessions.sort_by(|a,b| a.id.cmp(&b.id));
        Ok(sessions)
    }

    pub fn stop_host(&self, alias: &str) {
        if let Ok(mut guard) = self.channels.lock() {
            // Revoke in-flight SSH handshakes started before host removal.
            // The generation is global, so other concurrent opens must retry.
            self.generation.fetch_add(1, Ordering::SeqCst);
            guard.retain(|_, session| {
                if session.alias == alias {
                    let _ = session.cancel.send(true);
                    false
                } else { true }
            });
        }
    }
}

#[tauri::command]
pub async fn ssh_session_open(alias: String, cols: u32, rows: u32, account_password: Option<String>, auth_mode: Option<String>, key_passphrase: Option<String>, use_saved_credentials: Option<bool>,
    vault: State<'_, SessionStore>, manager: State<'_, SshSessionManager>, app: AppHandle
) -> Result<OpenedSession, String> {
    if !(20..=500).contains(&cols) || !(5..=200).contains(&rows) {
        return Err("Invalid PTY dimensions".into());
    }
    let mut account_password = account_password.map(zeroize::Zeroizing::new);
    let mut key_passphrase = zeroize::Zeroizing::new(key_passphrase.unwrap_or_default());
    let auth_mode = auth_mode.as_deref().unwrap_or("key");
    if !matches!(auth_mode, "key" | "password" | "key-password") {
        return Err("Unsupported SSH authentication mode".into());
    }
    let generation = manager.generation.load(Ordering::SeqCst);
    let (host, secret, saved_account, saved_key_passphrase) = vault.use_password(|password| {
        let data = passh7_core::load(&vault_path()?, password).map_err(safe_err)?;
        let host = data.hosts.iter().find(|h| h.alias == alias)
            .ok_or_else(|| "Host not found".to_owned())?.clone();
        let jump=host.extensions.get("passh7_jump_alias")
            .and_then(|v|v.as_str()).filter(|s|!s.is_empty());
        crate::validate_jump_host(&data,&alias,jump).map_err(safe_err)?;
        let identity = if auth_mode == "password" {
            None
        } else {
            Some(data.identities.iter().find(|i| i.alias == host.identity_alias)
                .ok_or_else(|| "SSH identity missing: configure a vault key for this host before using key authentication".to_owned())?)
        };
        let saved = if use_saved_credentials.unwrap_or(false) {
            host.extensions.get("passh7_saved_auth").filter(|v| v.get("mode").and_then(|m| m.as_str()) == Some(auth_mode))
        } else { None };
        let saved_account = zeroize::Zeroizing::new(saved.and_then(|v| v.get("account_password")).and_then(|v| v.as_str()).unwrap_or_default().to_owned());
        let saved_key = zeroize::Zeroizing::new(saved.and_then(|v| v.get("key_passphrase")).and_then(|v| v.as_str()).unwrap_or_default().to_owned());
        Ok((host, identity.map(|key|zeroize::Zeroizing::new(key.private_key_pem.clone())), saved_account, saved_key))
    })?;
    if account_password.as_ref().map(|v| v.is_empty()).unwrap_or(true) && !saved_account.is_empty() {
        account_password = Some(saved_account);
    }
    if key_passphrase.is_empty() && !saved_key_passphrase.is_empty() {
        key_passphrase = saved_key_passphrase;
    }
    let pin = host.pinned_host_key.clone().ok_or("Host key is not pinned")?;
    passh7_core::hostkey::validate_fingerprint(&pin).map_err(safe_err)?;
    let key = if auth_mode != "password" {
        Some(russh::keys::decode_secret_key(secret.as_ref().ok_or("SSH identity missing for key authentication")?, if key_passphrase.is_empty() { None } else { Some(key_passphrase.as_str()) })
            .map_err(|_| "Cannot unlock SSH private key. Enter its key passphrase, or verify the imported key.".to_owned())?)
    } else { None };
    let config = std::sync::Arc::new(russh::client::Config {
        // Critical for interactive SSH: the default Nagle algorithm may
        // delay single-keystroke packets until remote acknowledgements arrive.
        nodelay: true,
        inactivity_timeout: Some(Duration::from_secs(600)), ..Default::default()
    });
    let jump_alias=host.extensions.get("passh7_jump_alias")
        .and_then(|v|v.as_str()).filter(|s|!s.is_empty());
    let mut connection=if let Some(gateway)=jump_alias {
        let stream=manager.jump_stream(gateway,&host.hostname,host.port).await?;
        tokio::time::timeout(Duration::from_secs(15),russh::client::connect_stream(
            config,stream,PinnedSshClient{expected_pin:pin}
        )).await.map_err(|_|"Nested SSH handshake over jump gateway timed out".to_owned())?
            .map_err(|_|"Target SSH handshake or pinned host key validation failed through gateway".to_owned())?
    }else{
        tokio_timeout_connect(config,(host.hostname.as_str(),host.port),
            PinnedSshClient{expected_pin:pin}).await?
    };

    if auth_mode == "password" {
        let mut password = account_password.take().filter(|p| !p.is_empty())
            .ok_or("Password is required for password-only bootstrap")?;
        let result = connection.authenticate_password(&host.username, password.to_string()).await
            .map_err(|_| "SSH password authentication failed".to_owned())?;
        zeroize::Zeroize::zeroize(&mut *password);
        if !result.success() { return Err("Server rejected the account password".into()); }
    } else {
        let hash = connection.best_supported_rsa_hash().await
            .map_err(|_| "SSH key negotiation failed".to_owned())?.flatten();
        let key = key.ok_or("SSH private key unavailable")?;
        let auth = connection.authenticate_publickey(&host.username,
            russh::keys::PrivateKeyWithHashAlg::new(std::sync::Arc::new(key), hash))
            .await.map_err(|_| "SSH authentication failed".to_owned())?;
        match auth {
            russh::client::AuthResult::Success => {}
            russh::client::AuthResult::Failure { partial_success: true, .. } if auth_mode == "key-password" => {
                let mut password = account_password.take().filter(|p| !p.is_empty())
                    .ok_or("Server requires an account password after accepting the key")?;
                let result = connection.authenticate_password(&host.username, password.to_string()).await
                    .map_err(|_| "SSH account password authentication failed".to_owned())?;
                zeroize::Zeroize::zeroize(&mut *password);
                if !result.success() { return Err("SSH account password rejected".into()); }
            }
            russh::client::AuthResult::Failure { partial_success: true, .. } =>
                return Err("Server accepted key but requires another factor. Select Key + password".into()),
            russh::client::AuthResult::Failure { .. } =>
                return Err("SSH server rejected this public key".into()),
        }
    }

    let mut channel = connection.channel_open_session().await
        .map_err(|_| "Cannot open SSH channel".to_owned())?;
    channel.request_pty(true, "xterm-256color", cols, rows, 0, 0, &[])
        .await.map_err(|_| "SSH server denied PTY".to_owned())?;
    channel.request_shell(true).await.map_err(|_| "SSH server denied shell".to_owned())?;
    let id = format!("ssh-{}", NEXT_ID.fetch_add(1, Ordering::Relaxed));
    let (tx, mut rx) = mpsc::channel::<SessionCommand>(128);
    let (input_tx, mut input_rx) = mpsc::channel::<Vec<u8>>(512);
    let forward_sender = tx.clone();
    let (cancel_tx, mut cancelled) = tokio::sync::watch::channel(false);
    {
        let mut sessions = manager.channels.lock().map_err(|_| "Session manager unavailable".to_owned())?;
        if manager.generation.load(Ordering::SeqCst) != generation {
            return Err("Vault was locked during SSH connection".into());
        }
        sessions.insert(id.clone(), ManagedSession { alias: alias.clone(), sender: tx, input_sender: input_tx, cancel: cancel_tx });
    }
    let cleanup_id = id.clone();
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn(async move {
        let mut ready = false;
        let mut backlog: Vec<Vec<u8>> = Vec::new();
        let mut buffered = 0usize;
        let mut overflowed = false;
        let mut closure_detail: Option<String> = None;
        let mut forwarders: HashMap<u16,(tokio::sync::oneshot::Sender<()>,String,u16)> = HashMap::new();
        let mut transfers: HashMap<String,tokio::sync::watch::Sender<bool>> = HashMap::new();
        let mut docker_log_streams: HashMap<String,tokio::sync::watch::Sender<bool>>=HashMap::new();
        loop {
            tokio::select! {
                biased;
                changed = cancelled.changed() => {
                    if changed.is_err() || *cancelled.borrow() {
                        closure_detail = Some("SSH session terminated: vault locked or host removed".into());
                        break;
                    }
                }
                input = input_rx.recv() => {
                    match input {
                        Some(bytes) => {
                            if channel.data_bytes(bytes).await.is_err() {
                                closure_detail=Some("SSH connection failed while sending terminal input".into());
                                break;
                            }
                        },
                        None => {
                            closure_detail=Some("SSH terminal input channel closed".into());
                            break;
                        }
                    }
                }
                command = rx.recv() => {
                    let result = match command {
                        Some(SessionCommand::Ready) => {
                            ready = true;
                            for chunk in backlog.drain(..) {
                                let _ = app.emit(EVENT, SessionEvent { id: cleanup_id.clone(), kind: "data", data: Some(STANDARD.encode(chunk)), detail: None });
                            }
                            if overflowed {
                                let _ = app.emit(EVENT, SessionEvent { id: cleanup_id.clone(), kind: "data", data: Some(STANDARD.encode(b"\r\n[PaSSH7: early terminal output truncated]\r\n")), detail: None });
                            }
                            Ok(())
                        },
                        Some(SessionCommand::Resize(c, r)) => channel.window_change(c, r, 0, 0).await,
                        Some(SessionCommand::SftpCancel(transfer_id,response)) => {
                            let result=if let Some(cancel)=transfers.get(&transfer_id){
                                let _=cancel.send(true);
                                Ok(())
                            } else {
                                Err("Transfer is no longer active".to_owned())
                            };
                            let _=response.send(result);
                            Ok(())
                        },
                        Some(SessionCommand::SftpFinished(transfer_id)) => {
                            transfers.remove(&transfer_id);
                            Ok(())
                        },
                        Some(SessionCommand::DockerList(response)) => {
                            let setup=tokio::time::timeout(Duration::from_secs(10),async {
                                let mut channel=connection.channel_open_session().await
                                    .map_err(|_|"Could not open Docker listing channel".to_owned())?;
                                channel.exec(true,b"docker ps -a --format \"{{json .}}\"").await
                                    .map_err(|_|"SSH server refused Docker inventory command".to_owned())?;
                                Ok::<_,String>(channel)
                            }).await.unwrap_or_else(|_|Err("Docker SSH channel setup timed out".into()));
                            match setup {
                                Err(error)=>{let _=response.send(Err(error));},
                                Ok(mut channel)=>{
                                    tauri::async_runtime::spawn(async move {
                                        let result=tokio::time::timeout(Duration::from_secs(20),async {
                                            let mut output=Vec::new();
                                            let mut exit_status=None;
                                            while let Some(message)=channel.wait().await {
                                                match message {
                                                    russh::ChannelMsg::Data{data} | russh::ChannelMsg::ExtendedData{data,..}=>{
                                                        if output.len().saturating_add(data.len())>2*1024*1024{
                                                            return Err("Docker inventory exceeds 2 MiB".to_owned());
                                                        }
                                                        output.extend_from_slice(&data);
                                                    },
                                                    russh::ChannelMsg::ExitStatus{exit_status:code}=>exit_status=Some(code),
                                                    russh::ChannelMsg::Close=>break,
                                                    _=>{}
                                                }
                                            }
                                            let message=String::from_utf8_lossy(&output).into_owned();
                                            if exit_status.unwrap_or(1)!=0{
                                                return Err(format!("Docker inventory failed: {}",message.chars().take(500).collect::<String>()));
                                            }
                                            Ok::<String,String>(message)
                                        }).await.unwrap_or_else(|_|Err("Docker inventory timed out after 20 seconds".into()));
                                        let _=response.send(result);
                                    });
                                }
                            }
                            Ok(())
                        },
                        Some(SessionCommand::DockerCatalog(kind,response)) => {
                            let command=match docker_catalog_command(&kind){Some(command)=>command,None=>{let _=response.send(Err("Unsupported Docker catalog category".into()));continue}};
                            let setup=tokio::time::timeout(Duration::from_secs(10),async {
                                let mut channel=connection.channel_open_session().await
                                    .map_err(|_|"Could not open Docker catalog channel".to_owned())?;
                                channel.exec(true,command.as_bytes()).await
                                    .map_err(|_|"SSH server refused Docker catalog command".to_owned())?;
                                Ok::<_,String>(channel)
                            }).await.unwrap_or_else(|_|Err("Docker catalog SSH channel setup timed out".into()));
                            match setup {
                                Err(error)=>{let _=response.send(Err(error));},
                                Ok(mut channel)=>{
                                    tauri::async_runtime::spawn(async move {
                                        let result=tokio::time::timeout(Duration::from_secs(20),async {
                                            let mut output=Vec::new();
                                            let mut exit_status=None;
                                            while let Some(message)=channel.wait().await {
                                                match message {
                                                    russh::ChannelMsg::Data{data} | russh::ChannelMsg::ExtendedData{data,..}=>{
                                                        if output.len().saturating_add(data.len())>2*1024*1024{
                                                            return Err("Docker catalog exceeds 2 MiB".to_owned());
                                                        }
                                                        output.extend_from_slice(&data);
                                                    },
                                                    russh::ChannelMsg::ExitStatus{exit_status:code}=>exit_status=Some(code),
                                                    russh::ChannelMsg::Close=>break,
                                                    _=>{}
                                                }
                                            }
                                            let message=String::from_utf8_lossy(&output).into_owned();
                                            if exit_status.is_some_and(|code|code!=0){
                                                return Err(format!("Docker catalog failed: {}",message.chars().take(500).collect::<String>()));
                                            }
                                            Ok::<String,String>(message)
                                        }).await.unwrap_or_else(|_|Err("Docker catalog timed out after 20 seconds".into()));
                                        let _=response.send(result);
                                    });
                                }
                            }
                            Ok(())
                        },
                        Some(SessionCommand::DockerLogStart(container_id,tail,stream_id,response)) => {
                            if docker_log_streams.len()>=2{
                                let _=response.send(Err("Close an existing live log viewer on this SSH session before starting another".into()));
                                continue;
                            }
                            // Establish a dedicated exec channel. The regular PTY remains
                            // responsive; no Docker log bytes are stored in native memory.
                            let setup=tokio::time::timeout(Duration::from_secs(10),async {
                                let mut log_channel=connection.channel_open_session().await
                                    .map_err(|e|format!("Cannot open Docker live log channel: {e}"))?;
                                let cmd=format!("docker logs --follow --tail {tail} --timestamps {container_id}");
                                log_channel.exec(true,cmd.as_bytes()).await
                                    .map_err(|e|format!("SSH server rejected Docker live logs: {e}"))?;
                                Ok::<_,String>(log_channel)
                            }).await.unwrap_or_else(|_|Err("Docker live log channel setup timed out".into()));
                            match setup {
                                Err(error)=>{let _=response.send(Err(error));},
                                Ok(mut log_channel)=>{
                                    let (stop_tx,mut stop_rx)=tokio::sync::watch::channel(false);
                                    docker_log_streams.insert(stream_id.clone(),stop_tx);
                                    let app=app.clone();
                                    let session_id=cleanup_id.clone();
                                    let done=forward_sender.clone();
                                    let task_id=stream_id.clone();
                                    let container_id=container_id.clone();
                                    tauri::async_runtime::spawn(async move {
                                        let mut initial_error=Vec::new();
                                        let mut exit_status=None;
                                        let mut emitted_anything=false;
                                        let outcome=loop{
                                            tokio::select!{
                                                changed=stop_rx.changed()=>{
                                                    if changed.is_err()||*stop_rx.borrow(){break Ok::<(),String>(());}
                                                },
                                                message=log_channel.wait()=>{
                                                    match message {
                                                        Some(russh::ChannelMsg::Data{data})|
                                                        Some(russh::ChannelMsg::ExtendedData{data,..})=>{
                                                            if data.is_empty(){continue;}
                                                            // Docker failures (permission denied, missing socket)
                                                            // often arrive only on stderr. Retain at most 2 KiB
                                                            // for an actionable close/error message.
                                                            if initial_error.len()<2048 {
                                                                let remaining=2048-initial_error.len();
                                                                initial_error.extend_from_slice(&data.as_ref()[..data.len().min(remaining)]);
                                                            }
                                                            emitted_anything=true;
                                                            let _=app.emit(DOCKER_LOG_EVENT,DockerLogStreamEvent{
                                                                session_id:session_id.clone(),
                                                                stream_id:task_id.clone(),
                                                                container_id:container_id.clone(),
                                                                kind:"data",data:Some(STANDARD.encode(data.as_ref())),detail:None
                                                            });
                                                        },
                                                        Some(russh::ChannelMsg::ExitStatus{exit_status:code})=>exit_status=Some(code),
                                                        Some(russh::ChannelMsg::Close)|None=>break Ok(()),
                                                        _=>{}
                                                    }
                                                }
                                            }
                                        };
                                        let _=log_channel.close().await;
                                        let failure=match (outcome,exit_status){
                                            (Err(message),_)=>Some(message),
                                            (_,Some(code)) if code!=0=>Some(format!(
                                                "Remote Docker log command exited with status {code}: {}",
                                                String::from_utf8_lossy(&initial_error).chars().take(300).collect::<String>()
                                            )),
                                            _=>None,
                                        };
                                        let _=app.emit(DOCKER_LOG_EVENT,DockerLogStreamEvent{
                                            session_id:session_id.clone(),stream_id:task_id.clone(),
                                            container_id,kind:if failure.is_some(){"error"}else{"closed"},
                                            data:None,detail:failure.or_else(||if emitted_anything {
                                                Some("Docker log channel finished".to_owned())
                                            }else{Some("Docker log channel ended with no output".to_owned())})
                                        });
                                        let _=done.send(SessionCommand::DockerLogFinished(task_id)).await;
                                    });
                                    let _=response.send(Ok(stream_id));
                                }
                            }
                            Ok(())
                        },
                        Some(SessionCommand::DockerLogStop(stream_id,response))=>{
                            let result=if let Some(stop)=docker_log_streams.remove(&stream_id){
                                let _=stop.send(true);Ok(())
                            }else{Err("Docker log stream no longer exists".to_owned())};
                            let _=response.send(result);
                            Ok(())
                        },
                        Some(SessionCommand::DockerLogFinished(stream_id))=>{
                            docker_log_streams.remove(&stream_id);
                            Ok(())
                        },
                        Some(SessionCommand::DockerInspect(container_id,response)) => {
                            // The input is a previously selected hex Docker ID; shell tokens
                            // and arbitrary inspection templates never come from JavaScript.
                            let setup=tokio::time::timeout(Duration::from_secs(10),async {
                                let mut channel=connection.channel_open_session().await
                                    .map_err(|_|"Could not open Docker inspection channel".to_owned())?;
                                let command=format!("docker inspect --format '{{{{json .}}}}' {container_id}");
                                channel.exec(true,command.as_bytes()).await
                                    .map_err(|_|"SSH server refused Docker inspection".to_owned())?;
                                Ok::<_,String>(channel)
                            }).await.unwrap_or_else(|_|Err("Docker inspection SSH setup timed out".into()));
                            match setup {
                                Err(error)=>{let _=response.send(Err(error));},
                                Ok(mut channel)=>{
                                    tauri::async_runtime::spawn(async move {
                                        let result=tokio::time::timeout(Duration::from_secs(20),async {
                                            let mut output=Vec::new();
                                            let mut exit_status=None;
                                            while let Some(message)=channel.wait().await{
                                                match message{
                                                    russh::ChannelMsg::Data{data} | russh::ChannelMsg::ExtendedData{data,..}=>{
                                                        if output.len().saturating_add(data.len())>1024*1024{
                                                            return Err("Docker inspection exceeded 1 MiB".to_owned());
                                                        }
                                                        output.extend_from_slice(&data);
                                                    },
                                                    russh::ChannelMsg::ExitStatus{exit_status:code}=>exit_status=Some(code),
                                                    russh::ChannelMsg::Close=>break,
                                                    _=>{}
                                                }
                                            }
                                            let text=String::from_utf8_lossy(&output);
                                            if exit_status.is_some_and(|code|code!=0){
                                                return Err(format!("Docker inspect failed: {}",text.chars().take(400).collect::<String>()));
                                            }
                                            let value:serde_json::Value=serde_json::from_str(text.trim())
                                                .map_err(|_|"Docker returned invalid inspect JSON".to_owned())?;
                                            // Deliberately omit Config.Env, Config.Labels, full command
                                            // arguments and any other inspect data which may contain secrets.
                                            let mounts=value.get("Mounts").and_then(|v|v.as_array())
                                                .map(|items|items.iter().take(100).map(|item|serde_json::json!({
                                                    "type":item.get("Type"),"source":item.get("Source"),
                                                    "destination":item.get("Destination"),"rw":item.get("RW")
                                                })).collect::<Vec<_>>()).unwrap_or_default();
                                            let networks=value.pointer("/NetworkSettings/Networks")
                                                .and_then(|v|v.as_object())
                                                .map(|m|m.keys().cloned().collect::<Vec<_>>()).unwrap_or_default();
                                            let safe=serde_json::json!({
                                                "created":value.get("Created"),
                                                "startedAt":value.pointer("/State/StartedAt"),
                                                "finishedAt":value.pointer("/State/FinishedAt"),
                                                "restartPolicy":value.pointer("/HostConfig/RestartPolicy/Name"),
                                                "image":value.pointer("/Config/Image"),
                                                "mounts":mounts,
                                                "networks":networks
                                            });
                                            serde_json::to_string(&safe).map_err(|_|"Could not serialize safe Docker inspection".to_owned())
                                        }).await.unwrap_or_else(|_|Err("Docker inspection timed out".into()));
                                        let _=response.send(result);
                                    });
                                }
                            }
                            Ok(())
                        },
                        Some(SessionCommand::DockerLogs(container_id,tail,response)) => {
                            let setup=tokio::time::timeout(Duration::from_secs(10),async {
                                let mut channel=connection.channel_open_session().await
                                    .map_err(|_|"Could not open Docker log channel".to_owned())?;
                                let command=format!("docker logs --tail {tail} --timestamps {container_id}");
                                channel.exec(true,command.as_bytes()).await
                                    .map_err(|_|"SSH server refused Docker logs command".to_owned())?;
                                Ok::<_,String>(channel)
                            }).await.unwrap_or_else(|_|Err("Docker log SSH channel setup timed out".into()));
                            match setup {
                                Err(error)=>{let _=response.send(Err(error));},
                                Ok(mut channel)=>{
                                    tauri::async_runtime::spawn(async move {
                                        let result=tokio::time::timeout(Duration::from_secs(35),async {
                                            let mut output=Vec::new();
                                            let mut exit_status=None;
                                            while let Some(message)=channel.wait().await {
                                                match message {
                                                    russh::ChannelMsg::Data{data} | russh::ChannelMsg::ExtendedData{data,..}=>{
                                                        if output.len().saturating_add(data.len())>3*1024*1024{
                                                            return Err("Recent Docker logs exceed 3 MiB. Reduce the number of requested lines.".to_owned());
                                                        }
                                                        output.extend_from_slice(&data);
                                                    },
                                                    russh::ChannelMsg::ExitStatus{exit_status:code}=>exit_status=Some(code),
                                                    russh::ChannelMsg::Close=>break,
                                                    _=>{}
                                                }
                                            }
                                            let message=String::from_utf8_lossy(&output).into_owned();
                                            if exit_status.is_some_and(|code|code!=0){
                                                return Err(format!("Docker logs failed: {}",message.chars().take(700).collect::<String>()));
                                            }
                                            Ok::<String,String>(message)
                                        }).await.unwrap_or_else(|_|Err("Docker logs timed out; try fewer lines or check remote Docker service".into()));
                                        let _=response.send(result);
                                    });
                                }
                            }
                            Ok(())
                        },
                        Some(SessionCommand::DockerAction(action,container_id,response)) => {
                            // A separate exec channel avoids freezing the interactive PTY
                            // during slow container restarts. All arguments are native allowlisted.
                            let cmd=connection.channel_open_session().await
                                .map_err(|_|"Could not open Docker control channel");
                            match cmd {
                                Err(message) => {let _=response.send(Err(message.to_owned()));},
                                Ok(mut cmd) => {
                                    let full=format!("docker container {action} {container_id}");
                                    match cmd.exec(true,full.as_bytes()).await {
                                        Err(_) => {let _=response.send(Err("SSH server refused Docker action".into()));},
                                        Ok(()) => {
                                            tauri::async_runtime::spawn(async move {
                                                let output=tokio::time::timeout(Duration::from_secs(45),async {
                                                    let mut bytes=Vec::new();
                                                    let mut exit_status=None;
                                                    while let Some(msg)=cmd.wait().await {
                                                        match msg {
                                                            russh::ChannelMsg::Data{data} | russh::ChannelMsg::ExtendedData{data,..}=>{
                                                                if bytes.len().saturating_add(data.len())>256*1024 {
                                                                    return Err("Docker response exceeds 256 KiB".into());
                                                                }
                                                                bytes.extend_from_slice(&data);
                                                            },
                                                            russh::ChannelMsg::ExitStatus{exit_status:code} => exit_status=Some(code),
                                                            russh::ChannelMsg::Close => break,
                                                            _=>{}
                                                        }
                                                    }
                                                    let message=String::from_utf8_lossy(&bytes).trim().to_owned();
                                                    if exit_status.unwrap_or(1)!=0 {
                                                        return Err(format!("Docker {action} failed: {}",message.chars().take(600).collect::<String>()));
                                                    }
                                                    Ok::<String,String>(format!("Docker {action} completed for {container_id}: {message}"))
                                                }).await.unwrap_or_else(|_|Err("Docker action timed out after 45 seconds".into()));
                                                let _=response.send(output);
                                            });
                                        }
                                    }
                                }
                            }
                            Ok(())
                        },
                        Some(SessionCommand::JumpOpen(target,port,response)) => {
                            // The gateway resolves/reaches the private address via direct-tcpip.
                            // We never run ssh(1) on the gateway and never forward local keys.
                            let opened=tokio::time::timeout(Duration::from_secs(12),
                                connection.channel_open_direct_tcpip(target,port as u32,"127.0.0.1",0)
                            ).await.map_err(|_|"Gateway SSH direct-tcpip timed out".to_owned())
                                .and_then(|r|r.map_err(|e|format!(
                                    "Gateway rejected forwarding to private SSH target: {e}"
                                )));
                            let _=response.send(opened.map(|channel|channel.into_stream()));
                            Ok(())
                        },
                        Some(SessionCommand::AgentProbe(binary,response)) => {
                            // Binary is an exact native allowlist value, not a user command.
                            // Probe only --version; do not start an interactive AI session.
                            let channel=tokio::time::timeout(Duration::from_secs(8),async {
                                let mut cmd=connection.channel_open_session().await
                                    .map_err(|_|"Could not open remote AI detection channel".to_owned())?;
                                // SSH exec does not inherit interactive PATH. A login+interactive
                                // shell sources shell startup files used by nvm, volta, bun,
                                // mise and user CLI installations. Only exact allowlisted names
                                // enter this command; no user-controlled shell text.
                                let command=format!(
                                    "${{SHELL:-/bin/sh}} -lic 'command -v {binary} >/dev/null 2>&1 && {binary} --version' 2>/dev/null || {binary} --version"
                                );
                                cmd.exec(true,command.as_bytes()).await
                                    .map_err(|_|"SSH server refused AI CLI version probe".to_owned())?;
                                Ok::<_,String>(cmd)
                            }).await.unwrap_or_else(|_|Err("AI CLI channel setup timed out".into()));
                            match channel {
                                Err(reason)=>{let _=response.send(Err(reason));},
                                Ok(mut channel)=>{
                                    tauri::async_runtime::spawn(async move {
                                        let result=tokio::time::timeout(Duration::from_secs(12),async {
                                            let mut output=Vec::new();
                                            let mut exit_code=None;
                                            while let Some(message)=channel.wait().await {
                                                match message {
                                                    russh::ChannelMsg::Data{data} |
                                                    russh::ChannelMsg::ExtendedData{data,..}=>{
                                                        if output.len().saturating_add(data.len())>8192 {
                                                            return Err("AI CLI version response exceeds 8 KiB".into());
                                                        }
                                                        output.extend_from_slice(&data);
                                                    },
                                                    russh::ChannelMsg::ExitStatus{exit_status:code}=>exit_code=Some(code),
                                                    russh::ChannelMsg::Close=>break,
                                                    _=>{}
                                                }
                                            }
                                            // Failed exec probes are not proof of absence: a
                                            // human PTY may have a different PATH or rc files.
                                            let installed=exit_code==Some(0);
                                            let version=if installed {
                                                String::from_utf8_lossy(&output).lines()
                                                    .map(str::trim).find(|line|!line.is_empty())
                                                    .map(|line|line.chars().filter(|c|!c.is_control())
                                                        .take(120).collect::<String>())
                                            }else{None};
                                            Ok::<AgentAvailability,String>(AgentAvailability{installed,version})
                                        }).await.unwrap_or_else(|_|Err("AI CLI version probe timed out after 12 seconds".into()));
                                        let _=response.send(result);
                                    });
                                }
                            }
                            Ok(())
                        },
                        Some(SessionCommand::VaultRead(path,response)) => {
                            let opened=tokio::time::timeout(Duration::from_secs(15),async {
                                let channel=connection.channel_open_session().await
                                    .map_err(|e|format!("Could not open encrypted Vault restore SSH channel: {e}"))?;
                                channel.request_subsystem(true,"sftp").await
                                    .map_err(|e|format!("SFTP restore subsystem refused: {e}"))?;
                                Ok::<_,String>(channel.into_stream())
                            }).await.unwrap_or_else(|_|Err("Vault restore SFTP channel timed out".into()));
                            match opened {
                                Err(error)=>{let _=response.send(Err(error));},
                                Ok(stream)=>{
                                    let mut stopped=cancelled.clone();
                                    tauri::async_runtime::spawn(async move {
                                        use tokio::io::AsyncReadExt;
                                        let read=async {
                                            let sftp=russh_sftp::client::SftpSession::new(stream).await
                                                .map_err(|e|format!("Cannot initialize remote backup reader: {e}"))?;
                                            let mut source=sftp.open(path).await
                                                .map_err(|e|format!("Cannot open encrypted remote Vault backup: {e}"))?;
                                            let mut bytes=Vec::new();
                                            source.take(16*1024*1024+1).read_to_end(&mut bytes).await
                                                .map_err(|e|format!("Cannot download encrypted Vault backup: {e}"))?;
                                            if bytes.len()>16*1024*1024{
                                                return Err("Remote encrypted Vault backup exceeds 16 MiB".into());
                                            }
                                            Ok::<Vec<u8>,String>(bytes)
                                        };
                                        let result=tokio::select! {
                                            _=stopped.changed()=>Err("Remote backup inspection cancelled by SSH disconnection".into()),
                                            output=tokio::time::timeout(Duration::from_secs(45),read) =>
                                                output.unwrap_or_else(|_|Err("Remote backup inspection timed out".into()))
                                        };
                                        let _=response.send(result);
                                    });
                                }
                            }
                            Ok(())
                        },
                        Some(SessionCommand::VaultBackup(directory,encrypted,response)) => {
                            let opened=tokio::time::timeout(Duration::from_secs(15),async {
                                let channel=connection.channel_open_session().await
                                    .map_err(|e|format!("Could not open encrypted Vault backup SSH channel: {e}"))?;
                                channel.request_subsystem(true,"sftp").await
                                    .map_err(|e|format!("SFTP backup subsystem refused: {e}"))?;
                                Ok::<_,String>(channel.into_stream())
                            }).await.unwrap_or_else(|_|Err("Vault backup SFTP channel timed out".into()));
                            match opened {
                                Err(error)=>{let _=response.send(Err(error));},
                                Ok(stream)=>{
                                    let mut stopped=cancelled.clone();
                                    tauri::async_runtime::spawn(async move {
                                        use tokio::io::{AsyncReadExt,AsyncWriteExt};
                                        let backup=async {
                                            let sftp=russh_sftp::client::SftpSession::new(stream).await
                                                .map_err(|e|format!("Cannot initialize remote Vault backup: {e}"))?;
                                            let path=join_sftp_path(&directory,&snapshot_remote_name());
                                            let mut remote=sftp.open_with_flags_and_attributes(
                                                path.clone(),
                                                russh_sftp::protocol::OpenFlags::CREATE |
                                                russh_sftp::protocol::OpenFlags::EXCLUDE |
                                                russh_sftp::protocol::OpenFlags::WRITE,
                                                russh_sftp::protocol::FileAttributes{
                                                    permissions:Some(0o600),
                                                    ..russh_sftp::protocol::FileAttributes::empty()
                                                }
                                            ).await.map_err(|e|format!("Cannot create private encrypted backup: {e}"))?;
                                            let saved=async {
                                                remote.write_all(&encrypted).await
                                                    .map_err(|e|format!("Encrypted backup write failed: {e}"))?;
                                                remote.flush().await
                                                    .map_err(|e|format!("Encrypted backup flush failed: {e}"))?;
                                                remote.shutdown().await
                                                    .map_err(|e|format!("Encrypted backup close failed: {e}"))?;
                                                Ok::<(),String>(())
                                            }.await;
                                            drop(remote);
                                            let result=match saved {
                                                Err(e)=>Err(e),
                                                Ok(())=>async {
                                                    let mut verify=sftp.open(path.clone()).await
                                                        .map_err(|e|format!("Cannot verify remote Vault backup: {e}"))?;
                                                    let mut copy=Vec::new();
                                                    verify.take(encrypted.len() as u64 + 1)
                                                        .read_to_end(&mut copy).await
                                                        .map_err(|e|format!("Remote backup readback failed: {e}"))?;
                                                    if copy!=encrypted {
                                                        return Err("Remote Vault backup did not match its original encrypted bytes".to_owned());
                                                    }
                                                    Ok(VaultBackupResult{
                                                        remote_path:path.clone(),bytes:encrypted.len(),verified:true
                                                    })
                                                }.await,
                                            };
                                            if result.is_err(){
                                                // Failed writes or mismatched bytes are never presented
                                                // as a valid backup; deletion is best effort.
                                                let _=tokio::time::timeout(
                                                    Duration::from_secs(5),sftp.remove_file(path)
                                                ).await;
                                            }
                                            result
                                        };
                                        let result=tokio::select!{
                                            _=stopped.changed()=>Err("Vault backup cancelled: SSH disconnected or Vault locked".into()),
                                            output=tokio::time::timeout(Duration::from_secs(90),backup) =>
                                                output.unwrap_or_else(|_|Err("Encrypted Vault backup timed out after 90 seconds".into()))
                                        };
                                        let _=response.send(result);
                                    });
                                }
                            }
                            Ok(())
                        },
                        Some(SessionCommand::SftpMutate(operation,directory,name,new_name,is_directory,response)) => {
                            let opened=tokio::time::timeout(Duration::from_secs(10),async {
                                let channel=connection.channel_open_session().await
                                    .map_err(|e|format!("Could not open SFTP file operation channel: {e}"))?;
                                channel.request_subsystem(true,"sftp").await
                                    .map_err(|e|format!("SFTP subsystem refused file operation: {e}"))?;
                                Ok::<_,String>(channel.into_stream())
                            }).await.unwrap_or_else(|_|Err("SFTP operation channel timed out".into()));
                            match opened{
                                Err(error)=>{let _=response.send(Err(error));},
                                Ok(stream)=>{
                                    tauri::async_runtime::spawn(async move {
                                        let task=async {
                                            let sftp=russh_sftp::client::SftpSession::new(stream).await
                                                .map_err(|e|format!("SFTP operation unavailable: {e}"))?;
                                            let path=join_sftp_path(&directory,&name);
                                            match operation.as_str(){
                                                "rename"=>{
                                                    let next=new_name.as_deref().ok_or("New filename is required")?;
                                                    let destination=join_sftp_path(&directory,next);
                                                    if sftp.try_exists(destination.clone()).await
                                                        .map_err(|e|format!("Cannot verify destination is free: {e}"))?{
                                                        return Err("The requested filename already exists; rename aborted".into());
                                                    }
                                                    sftp.rename(path,destination).await
                                                        .map_err(|e|format!("Remote rename failed: {e}"))?
                                                },
                                                "mkdir"=>sftp.create_dir(path).await
                                                    .map_err(|e|format!("Cannot create remote directory: {e}"))?,
                                                "delete" if is_directory=>sftp.remove_dir(path).await
                                                    .map_err(|e|format!("Cannot remove remote directory (it must be empty): {e}"))?,
                                                "delete"=>sftp.remove_file(path).await
                                                    .map_err(|e|format!("Cannot delete remote file: {e}"))?,
                                                _=>return Err("Unsupported remote file operation".into())
                                            }
                                            Ok::<(),String>(())
                                        };
                                        let result=tokio::time::timeout(Duration::from_secs(25),task).await
                                            .unwrap_or_else(|_|Err("Remote SFTP file operation timed out".into()));
                                        let _=response.send(result);
                                    });
                                }
                            }
                            Ok(())
                        },
                        Some(SessionCommand::SftpList(path,response)) => {
                            // Only the SSH subsystem negotiation needs the connection handle.
                            // Directory scanning and sorting happen outside the PTY loop.
                            let opened=tokio::time::timeout(Duration::from_secs(10),async {
                                let channel=connection.channel_open_session().await
                                    .map_err(|e|format!("Could not open SFTP channel: {e}"))?;
                                channel.request_subsystem(true,"sftp").await
                                    .map_err(|e|format!("SFTP subsystem refused: {e}"))?;
                                Ok::<_,String>(channel.into_stream())
                            }).await.unwrap_or_else(|_|Err("SFTP channel setup timed out".into()));
                            match opened {
                                Err(error)=>{let _=response.send(Err(error));},
                                Ok(stream)=>{
                                    tauri::async_runtime::spawn(async move {
                                        let result=tokio::time::timeout(Duration::from_secs(20),async {
                                            let sftp=russh_sftp::client::SftpSession::new(stream).await
                                                .map_err(|e|format!("SFTP initialization failed: {e}"))?;
                                            let entries=sftp.read_dir(path).await
                                                .map_err(|e|format!("SFTP folder could not be read: {e}"))?;
                                            let mut result=Vec::new();
                                            for entry in entries {
                                                if result.len()>=2000 {break;}
                                                let name=entry.file_name();
                                                if name=="." || name==".." {continue;}
                                                let attrs=entry.metadata();
                                                let is_dir=attrs.is_dir();
                                                let size_bytes=if is_dir{None}else{Some(attrs.len())};
                                                let modified_at=attrs.modified().ok()
                                                    .and_then(|date|date.duration_since(std::time::UNIX_EPOCH).ok())
                                                    .map(|duration|duration.as_secs());
                                                let unix_permissions=attrs.permissions.map(|mode|mode & 0o7777);
                                                let owner_id=attrs.uid;
                                                let group_id=attrs.gid;
                                                result.push(SftpEntry{name,is_dir,size_bytes,modified_at,unix_permissions,owner_id,group_id});
                                            }
                                            result.sort_by(|a,b|b.is_dir.cmp(&a.is_dir)
                                                .then_with(||a.name.to_lowercase().cmp(&b.name.to_lowercase())));
                                            Ok::<Vec<SftpEntry>,String>(result)
                                        }).await.unwrap_or_else(|_|Err("SFTP directory listing timed out".into()));
                                        let _=response.send(result);
                                    });
                                }
                            }
                            Ok(())
                        },
                        Some(SessionCommand::SftpRead(path,response)) => {
                            let opened=tokio::time::timeout(Duration::from_secs(10),async {
                                let channel=connection.channel_open_session().await
                                    .map_err(|e|format!("Could not open SFTP preview channel: {e}"))?;
                                channel.request_subsystem(true,"sftp").await
                                    .map_err(|e|format!("SFTP subsystem unavailable: {e}"))?;
                                Ok::<_,String>(channel.into_stream())
                            }).await.unwrap_or_else(|_|Err("SFTP preview channel setup timed out".into()));
                            match opened {
                                Err(error)=>{let _=response.send(Err(error));},
                                Ok(stream)=>{
                                    tauri::async_runtime::spawn(async move {
                                        use tokio::io::AsyncReadExt;
                                        let result=tokio::time::timeout(Duration::from_secs(20),async {
                                            let sftp=russh_sftp::client::SftpSession::new(stream).await
                                                .map_err(|e|format!("SFTP initialization failed: {e}"))?;
                                            let mut file=sftp.open(path).await
                                                .map_err(|e|format!("Cannot open remote file: {e}"))?;
                                            const MAX:u64=262_144;
                                            let mut bytes=Vec::new();
                                            (&mut file).take(MAX+1).read_to_end(&mut bytes).await
                                                .map_err(|e|format!("Cannot read remote file: {e}"))?;
                                            if bytes.len()>MAX as usize {
                                                return Err("File too large for preview (256 KiB limit)".into());
                                            }
                                            if bytes.contains(&0){
                                                return Err("Binary file cannot be previewed as text".into());
                                            }
                                            String::from_utf8(bytes).map_err(|_|"Text preview requires UTF-8; download binary or non-UTF-8 files instead".into())
                                        }).await.unwrap_or_else(|_|Err("SFTP text preview timed out".into()));
                                        let _=response.send(result);
                                    });
                                }
                            }
                            Ok(())
                        },
                        Some(SessionCommand::SftpDownload(transfer_id,path,destination,response)) => {
                            if transfers.contains_key(&transfer_id) {
                                let _=response.send(Err("Duplicate transfer ID".into()));
                            } else {
                                let (cancel_tx,mut user_abort)=tokio::sync::watch::channel(false);
                                transfers.insert(transfer_id.clone(),cancel_tx);
                                let opened=tokio::time::timeout(Duration::from_secs(15),async {
                                    let ch=connection.channel_open_session().await
                                        .map_err(|e|format!("SFTP download channel failed: {e}"))?;
                                    ch.request_subsystem(true,"sftp").await
                                        .map_err(|e|format!("SFTP subsystem unavailable: {e}"))?;
                                    Ok::<_,String>(ch.into_stream())
                                }).await.unwrap_or_else(|_|Err("SFTP channel open timed out".into()));
                                match opened {
                                    Err(error) => {
                                        transfers.remove(&transfer_id);
                                        let _=response.send(Err(error));
                                    },
                                    Ok(stream) => {
                                        let mut session_abort=cancelled.clone();
                                        let transfer_app=app.clone();
                                        let session_id=cleanup_id.clone();
                                        let finish_sender=forward_sender.clone();
                                        tauri::async_runtime::spawn(async move {
                                            use tokio::io::AsyncWriteExt;
                                            let local_name=destination.file_name().and_then(|s|s.to_str()).unwrap_or("download");
                                            let staging=destination.with_file_name(format!(
                                                ".{local_name}.passh7-{}.part",NEXT_ID.fetch_add(1,Ordering::Relaxed)
                                            ));
                                            send_sftp_progress(&transfer_app,&session_id,&transfer_id,"download","started",0,None);
                                            let task=async {
                                                let sftp=russh_sftp::client::SftpSession::new(stream).await
                                                    .map_err(|e|format!("SFTP initialization failed: {e}"))?;
                                                let mut remote=sftp.open(path).await
                                                    .map_err(|e|format!("Cannot open remote file: {e}"))?;
                                                let mut local=tokio::fs::OpenOptions::new()
                                                    .write(true).create_new(true).open(&staging).await
                                                    .map_err(|e|format!("Cannot create temporary download: {e}"))?;
                                                let size=copy_sftp_progress(&mut remote,&mut local,
                                                    &transfer_app,&session_id,&transfer_id,"download",None).await?;
                                                local.flush().await.map_err(|e|format!("Cannot flush download: {e}"))?;
                                                local.sync_all().await.map_err(|e|format!("Cannot sync download: {e}"))?;
                                                drop(local);
                                                publish_download_exclusive(&staging,&destination).await?;
                                                Ok::<u64,String>(size)
                                            };
                                            let result=tokio::select! {
                                                _=user_abort.changed() => Err("Download cancelled by user".into()),
                                                _=session_abort.changed() => Err("Download cancelled by SSH disconnect or vault lock".into()),
                                                res=tokio::time::timeout(Duration::from_secs(90),task) =>
                                                    res.unwrap_or_else(|_|Err("Download timed out after 90 seconds".into()))
                                            };
                                            if result.is_err(){let _=tokio::fs::remove_file(&staging).await;}
                                            let _=response.send(result);
                                            let _=finish_sender.send(SessionCommand::SftpFinished(transfer_id)).await;
                                        });
                                    }
                                }
                            }
                            Ok(())
                        },
                        Some(SessionCommand::SftpUpload(transfer_id,directory,source,response)) => {
                            if transfers.contains_key(&transfer_id) {
                                let _=response.send(Err("Duplicate transfer ID".into()));
                            } else {
                                let (cancel_tx,mut user_abort)=tokio::sync::watch::channel(false);
                                transfers.insert(transfer_id.clone(),cancel_tx);
                                let opened=tokio::time::timeout(Duration::from_secs(15),async {
                                    let ch=connection.channel_open_session().await
                                        .map_err(|e|format!("SFTP upload channel failed: {e}"))?;
                                    ch.request_subsystem(true,"sftp").await
                                        .map_err(|e|format!("SFTP subsystem unavailable: {e}"))?;
                                    Ok::<_,String>(ch.into_stream())
                                }).await.unwrap_or_else(|_|Err("SFTP channel open timed out".into()));
                                match opened {
                                    Err(error) => {
                                        transfers.remove(&transfer_id);
                                        let _=response.send(Err(error));
                                    },
                                    Ok(stream) => {
                                        let mut session_abort=cancelled.clone();
                                        let transfer_app=app.clone();
                                        let session_id=cleanup_id.clone();
                                        let finish_sender=forward_sender.clone();
                                        tauri::async_runtime::spawn(async move {
                                            use tokio::io::AsyncWriteExt;
                                            let task=async {
                                                let metadata=tokio::fs::metadata(&source).await
                                                    .map_err(|e|format!("Cannot inspect local file: {e}"))?;
                                                if !metadata.is_file(){return Err("Selected path is not a regular file".into());}
                                                if metadata.len()>MAX_TRANSFER{return Err("Upload exceeds 64 MiB limit".into());}
                                                let filename=source.file_name().and_then(|n|n.to_str())
                                                    .ok_or("Local filename is not UTF-8")?;
                                                if !safe_sftp_filename(filename){return Err("Unsafe filename".into());}
                                                let remote_path=join_sftp_path(&directory,filename);
                                                let sftp=russh_sftp::client::SftpSession::new(stream).await
                                                    .map_err(|e|format!("SFTP initialization failed: {e}"))?;
                                                let mut local=tokio::fs::File::open(&source).await
                                                    .map_err(|e|format!("Cannot open local file: {e}"))?;
                                                send_sftp_progress(&transfer_app,&session_id,&transfer_id,
                                                    "upload","started",0,Some(metadata.len()));
                                                let mut remote=sftp.open_with_flags(remote_path.clone(),
                                                    russh_sftp::protocol::OpenFlags::CREATE |
                                                    russh_sftp::protocol::OpenFlags::EXCLUDE |
                                                    russh_sftp::protocol::OpenFlags::WRITE
                                                ).await.map_err(|e|format!("Cannot create new remote file (perhaps already exists): {e}"))?;
                                                let outcome=tokio::select!{
                                                    _=user_abort.changed() => Err("Upload cancelled by user".to_owned()),
                                                    _=session_abort.changed() => Err("Upload cancelled by SSH disconnect or vault lock".to_owned()),
                                                    result=tokio::time::timeout(Duration::from_secs(90),async {
                                                        let copied=copy_sftp_progress(&mut local,&mut remote,
                                                            &transfer_app,&session_id,&transfer_id,"upload",Some(metadata.len())).await?;
                                                        remote.flush().await.map_err(|e|format!("Remote flush failed: {e}"))?;
                                                        remote.shutdown().await.map_err(|e|format!("Remote close failed: {e}"))?;
                                                        Ok::<u64,String>(copied)
                                                    })=>result.unwrap_or_else(|_|Err("Upload timed out after 90 seconds".into()))
                                                };
                                                drop(remote);
                                                if outcome.is_err(){
                                                    // Network loss may prevent remote cleanup; never remove
                                                    // a destination which was already present (EXCLUDE above).
                                                    let _=tokio::time::timeout(Duration::from_secs(5),
                                                        sftp.remove_file(remote_path)).await;
                                                }
                                                outcome
                                            };
                                            let result=task.await;
                                            let _=response.send(result);
                                            let _=finish_sender.send(SessionCommand::SftpFinished(transfer_id)).await;
                                        });
                                    }
                                }
                            }
                            Ok(())
                        },
                        Some(SessionCommand::ForwardStart(local_port,target_host,remote_port,response)) => {
                            if forwarders.contains_key(&local_port) {
                                let _ = response.send(Err("Local port already forwarded by this session".into()));
                            } else {
                                match tokio::net::TcpListener::bind(("127.0.0.1",local_port)).await {
                                    Ok(listener) => {
                                        let (stop_tx,mut stop_rx) = tokio::sync::oneshot::channel::<()>();
                                        forwarders.insert(local_port,(stop_tx,target_host.clone(),remote_port));
                                        let tx = forward_sender.clone();
                                        let mut cancel = cancelled.clone();
                                        tauri::async_runtime::spawn(async move {
                                            loop {
                                                tokio::select! {
                                                    _ = &mut stop_rx => break,
                                                    changed = cancel.changed() => { if changed.is_err() || *cancel.borrow() { break; } },
                                                    accepted = listener.accept() => {
                                                        match accepted {
                                                            Ok((socket,_peer)) => {
                                                                if tx.send(SessionCommand::ForwardOpen(socket,target_host.clone(),remote_port)).await.is_err() { break; }
                                                            },
                                                            Err(_) => break,
                                                        }
                                                    },
                                                }
                                            }
                                        });
                                        let _ = response.send(Ok(()));
                                    },
                                    Err(e) => { let _ = response.send(Err(format!("Cannot bind localhost:{local_port}: {e}"))); }
                                }
                            }
                            Ok(())
                        },
                        Some(SessionCommand::ForwardStop(local_port,response)) => {
                            if let Some((cancel,_,_))=forwarders.remove(&local_port){
                                let _ = cancel.send(());
                                let _ = response.send(Ok(()));
                            }else{
                                let _ = response.send(Err("No active local forwarding on this port".into()));
                            }
                            Ok(())
                        },
                        Some(SessionCommand::ForwardList(response)) => {
                            let mut records:Vec<ActiveLocalForward>=forwarders.iter()
                                .map(|(port,(_,host,remote_port))|ActiveLocalForward{
                                    local_port:*port,target_host:host.clone(),remote_port:*remote_port
                                }).collect();
                            records.sort_by_key(|r|r.local_port);
                            let _=response.send(records);
                            Ok(())
                        },
                        Some(SessionCommand::ForwardOpen(mut socket,target_host,remote_port)) => {
                            let peer = socket.peer_addr().ok();
                            let origin_addr=peer.map(|a|a.ip().to_string()).unwrap_or_else(||"127.0.0.1".into());
                            let origin_port=peer.map(|a|a.port() as u32).unwrap_or_default();
                            match connection.channel_open_direct_tcpip(target_host,remote_port as u32,origin_addr,origin_port).await {
                                Ok(channel)=>{
                                    tauri::async_runtime::spawn(async move {
                                        let mut stream=channel.into_stream();
                                        let _ = tokio::io::copy_bidirectional(&mut socket,&mut stream).await;
                                    });
                                },
                                Err(_)=>{} // The local TCP stream is dropped if forwarding is denied.
                            }
                            Ok(())
                        },
                        Some(SessionCommand::Close) => break,
                        None => {
                            closure_detail = Some("SSH session command queue was closed".into());
                            break;
                        },
                    };
                    if result.is_err() { break; }
                }
                incoming = channel.wait() => {
                    match incoming {
                        Some(russh::ChannelMsg::Data { data }) |
                        Some(russh::ChannelMsg::ExtendedData { data, .. }) => {
                            if ready {
                                let _ = app.emit(EVENT, SessionEvent {
                                    id: cleanup_id.clone(), kind: "data",
                                    data: Some(STANDARD.encode(&data)), detail: None
                                });
                            } else if buffered + data.len() <= 1024 * 1024 {
                                buffered += data.len();
                                backlog.push(data.to_vec());
                            } else {
                                overflowed = true;
                            }
                        }
                        Some(russh::ChannelMsg::Close) | None => {
                            closure_detail = Some("Remote SSH shell closed the connection".into());
                            break;
                        },
                        _ => {}
                    }
                }
            }
        }
        for (_, (stop,_,_)) in forwarders.drain() { let _=stop.send(()); }
        for (_,cancel) in transfers.drain() { let _=cancel.send(true); }
        for (_,stop) in docker_log_streams.drain() { let _=stop.send(true); }
        let _ = channel.close().await;
        let _ = connection.disconnect(russh::Disconnect::ByApplication, "Session closed", "en").await;
        if let Ok(mut guard) = manager.channels.lock() { guard.remove(&cleanup_id); }
        let _ = app.emit(EVENT, SessionEvent { id: cleanup_id, kind: "closed", data: None, detail: closure_detail });
    });
    Ok(OpenedSession { id, alias })
}

#[tauri::command]
pub fn ssh_session_list(manager: State<'_, SshSessionManager>) -> Result<Vec<OpenedSession>, String> {
    manager.active_sessions()
}

#[tauri::command]
pub async fn ssh_session_write(id: String, data: String, manager: State<'_, SshSessionManager>) -> Result<(), String> {
    if data.len() > 64 * 1024 { return Err("SSH input exceeds 64 KiB".into()); }
    manager.input_sender(&id)?.send(data.into_bytes()).await
        .map_err(|_|"SSH terminal input channel closed".to_owned())
}

#[tauri::command]
pub async fn ssh_session_resize(id: String, cols: u32, rows: u32,
    manager: State<'_, SshSessionManager>) -> Result<(), String> {
    if !(20..=500).contains(&cols) || !(5..=200).contains(&rows) { return Err("Invalid terminal size".into()); }
    manager.sender(&id)?.send(SessionCommand::Resize(cols, rows)).await
        .map_err(|_| "SSH session closed".to_owned())
}

#[tauri::command]
pub async fn ssh_session_close(id: String, manager: State<'_, SshSessionManager>) -> Result<(), String> {
    manager.sender(&id)?.send(SessionCommand::Close).await.map_err(|_| "SSH session already closed".to_owned())
}

/// Fixed commands only: no user-supplied shell command or arbitrary container
/// names. The catalog response is bounded in the SSH actor.
fn docker_catalog_command(kind:&str)->Option<&'static str>{
    match kind{
        "images"=>Some("docker image ls --format \"{{json .}}\""),
        "volumes"=>Some("docker volume ls --format \"{{json .}}\""),
        "networks"=>Some("docker network ls --format \"{{json .}}\""),
        "stats"=>Some("docker stats --no-stream --format \"{{json .}}\""),
        _=>None
    }
}

#[tauri::command]
pub async fn ssh_session_docker_catalog(
    id:String,kind:String,manager:State<'_,SshSessionManager>
)->Result<String,String>{
    if docker_catalog_command(&kind).is_none(){
        return Err("Unsupported Docker catalog category".into());
    }
    let (tx,rx)=tokio::sync::oneshot::channel();
    manager.sender(&id)?.send(SessionCommand::DockerCatalog(kind,tx)).await
        .map_err(|_|"SSH session closed before Docker catalog request")?;
    rx.await.map_err(|_|"Docker catalog response interrupted")?
}

#[cfg(test)]
mod docker_catalog_tests{
    use super::docker_catalog_command;
    #[test]
    fn only_fixed_read_only_catalog_commands_are_accepted(){
        for kind in ["images","volumes","networks","stats"]{
            let command=docker_catalog_command(kind).unwrap();
            assert!(command.starts_with("docker "));
            assert!(command.contains("--format"));
        }
        for bad in ["containers","images; rm -rf /","logs","docker ps",""]{
            assert!(docker_catalog_command(bad).is_none());
        }
    }
}

#[tauri::command]
pub async fn ssh_session_docker_list(id: String, manager: State<'_, SshSessionManager>) -> Result<String, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    manager.sender(&id)?.send(SessionCommand::DockerList(tx)).await
        .map_err(|_| "SSH session closed".to_owned())?;
    rx.await.map_err(|_| "Docker request was cancelled".to_owned())?
}

// Only container IDs from the verified Docker inventory may be used.
// Names, flags and shell input are intentionally rejected.
fn valid_docker_container_id(id: &str) -> bool {
    (12..=64).contains(&id.len()) && id.bytes().all(|c| c.is_ascii_hexdigit())
}

#[tauri::command]
pub async fn ssh_session_docker_inspect(
    id:String,container_id:String,manager:State<'_,SshSessionManager>
)->Result<String,String>{
    if !valid_docker_container_id(&container_id){
        return Err("Invalid Docker container ID".into());
    }
    let (tx,rx)=tokio::sync::oneshot::channel();
    manager.sender(&id)?.send(SessionCommand::DockerInspect(container_id,tx)).await
        .map_err(|_|"SSH session closed before Docker inspection")?;
    rx.await.map_err(|_|"Docker inspection interrupted")?
}

#[tauri::command]
pub async fn ssh_session_docker_logs(id: String, container_id: String, tail: Option<u32>, manager: State<'_, SshSessionManager>) -> Result<String, String> {
    if !valid_docker_container_id(&container_id) {
        return Err("Invalid Docker container ID: use the hex ID from the inventory".into());
    }
    let count=tail.unwrap_or(200);
    if !(10..=1000).contains(&count){return Err("Docker log tail must be 10–1000 lines".into());}
    let (tx,rx)=tokio::sync::oneshot::channel();
    manager.sender(&id)?.send(SessionCommand::DockerLogs(container_id,count,tx)).await
        .map_err(|_|"SSH session closed".to_owned())?;
    rx.await.map_err(|_|"Docker logs request was cancelled".to_owned())?
}

#[tauri::command]
pub async fn ssh_session_docker_log_start(
    id:String,container_id:String,tail:u32,manager:State<'_,SshSessionManager>
)->Result<String,String>{
    if !valid_docker_container_id(&container_id){
        return Err("Invalid Docker container ID".into());
    }
    if tail>1000{return Err("Live Docker log tail must be 0–1000 lines".into());}
    let stream_id=format!("docker-log-{}",NEXT_ID.fetch_add(1,Ordering::Relaxed));
    let (tx,rx)=tokio::sync::oneshot::channel();
    manager.sender(&id)?.send(SessionCommand::DockerLogStart(container_id,tail,stream_id,tx)).await
        .map_err(|_|"SSH session closed before starting Docker log stream")?;
    rx.await.map_err(|_|"Docker live log setup was interrupted")?
}

#[tauri::command]
pub async fn ssh_session_docker_log_stop(
    id:String,stream_id:String,manager:State<'_,SshSessionManager>
)->Result<(),String>{
    if !stream_id.starts_with("docker-log-") || stream_id.len()>64 ||
        !stream_id["docker-log-".len()..].bytes().all(|byte|byte.is_ascii_digit()){
        return Err("Invalid Docker log stream ID".into());
    }
    let (tx,rx)=tokio::sync::oneshot::channel();
    manager.sender(&id)?.send(SessionCommand::DockerLogStop(stream_id,tx)).await
        .map_err(|_|"SSH session closed before stopping Docker log stream")?;
    rx.await.map_err(|_|"Docker log stream stop was interrupted")?
}

fn valid_docker_action(action:&str)->bool{
    matches!(action,"start"|"stop"|"restart")
}

#[tauri::command]
pub async fn ssh_session_docker_action(
    id:String,container_id:String,action:String,manager:State<'_,SshSessionManager>
)->Result<String,String>{
    if !valid_docker_container_id(&container_id){return Err("Invalid container ID".into());}
    if !valid_docker_action(&action){return Err("Unsupported Docker action".into());}
    let (tx,rx)=tokio::sync::oneshot::channel();
    manager.sender(&id)?.send(SessionCommand::DockerAction(action,container_id,tx)).await
        .map_err(|_|"SSH session closed before Docker action")?;
    rx.await.map_err(|_|"Docker action interrupted")?
}

fn allowed_agent_binary(kind:&str)->Option<&'static str>{
    match kind{
        "codex"=>Some("codex"),
        "claude"=>Some("claude"),
        "opencode"=>Some("opencode"),
        _=>None
    }
}

#[tauri::command]
pub async fn ssh_session_agent_probe(id:String,agent:String,
    manager:State<'_,SshSessionManager>)->Result<AgentAvailability,String>{
    let binary=allowed_agent_binary(&agent)
        .ok_or("Unsupported AI CLI agent")?.to_owned();
    let (tx,rx)=tokio::sync::oneshot::channel();
    manager.sender(&id)?.send(SessionCommand::AgentProbe(binary,tx)).await
        .map_err(|_|"SSH session closed during AI CLI detection")?;
    rx.await.map_err(|_|"AI CLI probe response cancelled".to_owned())?
}

/// Only encrypted snapshot bytes flow from the authenticated SSH host to
/// the native Vault restore verifier. They are NEVER returned to the WebView.
pub async fn read_vault_snapshot_for_restore(
    id:&str,path:&str,manager:&SshSessionManager
)->Result<Vec<u8>,String>{
    if !valid_sftp_path(path){return Err("Invalid remote backup path".into());}
    let name=path.rsplit('/').next().unwrap_or("");
    if !name.starts_with("passh7-vault-") ||
        !name.ends_with(".enc.json") ||
        name.len()>160 || name.contains('\\') || name.chars().any(|c|c.is_control()){
        return Err("Select a versioned PaSSH7 encrypted Vault snapshot".into());
    }
    let (tx,rx)=tokio::sync::oneshot::channel();
    manager.sender(id)?.send(SessionCommand::VaultRead(path.to_owned(),tx)).await
        .map_err(|_|"SSH session closed before remote backup inspection")?;
    rx.await.map_err(|_|"Remote encrypted Vault backup inspection interrupted")?
}

#[tauri::command]
fn read_verified_encrypted_vault(vault:&SessionStore)->Result<Vec<u8>,String>{
    // Exactly one local encrypted Vault generation per batch. The master
    // password and plaintext stay native; never send them to remote hosts.
    vault.use_password(|password|{
        let source=vault_path()?;
        let metadata=std::fs::metadata(&source)
            .map_err(|e|format!("Cannot inspect encrypted Vault: {e}"))?;
        if !metadata.is_file() || metadata.len()>16*1024*1024 {
            return Err("Encrypted Vault is not a regular file below 16 MiB".into());
        }
        let bytes=std::fs::read(&source).map_err(|e|format!("Cannot read encrypted Vault: {e}"))?;
        let _verified=passh7_core::decrypt(&bytes,password).map_err(safe_err)?;
        Ok(bytes)
    })
}

#[tauri::command]
pub async fn ssh_session_vault_backup(
    id:String,directory:String,vault:State<'_,SessionStore>,manager:State<'_,SshSessionManager>
)->Result<VaultBackupResult,String>{
    if !valid_sftp_path(&directory){return Err("Invalid remote backup directory".into());}
    let encrypted=read_verified_encrypted_vault(&vault)?;
    let (tx,rx)=tokio::sync::oneshot::channel();
    manager.sender(&id)?.send(SessionCommand::VaultBackup(directory,encrypted,tx)).await
        .map_err(|_|"SSH connection closed before Vault backup")?;
    rx.await.map_err(|_|"Encrypted Vault backup interrupted")?
}

#[tauri::command]
pub async fn ssh_session_vault_backup_batch(
    targets:Vec<VaultBatchTarget>,vault:State<'_,SessionStore>,
    manager:State<'_,SshSessionManager>,app:AppHandle
)->Result<Vec<VaultBatchOutcome>,String>{
    validate_vault_batch_targets(&targets)?;
    let encrypted=read_verified_encrypted_vault(&vault)?;
    let mut outcomes=Vec::with_capacity(targets.len());
    let total=targets.len();
    for (index,target) in targets.into_iter().enumerate(){
        let _=app.emit("passh7:vault-batch",VaultBatchProgress{
            alias:target.alias.clone(),index:index+1,total,stage:"started"
        });
        let result=async{
            let sender=manager.sender(&target.id)?;
            let (tx,rx)=tokio::sync::oneshot::channel();
            sender.send(SessionCommand::VaultBackup(
                target.directory.clone(),encrypted.clone(),tx
            )).await.map_err(|_|"SSH connection closed before Vault backup".to_owned())?;
            rx.await.map_err(|_|"Vault backup response cancelled".to_owned())?
        }.await;
        let (remote_path,error)=match result{
            Ok(receipt) if receipt.verified=>(Some(receipt.remote_path),None),
            Ok(_)=>(None,Some("Remote ciphertext could not be verified".into())),
            Err(error)=>(None,Some(error)),
        };
        let stage=if error.is_some(){"failed"}else{"verified"};
        let _=app.emit("passh7:vault-batch",VaultBatchProgress{
            alias:target.alias.clone(),index:index+1,total,stage
        });
        outcomes.push(VaultBatchOutcome{alias:target.alias,remote_path,error});
    }
    Ok(outcomes)
}


#[tauri::command]
pub async fn ssh_session_sftp_mutate(
    id:String,operation:String,directory:String,name:String,new_name:Option<String>,is_directory:bool,
    manager:State<'_,SshSessionManager>
)->Result<(),String>{
    if !matches!(operation.as_str(),"mkdir"|"delete"|"rename"){
        return Err("Unsupported file operation".into());
    }
    if !valid_sftp_path(&directory)||directory.chars().any(|c|c.is_control()) ||
        !safe_sftp_filename(&name) ||
        join_sftp_path(&directory,&name).len()>4096||
        (operation=="rename"&&
          (!new_name.as_deref().is_some_and(safe_sftp_filename)||
            join_sftp_path(&directory,new_name.as_deref().unwrap_or("")).len()>4096)){
        return Err("Invalid remote file or directory name".into());
    }
    if operation=="mkdir"&&is_directory{
        return Err("Invalid directory create request".into());
    }
    let (tx,rx)=tokio::sync::oneshot::channel();
    manager.sender(&id)?.send(SessionCommand::SftpMutate(operation,directory,name,new_name,is_directory,tx)).await
        .map_err(|_|"SSH session closed before file operation")?;
    rx.await.map_err(|_|"SFTP file operation interrupted")?
}

#[tauri::command]
pub async fn ssh_session_sftp_list(id: String, path: String, manager: State<'_, SshSessionManager>) -> Result<Vec<SftpEntry>, String> {
    if path.len()>4096 || path.as_bytes().contains(&0) { return Err("Invalid SFTP directory path".into()); }
    let (tx,rx)=tokio::sync::oneshot::channel();
    manager.sender(&id)?.send(SessionCommand::SftpList(path,tx)).await
        .map_err(|_| "SSH connection has closed".to_owned())?;
    rx.await.map_err(|_| "SFTP listing cancelled".to_owned())?
}

#[tauri::command]
pub async fn ssh_session_sftp_read_text(id:String,path:String,manager:State<'_,SshSessionManager>)->Result<String,String>{
    if path.len()>4096 || path.as_bytes().contains(&0) {return Err("Invalid SFTP file path".into());}
    let (tx,rx)=tokio::sync::oneshot::channel();
    manager.sender(&id)?.send(SessionCommand::SftpRead(path,tx)).await
        .map_err(|_|"SSH connection has closed".to_owned())?;
    rx.await.map_err(|_|"SFTP preview was cancelled".to_owned())?
}

fn valid_transfer_id(id:&str)->bool{
    (8..=96).contains(&id.len()) &&
    id.bytes().all(|byte|byte.is_ascii_alphanumeric() || byte==b'-')
}

fn safe_sftp_filename(name:&str)->bool{
    !name.is_empty() && name!="." && name!=".." &&
    !name.contains('/') && !name.contains('\\') &&
    !name.chars().any(|c|c.is_control()) && name.len()<=255
}
fn join_sftp_path(dir:&str,name:&str)->String{
    format!("{}/{}",dir.trim_end_matches('/'),name)
}
fn valid_sftp_path(path:&str)->bool{
    !path.is_empty() && path.len()<=4096 && !path.as_bytes().contains(&0)
}

#[tauri::command]
pub async fn ssh_session_sftp_download(
    id:String,path:String,transfer_id:String,manager:State<'_,SshSessionManager>,app:AppHandle
)->Result<Option<String>,String>{
    if !valid_sftp_path(&path){return Err("Invalid remote download path".into());}
    if !valid_transfer_id(&transfer_id){return Err("Invalid transfer ID".into());}
    let remote_name=path.rsplit('/').next().unwrap_or("");
    if !safe_sftp_filename(remote_name){return Err("Select a regular file to download".into());}
    let sender=manager.sender(&id)?;
    let (selected_tx,selected_rx)=tokio::sync::oneshot::channel();
    app.dialog().file().set_file_name(remote_name).save_file(move |selection|{
        let _=selected_tx.send(selection);
    });
    let selected=selected_rx.await.map_err(|_|"Save dialog did not respond")?;
    let Some(selected)=selected else{return Ok(None)};
    let destination=selected.into_path().map_err(|_|"Only local filesystem destinations are supported")?;
    let file_label=destination.file_name().and_then(|s|s.to_str()).unwrap_or("file").to_owned();
    let (tx,rx)=tokio::sync::oneshot::channel();
    sender.send(SessionCommand::SftpDownload(transfer_id,path,destination,tx)).await
        .map_err(|_|"SSH connection closed before download")?;
    let bytes=rx.await.map_err(|_|"Download interrupted by SSH disconnection")??;
    Ok(Some(format!("Downloaded {bytes} bytes to {file_label}")))
}

#[tauri::command]
pub async fn ssh_session_sftp_upload(
    id:String,directory:String,transfer_id:String,manager:State<'_,SshSessionManager>,app:AppHandle
)->Result<Option<String>,String>{
    if !valid_sftp_path(&directory){return Err("Invalid destination directory".into());}
    if !valid_transfer_id(&transfer_id){return Err("Invalid transfer ID".into());}
    let sender=manager.sender(&id)?;
    let (selected_tx,selected_rx)=tokio::sync::oneshot::channel();
    app.dialog().file().pick_file(move |selection|{let _=selected_tx.send(selection);});
    let selected=selected_rx.await.map_err(|_|"Open file dialog did not respond")?;
    let Some(selected)=selected else{return Ok(None)};
    let source=selected.into_path().map_err(|_|"Only local filesystem uploads are supported")?;
    let file_label=source.file_name().and_then(|s|s.to_str())
        .ok_or("Selected local filename is invalid UTF-8")?.to_owned();
    if !safe_sftp_filename(&file_label){return Err("Selected local filename is not safe for upload".into());}
    let (tx,rx)=tokio::sync::oneshot::channel();
    sender.send(SessionCommand::SftpUpload(transfer_id,directory,source,tx)).await
        .map_err(|_|"SSH connection closed before upload")?;
    let bytes=rx.await.map_err(|_|"Upload interrupted by SSH disconnection")??;
    Ok(Some(format!("Uploaded {bytes} bytes as {file_label}")))
}

#[tauri::command]
pub async fn ssh_session_sftp_cancel(id:String,transfer_id:String,
    manager:State<'_,SshSessionManager>)->Result<(),String>{
    if !valid_transfer_id(&transfer_id){return Err("Invalid transfer ID".into());}
    let (tx,rx)=tokio::sync::oneshot::channel();
    manager.sender(&id)?.send(SessionCommand::SftpCancel(transfer_id,tx)).await
        .map_err(|_|"SSH session closed")?;
    rx.await.map_err(|_|"SFTP cancellation request interrupted".to_owned())?
}

#[cfg(test)]
mod vault_batch_tests{
    use super::*;
    fn target(alias:&str,id:&str)->VaultBatchTarget{
        VaultBatchTarget{id:id.into(),alias:alias.into(),directory:"/srv/backup".into()}
    }
    #[test]
    fn rejects_empty_duplicate_and_untrusted_batch_fields(){
        assert!(validate_vault_batch_targets(&[]).is_err());
        assert!(validate_vault_batch_targets(&[target("a","s1"),target("b","s1")]).is_err());
        let mut invalid=target("x","s1");
        invalid.directory="bad\npath".into();
        assert!(validate_vault_batch_targets(&[invalid]).is_err());
        assert!(validate_vault_batch_targets(&[target("a","s1"),target("b","s2")]).is_ok());
    }
}

#[cfg(test)]
mod transfer_tests{
    use super::*;
    #[test]
    fn rejects_unsafe_transfer_tokens(){
        assert!(valid_transfer_id("eb80cd3d-78b0-4d2c-a7ce-72baaad9e7ae"));
        for token in ["","../../bad","id;rm -rf","short","with spaces"]{
            assert!(!valid_transfer_id(token));
        }
    }
    #[tokio::test]
    async fn download_publish_never_replaces_an_existing_file(){
        let folder=std::env::temp_dir().join(format!("passh7-download-{}-{}",
            std::process::id(),NEXT_ID.fetch_add(1,Ordering::Relaxed)));
        tokio::fs::create_dir(&folder).await.unwrap();
        let stage=folder.join("stage.part");
        let target=folder.join("output.bin");
        tokio::fs::write(&stage,b"new").await.unwrap();
        tokio::fs::write(&target,b"old").await.unwrap();
        assert!(publish_download_exclusive(&stage,&target).await.is_err());
        assert_eq!(tokio::fs::read(&target).await.unwrap(),b"old");
        tokio::fs::remove_file(&target).await.unwrap();
        publish_download_exclusive(&stage,&target).await.unwrap();
        assert_eq!(tokio::fs::read(&target).await.unwrap(),b"new");
        assert!(!tokio::fs::try_exists(&stage).await.unwrap());
        tokio::fs::remove_dir_all(folder).await.unwrap();
    }
    #[tokio::test]
    async fn concurrent_download_publish_allows_only_one_winner(){
        let folder=std::env::temp_dir().join(format!("passh7-publish-race-{}-{}",
            std::process::id(),NEXT_ID.fetch_add(1,Ordering::Relaxed)));
        tokio::fs::create_dir(&folder).await.unwrap();
        let a=folder.join("first.part");
        let b=folder.join("second.part");
        let output=folder.join("final.bin");
        tokio::fs::write(&a,b"first").await.unwrap();
        tokio::fs::write(&b,b"second").await.unwrap();
        let (one,two)=tokio::join!(
            publish_download_exclusive(&a,&output),
            publish_download_exclusive(&b,&output)
        );
        assert_ne!(one.is_ok(),two.is_ok(),"exactly one download must publish");
        let content=tokio::fs::read(&output).await.unwrap();
        assert!(content==b"first" || content==b"second");
        tokio::fs::remove_dir_all(folder).await.unwrap();
    }
    #[test]
    fn denies_remote_path_separator_and_dot_filename(){
        for name in ["","..",".","a/b","a\\b","bad\0name"]{
            assert!(!safe_sftp_filename(name));
        }
        assert!(safe_sftp_filename("report 2026.zip"));
        assert_eq!(join_sftp_path("/home/ubuntu/","result.bin"),"/home/ubuntu/result.bin");
        assert_eq!(join_sftp_path(".","file.txt"),"./file.txt");
    }
}

#[tauri::command]
pub async fn ssh_session_forward_start(id:String,local_port:u16,target_host:String,remote_port:u16,manager:State<'_,SshSessionManager>)->Result<(),String>{
    if local_port==0 || remote_port==0 {return Err("Ports must be between 1 and 65535".into());}
    if target_host.trim().is_empty() || target_host.len()>253 || target_host.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err("Enter a valid remote host (hostname or IP)".into());
    }
    let (tx,rx)=tokio::sync::oneshot::channel();
    manager.sender(&id)?.send(SessionCommand::ForwardStart(local_port,target_host,remote_port,tx)).await
        .map_err(|_|"SSH connection has closed".to_owned())?;
    rx.await.map_err(|_|"Port forwarding request cancelled".to_owned())?
}

#[tauri::command]
pub async fn ssh_session_forward_list(id:String,manager:State<'_,SshSessionManager>)
    ->Result<Vec<ActiveLocalForward>,String>{
    let (tx,rx)=tokio::sync::oneshot::channel();
    manager.sender(&id)?.send(SessionCommand::ForwardList(tx)).await
        .map_err(|_|"SSH connection has closed".to_owned())?;
    rx.await.map_err(|_|"Port forwarding inventory cancelled".to_owned())
}

#[tauri::command]
pub async fn ssh_session_forward_stop(id:String,local_port:u16,manager:State<'_,SshSessionManager>)->Result<(),String>{
    let (tx,rx)=tokio::sync::oneshot::channel();
    manager.sender(&id)?.send(SessionCommand::ForwardStop(local_port,tx)).await
        .map_err(|_|"SSH connection has closed".to_owned())?;
    rx.await.map_err(|_|"Port forwarding stop cancelled".to_owned())?
}

#[tauri::command]
pub async fn ssh_session_ready(id: String, manager: State<'_, SshSessionManager>) -> Result<(), String> {
    manager.sender(&id)?.send(SessionCommand::Ready).await
        .map_err(|_| "SSH session already closed".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mutation_names_are_single_safe_path_components(){
        for name in ["","..",".","foo/bar","foo\\\\bar","line\\nfeed","x\\0y"]{
            let actual=name.replace("\\\\n","\\n").replace("\\\\0","\\0");
            assert!(!safe_sftp_filename(&actual), "{name:?} must not be a filename");
        }
        assert!(safe_sftp_filename(".env"));
        assert!(safe_sftp_filename("new folder"));
        assert_eq!(join_sftp_path("/home/test/","sub"),"/home/test/sub");
    }

    #[test]
    fn agent_probe_rejects_arbitrary_shell_commands(){
        assert_eq!(allowed_agent_binary("codex"),Some("codex"));
        assert_eq!(allowed_agent_binary("claude"),Some("claude"));
        assert_eq!(allowed_agent_binary("opencode"),Some("opencode"));
        for injection in ["codex;reboot","../../../bin/bash","cmd.exe","", "codex --yolo"]{
            assert_eq!(allowed_agent_binary(injection),None);
        }
    }

    #[test]
    fn docker_control_actions_are_allowlisted(){
        for action in ["start","stop","restart"]{assert!(valid_docker_action(action));}
        for action in ["rm","exec","--help","start;id",""]{assert!(!valid_docker_action(action));}
        assert!(!valid_docker_container_id("deadbeef0123; reboot"));
    }

    #[test]
    fn docker_log_requests_reject_shell_injection() {
        assert!(valid_docker_container_id("0123456789ab"));
        assert!(valid_docker_container_id("abcdef0123456789abcdef0123456789"));
        assert!(!valid_docker_container_id("some-container"));
        assert!(!valid_docker_container_id("0123456789ab;cat /etc/shadow"));
        assert!(!valid_docker_container_id("--help"));
        assert!(!valid_docker_container_id(""));
    }

    #[test]
    fn vault_lock_invalidates_inflight_connection_generation() {
        let manager = SshSessionManager::default();
        let before = manager.generation.load(Ordering::SeqCst);
        manager.stop_all();
        assert_ne!(before, manager.generation.load(Ordering::SeqCst));
    }

    #[test]
    fn host_removal_only_cancels_its_own_sessions() {
        let manager = SshSessionManager::default();
        let (tx_a, _) = mpsc::channel(1);
        let (cancel_a, watch_a) = tokio::sync::watch::channel(false);
        let (tx_b, _) = mpsc::channel(1);
        let (cancel_b, watch_b) = tokio::sync::watch::channel(false);
        let mut guard = manager.channels.lock().unwrap();
        let (input_a,_) = mpsc::channel(1);
        let (input_b,_) = mpsc::channel(1);
        guard.insert("ssh-1".into(), ManagedSession {
            alias: "host-a".into(), sender: tx_a, input_sender: input_a, cancel: cancel_a
        });
        guard.insert("ssh-2".into(), ManagedSession {
            alias: "host-b".into(), sender: tx_b, input_sender: input_b, cancel: cancel_b
        });
        drop(guard);
        assert_eq!(manager.active_sessions().unwrap().len(), 2);
        manager.stop_host("host-a");
        assert!(*watch_a.borrow());
        assert!(!*watch_b.borrow());
        let remaining = manager.active_sessions().unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].alias, "host-b");
    }

    #[test]
    fn terminal_input_has_priority_lane_independent_of_blocked_tool_queue(){
        let manager=SshSessionManager::default();
        let (commands,_unread_commands)=mpsc::channel(1);
        commands.try_send(SessionCommand::Ready).unwrap();
        let (input,mut read_input)=mpsc::channel(2);
        let (cancel,_cancel_receiver)=tokio::sync::watch::channel(false);
        manager.channels.lock().unwrap().insert("ssh-keyboard".into(),ManagedSession{
            alias:"low-latency".into(),sender:commands,input_sender:input,cancel
        });
        manager.input_sender("ssh-keyboard").unwrap().try_send(b"hello".to_vec()).unwrap();
        assert_eq!(read_input.try_recv().unwrap(),b"hello");
    }

    #[test]
    fn vault_lock_cancels_sessions_even_with_full_input_queues() {
        let manager = SshSessionManager::default();
        let (tx, _rx) = mpsc::channel(1);
        let (input, _input_rx) = mpsc::channel(1);
        assert!(input.try_send(vec![b'x']).is_ok());
        let (cancel, receiver) = tokio::sync::watch::channel(false);
        manager.channels.lock().unwrap().insert("test".into(), ManagedSession {
            alias: "primary".into(), sender: tx, input_sender: input, cancel
        });
        manager.stop_all();
        assert!(*receiver.borrow(), "vault lock must signal cancellation");
        assert!(manager.input_sender("test").is_err(), "closed sessions must not accept input");
    }
}
