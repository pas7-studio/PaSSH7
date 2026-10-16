use std::{collections::HashMap, sync::{atomic::{AtomicU64, Ordering}, Arc, Mutex}, time::Duration};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::mpsc;
use base64::{engine::general_purpose::STANDARD, Engine as _};

use crate::{SessionStore, PinnedSshClient, safe_err, vault_path, tokio_timeout_connect};

static NEXT_ID: AtomicU64 = AtomicU64::new(1);
const EVENT: &str = "passh7:ssh-session";

#[derive(Default, Clone)]
pub struct SshSessionManager {
    channels: Arc<Mutex<HashMap<String, (mpsc::Sender<SessionCommand>, tokio::sync::watch::Sender<bool>)>>>,
    generation: Arc<AtomicU64>,
}

enum SessionCommand {
    Ready,
    Input(Vec<u8>),
    Resize(u32, u32),
    Close,
    DockerList(tokio::sync::oneshot::Sender<Result<String,String>>),
    SftpList(String, tokio::sync::oneshot::Sender<Result<Vec<SftpEntry>,String>>),
    ForwardStart(u16,String,u16,tokio::sync::oneshot::Sender<Result<(),String>>),
    ForwardStop(u16,tokio::sync::oneshot::Sender<Result<(),String>>),
    ForwardOpen(tokio::net::TcpStream,String,u16),
}

#[derive(Clone, Serialize)]
#[serde(rename_all="camelCase")]
pub struct SftpEntry { pub name: String, pub is_dir: bool }

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionEvent {
    pub id: String,
    pub kind: &'static str,
    pub data: Option<String>,
    pub detail: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedSession { pub id: String, pub alias: String }

impl SshSessionManager {
    pub fn stop_all(&self) {
        if let Ok(mut guard) = self.channels.lock() {
            self.generation.fetch_add(1, Ordering::SeqCst);
            for (_, (_, cancel)) in guard.drain() {
                let _ = cancel.send(true);
            }
        }
    }

    fn sender(&self, id: &str) -> Result<mpsc::Sender<SessionCommand>, String> {
        self.channels.lock().map_err(|_| "Session manager unavailable".to_owned())?
            .get(id).map(|(tx, _)| tx.clone()).ok_or_else(|| "SSH session no longer exists".to_owned())
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
        sessions.insert(id.clone(), (tx, cancel_tx));
    }
    let cleanup_id = id.clone();
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn(async move {
        let mut ready = false;
        let mut backlog: Vec<Vec<u8>> = Vec::new();
        let mut buffered = 0usize;
        let mut overflowed = false;
        let mut forwarders: HashMap<u16,tokio::sync::oneshot::Sender<()>> = HashMap::new();
        loop {
            tokio::select! {
                changed = cancelled.changed() => {
                    if changed.is_err() || *cancelled.borrow() { break; }
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
                        Some(SessionCommand::Close) | None => break,
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
                        Some(russh::ChannelMsg::Close) | None => break,
                        _ => {}
                    }
                }
            }
        }
        for (_,stop) in forwarders.drain() { let _=stop.send(()); }
        let _ = channel.close().await;
        let _ = connection.disconnect(russh::Disconnect::ByApplication, "Session closed", "en").await;
        if let Ok(mut guard) = manager.channels.lock() { guard.remove(&cleanup_id); }
        let _ = app.emit(EVENT, SessionEvent { id: cleanup_id, kind: "closed", data: None, detail: None });
    });
    Ok(OpenedSession { id, alias })
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

#[tauri::command]
pub async fn ssh_session_sftp_list(id: String, path: String, manager: State<'_, SshSessionManager>) -> Result<Vec<SftpEntry>, String> {
    if path.len()>4096 || path.as_bytes().contains(&0) { return Err("Invalid SFTP directory path".into()); }
    let (tx,rx)=tokio::sync::oneshot::channel();
    manager.sender(&id)?.send(SessionCommand::SftpList(path,tx)).await
        .map_err(|_| "SSH connection has closed".to_owned())?;
    rx.await.map_err(|_| "SFTP listing cancelled".to_owned())?
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
    fn vault_lock_invalidates_inflight_connection_generation() {
        let manager = SshSessionManager::default();
        let before = manager.generation.load(Ordering::SeqCst);
        manager.stop_all();
        assert_ne!(before, manager.generation.load(Ordering::SeqCst));
    }

    #[test]
    fn vault_lock_cancels_sessions_even_with_full_input_queues() {
        let manager = SshSessionManager::default();
        let (tx, _rx) = mpsc::channel(1);
        assert!(tx.try_send(SessionCommand::Input(vec![b'x'])).is_ok());
        let (cancel, receiver) = tokio::sync::watch::channel(false);
        manager.channels.lock().unwrap().insert("test".into(), (tx, cancel));
        manager.stop_all();
        assert!(*receiver.borrow(), "vault lock must signal cancellation");
        assert!(manager.sender("test").is_err(), "closed sessions must not accept input");
    }
}
