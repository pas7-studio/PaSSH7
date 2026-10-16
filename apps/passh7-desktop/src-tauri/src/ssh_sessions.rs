use std::{collections::HashMap, path::PathBuf, sync::{atomic::{AtomicU64, Ordering}, Arc, Mutex}, time::Duration};
use serde::Serialize;
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
    cancel: tokio::sync::watch::Sender<bool>,
}

enum SessionCommand {
    Ready,
    Input(Vec<u8>),
    Resize(u32, u32),
    Close,
    DockerList(tokio::sync::oneshot::Sender<Result<String,String>>),
    DockerLogs(String,tokio::sync::oneshot::Sender<Result<String,String>>),
    DockerAction(String,String,tokio::sync::oneshot::Sender<Result<String,String>>),
    SftpList(String, tokio::sync::oneshot::Sender<Result<Vec<SftpEntry>,String>>),
    SftpRead(String, tokio::sync::oneshot::Sender<Result<String,String>>),
    SftpDownload(String, String, PathBuf, tokio::sync::oneshot::Sender<Result<u64,String>>),
    SftpUpload(String, String, PathBuf, tokio::sync::oneshot::Sender<Result<u64,String>>),
    SftpCancel(String, tokio::sync::oneshot::Sender<Result<(),String>>),
    SftpFinished(String),
    ForwardStart(u16,String,u16,tokio::sync::oneshot::Sender<Result<(),String>>),
    ForwardStop(u16,tokio::sync::oneshot::Sender<Result<(),String>>),
    ForwardOpen(tokio::net::TcpStream,String,u16),
}

