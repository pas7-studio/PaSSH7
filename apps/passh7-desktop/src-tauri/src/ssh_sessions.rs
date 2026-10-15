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
}

enum SessionCommand {
    Ready,
    Input(Vec<u8>),
    Resize(u32, u32),
    Close,
}

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
pub async fn ssh_session_open(alias: String, cols: u32, rows: u32,
    vault: State<'_, SessionStore>, manager: State<'_, SshSessionManager>, app: AppHandle
) -> Result<OpenedSession, String> {
    if !(20..=500).contains(&cols) || !(5..=200).contains(&rows) {
        return Err("Invalid PTY dimensions".into());
    }
    let (host, secret) = vault.use_password(|password| {
        let data = passh7_core::load(&vault_path()?, password).map_err(safe_err)?;
        let host = data.hosts.iter().find(|h| h.alias == alias)
            .ok_or_else(|| "Host not found".to_owned())?.clone();
        let identity = data.identities.iter().find(|i| i.alias == host.identity_alias)
            .ok_or_else(|| "SSH identity missing".to_owned())?;
        Ok((host, zeroize::Zeroizing::new(identity.private_key_pem.clone())))
    })?;
    let pin = host.pinned_host_key.clone().ok_or("Host key is not pinned")?;
    passh7_core::hostkey::validate_fingerprint(&pin).map_err(safe_err)?;
    let key = russh::keys::decode_secret_key(&secret, None)
        .map_err(|_| "SSH key cannot be decoded or requires a passphrase".to_owned())?;
    let config = std::sync::Arc::new(russh::client::Config {
        inactivity_timeout: Some(Duration::from_secs(600)), ..Default::default()
    });
    let mut connection = tokio_timeout_connect(config,
        (host.hostname.as_str(), host.port),
        PinnedSshClient { expected_pin: pin }).await?;
    let hash = connection.best_supported_rsa_hash().await
        .map_err(|_| "SSH key negotiation failed".to_owned())?.flatten();
    let auth = connection.authenticate_publickey(&host.username,
        russh::keys::PrivateKeyWithHashAlg::new(std::sync::Arc::new(key), hash))
        .await.map_err(|_| "SSH authentication failed".to_owned())?;
    if !auth.success() { return Err("SSH identity rejected by host".into()); }

    let mut channel = connection.channel_open_session().await
        .map_err(|_| "Cannot open SSH channel".to_owned())?;
    channel.request_pty(true, "xterm-256color", cols, rows, 0, 0, &[])
        .await.map_err(|_| "SSH server denied PTY".to_owned())?;
    channel.request_shell(true).await.map_err(|_| "SSH server denied shell".to_owned())?;
    let id = format!("ssh-{}", NEXT_ID.fetch_add(1, Ordering::Relaxed));
    let (tx, mut rx) = mpsc::channel::<SessionCommand>(128);
    let (cancel_tx, mut cancelled) = tokio::sync::watch::channel(false);
    manager.channels.lock().map_err(|_| "Session manager unavailable".to_owned())?
        .insert(id.clone(), (tx, cancel_tx));
    let cleanup_id = id.clone();
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn(async move {
        let mut ready = false;
        let mut backlog: Vec<Vec<u8>> = Vec::new();
        let mut buffered = 0usize;
        let mut overflowed = false;
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
pub async fn ssh_session_ready(id: String, manager: State<'_, SshSessionManager>) -> Result<(), String> {
    manager.sender(&id)?.send(SessionCommand::Ready).await
        .map_err(|_| "SSH session already closed".to_owned())
}