#[derive(Clone, Serialize)]
#[serde(rename_all="camelCase")]
pub struct SftpEntry { pub name: String, pub is_dir: bool }

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
        let identity = data.identities.iter().find(|i| i.alias == host.identity_alias)
            .ok_or_else(|| "SSH identity missing".to_owned())?;
        let saved = if use_saved_credentials.unwrap_or(false) {
            host.extensions.get("passh7_saved_auth").filter(|v| v.get("mode").and_then(|m| m.as_str()) == Some(auth_mode))
        } else { None };
        let saved_account = zeroize::Zeroizing::new(saved.and_then(|v| v.get("account_password")).and_then(|v| v.as_str()).unwrap_or_default().to_owned());
        let saved_key = zeroize::Zeroizing::new(saved.and_then(|v| v.get("key_passphrase")).and_then(|v| v.as_str()).unwrap_or_default().to_owned());
        Ok((host, zeroize::Zeroizing::new(identity.private_key_pem.clone()), saved_account, saved_key))
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
        Some(russh::keys::decode_secret_key(&secret, if key_passphrase.is_empty() { None } else { Some(key_passphrase.as_str()) })
            .map_err(|_| "Cannot unlock SSH private key. Enter its key passphrase, or verify the imported key.".to_owned())?)
    } else { None };
    let config = std::sync::Arc::new(russh::client::Config {
        inactivity_timeout: Some(Duration::from_secs(600)), ..Default::default()
    });
    let mut connection = tokio_timeout_connect(config,
        (host.hostname.as_str(), host.port),
        PinnedSshClient { expected_pin: pin }).await?;

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
    let forward_sender = tx.clone();
    let (cancel_tx, mut cancelled) = tokio::sync::watch::channel(false);
    {
        let mut sessions = manager.channels.lock().map_err(|_| "Session manager unavailable".to_owned())?;
        if manager.generation.load(Ordering::SeqCst) != generation {
            return Err("Vault was locked during SSH connection".into());
        }
        sessions.insert(id.clone(), ManagedSession { alias: alias.clone(), sender: tx, cancel: cancel_tx });
    }
    let cleanup_id = id.clone();
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn(async move {
        let mut ready = false;
        let mut backlog: Vec<Vec<u8>> = Vec::new();
        let mut buffered = 0usize;
        let mut overflowed = false;
        let mut closure_detail: Option<String> = None;
        let mut forwarders: HashMap<u16,tokio::sync::oneshot::Sender<()>> = HashMap::new();
        let mut transfers: HashMap<String,tokio::sync::watch::Sender<bool>> = HashMap::new();
        loop {
            tokio::select! {
                changed = cancelled.changed() => {
                    if changed.is_err() || *cancelled.borrow() {
                        closure_detail = Some("SSH session terminated: vault locked or host removed".into());
                        break;
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
                        Some(SessionCommand::Input(bytes)) => channel.data_bytes(bytes).await,
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
                            // Runs on a separate session channel; command is fixed by native code,
                            // never constructed from untrusted renderer arguments.
                            let listed = tokio::time::timeout(Duration::from_secs(20), async {
                                let mut cmd = connection.channel_open_session().await
                                    .map_err(|_| "Could not open remote command channel")?;
                                cmd.exec(true, b"docker ps -a --format \"{{json .}}\"").await
                                    .map_err(|_| "Docker command was rejected by the SSH server")?;
                                let mut output = Vec::new();
                                let mut exit_status = None;
                                while let Some(message) = cmd.wait().await {
                                    match message {
                                        russh::ChannelMsg::Data { data } | russh::ChannelMsg::ExtendedData { data, .. } => {
                                            if output.len().saturating_add(data.len()) > 2 * 1024 * 1024 {
                                                return Err("Docker response exceeds 2 MiB".to_owned());
                                            }
                                            output.extend_from_slice(&data);
                                        }
                                        russh::ChannelMsg::ExitStatus { exit_status: code } => exit_status = Some(code),
                                        russh::ChannelMsg::Close => break,
                                        _ => {}
                                    }
                                }
                                let result = String::from_utf8_lossy(&output).into_owned();
                                if exit_status.unwrap_or(1) != 0 {
                                    return Err(format!("Docker listing failed: {}", result.chars().take(500).collect::<String>()));
                                }
                                Ok(result)
                            }).await.unwrap_or_else(|_| Err("Docker listing timed out after 20 seconds".to_owned()));
                            let _ = response.send(listed);
                            Ok(())
                        },
                        Some(SessionCommand::DockerLogs(container_id,response)) => {
                            // The native IPC command only accepts a Docker hex ID.
                            // No shell metacharacters or arbitrary commands can be supplied.
                            let result = tokio::time::timeout(Duration::from_secs(20), async {
                                let mut cmd = connection.channel_open_session().await
                                    .map_err(|_| "Could not open Docker log channel".to_owned())?;
                                let command = format!("docker logs --tail 200 --timestamps {container_id}");
                                cmd.exec(true, command.as_bytes()).await
                                    .map_err(|_| "SSH server rejected Docker log request".to_owned())?;
                                let mut output = Vec::new();
                                let mut exit_status = None;
                                while let Some(message) = cmd.wait().await {
                                    match message {
                                        russh::ChannelMsg::Data { data } | russh::ChannelMsg::ExtendedData { data, .. } => {
                                            if output.len().saturating_add(data.len()) > 512 * 1024 {
                                                return Err("Docker log exceeds 512 KiB. Narrow the output in the SSH terminal.".to_owned());
                                            }
                                            output.extend_from_slice(&data);
                                        },
                                        russh::ChannelMsg::ExitStatus { exit_status: code } => exit_status = Some(code),
                                        russh::ChannelMsg::Close => break,
                                        _ => {}
                                    }
                                }
                                let result = String::from_utf8_lossy(&output).into_owned();
                                if exit_status.unwrap_or(1) != 0 {
                                    return Err(format!("Docker logs failed: {}",result.chars().take(500).collect::<String>()));
                                }
                                Ok(result)
                            }).await.unwrap_or_else(|_|Err("Docker logs timed out after 20 seconds".to_owned()));
                            let _=response.send(result);
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
                        Some(SessionCommand::SftpList(path, response)) => {
                            let result = tokio::time::timeout(Duration::from_secs(20), async {
                                let channel = connection.channel_open_session().await
                                    .map_err(|e| format!("SFTP channel could not open: {e}"))?;
                                channel.request_subsystem(true, "sftp").await
                                    .map_err(|e| format!("SFTP subsystem refused: {e}"))?;
                                let sftp = russh_sftp::client::SftpSession::new(channel.into_stream()).await
                                    .map_err(|e| format!("SFTP initialization failed: {e}"))?;
                                let entries = sftp.read_dir(path).await
                                    .map_err(|e| format!("SFTP folder could not be read: {e}"))?;
                                let mut result = Vec::new();
                                for entry in entries {
                                    if result.len() >= 2000 { break; }
                                    let name = entry.file_name();
                                    if name == "." || name == ".." { continue; }
                                    result.push(SftpEntry {
                                        name,
                                        is_dir: entry.metadata().is_dir(),
                                    });
                                }
                                result.sort_by(|a,b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
                                Ok::<_, String>(result)
                            }).await.unwrap_or_else(|_| Err("SFTP listing timed out after 20 seconds".to_owned()));
                            let _ = response.send(result);
                            Ok(())
                        },
                        Some(SessionCommand::SftpRead(path,response)) => {
                            let result=tokio::time::timeout(Duration::from_secs(20), async {
                                use tokio::io::AsyncReadExt;
                                let channel=connection.channel_open_session().await
                                    .map_err(|e|format!("Could not open SFTP channel: {e}"))?;
                                channel.request_subsystem(true,"sftp").await
                                    .map_err(|e|format!("SFTP subsystem unavailable: {e}"))?;
                                let sftp=russh_sftp::client::SftpSession::new(channel.into_stream()).await
                                    .map_err(|e|format!("SFTP initialization failed: {e}"))?;
                                let mut file=sftp.open(path).await.map_err(|e|format!("Cannot open remote file: {e}"))?;
                                const MAX:u64=262_144;
                                let mut bytes=Vec::new();
                                (&mut file).take(MAX+1).read_to_end(&mut bytes).await
                                    .map_err(|e|format!("Cannot read remote file: {e}"))?;
                                if bytes.len()>MAX as usize { return Err("File too large for preview (256 KiB limit)".to_owned()); }
                                if bytes.contains(&0) { return Err("Binary file cannot be previewed as text".to_owned()); }
                                String::from_utf8(bytes).map_err(|_|"Text preview requires UTF-8; use the terminal or a binary transfer tool".to_owned())
                            }).await.unwrap_or_else(|_|Err("SFTP preview timed out after 20 seconds".to_owned()));
                            let _=response.send(result);
                            Ok(())
                        },
                        Some(SessionCommand::SftpDownload(path,destination,response)) => {
                            // Open the subsystem on the authenticated connection, then move
                            // its independent channel into a task. Large file I/O must not
                            // block the PTY event loop or other session commands.
                            let opened=tokio::time::timeout(Duration::from_secs(15), async {
                                let ch=connection.channel_open_session().await
                                    .map_err(|e|format!("SFTP download channel failed: {e}"))?;
                                ch.request_subsystem(true,"sftp").await
                                    .map_err(|e|format!("SFTP subsystem unavailable: {e}"))?;
                                Ok::<_,String>(ch.into_stream())
                            }).await.unwrap_or_else(|_|Err("SFTP channel open timed out".into()));
                            match opened {
                                Err(error) => {let _=response.send(Err(error));},
                                Ok(stream) => {
                                    let mut abort=cancelled.clone();
                                    tauri::async_runtime::spawn(async move {
                                        use tokio::io::{AsyncReadExt,AsyncWriteExt};
                                        let local_name=destination.file_name().and_then(|s|s.to_str()).unwrap_or("download");
                                        let staging=destination.with_file_name(format!(
                                            ".{local_name}.passh7-{}.part",NEXT_ID.fetch_add(1, Ordering::Relaxed)
                                        ));
                                        let transfer=async {
                                            let sftp=russh_sftp::client::SftpSession::new(stream).await
                                                .map_err(|e|format!("SFTP initialization failed: {e}"))?;
                                            let remote=sftp.open(path).await
                                                .map_err(|e|format!("Cannot open remote file: {e}"))?;
                                            let mut local=tokio::fs::OpenOptions::new()
                                                .write(true).create_new(true).open(&staging).await
                                                .map_err(|e|format!("Cannot create temporary download: {e}"))?;
                                            let size=tokio::io::copy(&mut remote.take(MAX_TRANSFER+1),&mut local).await
                                                .map_err(|e|format!("SFTP download failed: {e}"))?;
                                            if size>MAX_TRANSFER{return Err("Download exceeds 64 MiB limit".into());}
                                            local.flush().await.map_err(|e|format!("Cannot flush download: {e}"))?;
                                            local.sync_all().await.map_err(|e|format!("Cannot sync download: {e}"))?;
                                            drop(local);
                                            if tokio::fs::try_exists(&destination).await.unwrap_or(true) {
                                                return Err("Local file already exists; select a new name".into());
                                            }
                                            tokio::fs::rename(&staging,&destination).await
                                                .map_err(|e|format!("Cannot save completed download: {e}"))?;
                                            Ok::<u64,String>(size)
                                        };
                                        let result=tokio::select! {
                                            changed=abort.changed() => {let _=changed;Err("Download cancelled by SSH disconnect or vault lock".into())},
                                            result=tokio::time::timeout(Duration::from_secs(90),transfer) =>
                                                result.unwrap_or_else(|_|Err("Download timed out after 90 seconds".into()))
                                        };
                                        if result.is_err(){let _=tokio::fs::remove_file(&staging).await;}
                                        let _=response.send(result);
                                    });
                                }
                            }
                            Ok(())
                        },
                        Some(SessionCommand::SftpUpload(directory,source,response)) => {
                            let opened=tokio::time::timeout(Duration::from_secs(15),async {
                                let ch=connection.channel_open_session().await
                                    .map_err(|e|format!("SFTP upload channel failed: {e}"))?;
                                ch.request_subsystem(true,"sftp").await
                                    .map_err(|e|format!("SFTP subsystem unavailable: {e}"))?;
                                Ok::<_,String>(ch.into_stream())
                            }).await.unwrap_or_else(|_|Err("SFTP channel open timed out".into()));
                            match opened {
                                Err(error)=>{let _=response.send(Err(error));},
                                Ok(stream)=>{
                                    let mut abort=cancelled.clone();
                                    tauri::async_runtime::spawn(async move {
                                        use tokio::io::{AsyncReadExt,AsyncWriteExt};
                                        let result=async {
                                            let size=tokio::fs::metadata(&source).await
                                                .map_err(|e|format!("Cannot read local file metadata: {e}"))?;
                                            if !size.is_file(){return Err("Selected path is not a file".into());}
                                            if size.len()>MAX_TRANSFER{return Err("Upload exceeds 64 MiB limit".into());}
                                            let filename=source.file_name().and_then(|n|n.to_str())
                                                .ok_or("Local filename is not UTF-8")?;
                                            if !safe_sftp_filename(filename){return Err("Unsafe filename".into());}
                                            let remote_path=join_sftp_path(&directory,filename);
                                            let sftp=russh_sftp::client::SftpSession::new(stream).await
                                                .map_err(|e|format!("SFTP initialization failed: {e}"))?;
                                            let mut local=tokio::fs::File::open(&source).await
                                                .map_err(|e|format!("Cannot open local file: {e}"))?;
                                            let mut remote=sftp.open_with_flags(remote_path.clone(),
                                                russh_sftp::protocol::OpenFlags::CREATE |
                                                russh_sftp::protocol::OpenFlags::EXCLUDE |
                                                russh_sftp::protocol::OpenFlags::WRITE
                                            ).await.map_err(|e|format!("Cannot create new remote file (perhaps already exists): {e}"))?;
                                            let outcome=tokio::select!{
                                                changed=abort.changed() => {let _=changed;Err("Upload cancelled by SSH disconnect or vault lock".to_owned())},
                                                output=tokio::time::timeout(Duration::from_secs(90),async {
                                                    let copied=tokio::io::copy(&mut local.take(MAX_TRANSFER+1),&mut remote).await
                                                        .map_err(|e|format!("SFTP upload failed: {e}"))?;
                                                    if copied>MAX_TRANSFER{return Err("Upload exceeds 64 MiB limit".into());}
                                                    remote.flush().await.map_err(|e|format!("Remote flush failed: {e}"))?;
                                                    remote.shutdown().await.map_err(|e|format!("Remote close failed: {e}"))?;
                                                    Ok::<u64,String>(copied)
                                                })=>output.unwrap_or_else(|_|Err("Upload timed out after 90 seconds".into()))
                                            };
                                            drop(remote);
                                            if outcome.is_err(){
                                                // Attempt to remove a partially-created remote file.
                                                // A lost network connection can prevent cleanup.
                                                let _=tokio::time::timeout(Duration::from_secs(5),sftp.remove_file(remote_path)).await;
                                            }
                                            outcome
                                        }.await;
                                        let _=response.send(result);
                                    });
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
                                        forwarders.insert(local_port,stop_tx);
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
                            if let Some(cancel)=forwarders.remove(&local_port){
                                let _ = cancel.send(());
                                let _ = response.send(Ok(()));
                            }else{
                                let _ = response.send(Err("No active local forwarding on this port".into()));
                            }
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
        for (_,stop) in forwarders.drain() { let _=stop.send(()); }
        for (_,cancel) in transfers.drain() { let _=cancel.send(true); }
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
    manager.sender(&id)?.send(SessionCommand::Input(data.into_bytes())).await
        .map_err(|_| "SSH session closed".to_owned())
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
pub async fn ssh_session_docker_logs(id: String, container_id: String, manager: State<'_, SshSessionManager>) -> Result<String, String> {
    if !valid_docker_container_id(&container_id) {
        return Err("Invalid Docker container ID: use the hex ID from the inventory".into());
    }
    let (tx,rx)=tokio::sync::oneshot::channel();
    manager.sender(&id)?.send(SessionCommand::DockerLogs(container_id,tx)).await
        .map_err(|_|"SSH session closed".to_owned())?;
    rx.await.map_err(|_|"Docker logs request was cancelled".to_owned())?
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
    id:String,path:String,manager:State<'_,SshSessionManager>,app:AppHandle
)->Result<Option<String>,String>{
    if !valid_sftp_path(&path){return Err("Invalid remote download path".into());}
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
    sender.send(SessionCommand::SftpDownload(path,destination,tx)).await
        .map_err(|_|"SSH connection closed before download")?;
    let bytes=rx.await.map_err(|_|"Download interrupted by SSH disconnection")??;
    Ok(Some(format!("Downloaded {bytes} bytes to {file_label}")))
}

#[tauri::command]
pub async fn ssh_session_sftp_upload(
    id:String,directory:String,manager:State<'_,SshSessionManager>,app:AppHandle
)->Result<Option<String>,String>{
    if !valid_sftp_path(&directory){return Err("Invalid destination directory".into());}
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
    sender.send(SessionCommand::SftpUpload(directory,source,tx)).await
        .map_err(|_|"SSH connection closed before upload")?;
    let bytes=rx.await.map_err(|_|"Upload interrupted by SSH disconnection")??;
    Ok(Some(format!("Uploaded {bytes} bytes as {file_label}")))
}

#[cfg(test)]
mod transfer_tests{
    use super::*;
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
        guard.insert("ssh-1".into(), ManagedSession {
            alias: "host-a".into(), sender: tx_a, cancel: cancel_a
        });
        guard.insert("ssh-2".into(), ManagedSession {
            alias: "host-b".into(), sender: tx_b, cancel: cancel_b
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
    fn vault_lock_cancels_sessions_even_with_full_input_queues() {
        let manager = SshSessionManager::default();
        let (tx, _rx) = mpsc::channel(1);
        assert!(tx.try_send(SessionCommand::Input(vec![b'x'])).is_ok());
        let (cancel, receiver) = tokio::sync::watch::channel(false);
        manager.channels.lock().unwrap().insert("test".into(), ManagedSession {
            alias: "primary".into(), sender: tx, cancel
        });
        manager.stop_all();
        assert!(*receiver.borrow(), "vault lock must signal cancellation");
        assert!(manager.sender("test").is_err(), "closed sessions must not accept input");
    }
}
