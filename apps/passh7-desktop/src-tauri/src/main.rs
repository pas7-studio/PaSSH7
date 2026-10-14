#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use std::path::PathBuf;

use serde::Serialize;
use passh7_core::{HostProfile, HubError};

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
    let root = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("XDG_DATA_HOME").map(PathBuf::from))
        .ok_or("No per-user application data directory found")?;
    let dir = root.join("PaSSH7");
    std::fs::create_dir_all(&dir).map_err(|_| "Unable to access vault directory")?;
    Ok(dir.join("vault.json"))
}

fn safe_err(e: HubError) -> String {
    match e {
        HubError::Busy => "Vault is busy; retry shortly".into(),
        HubError::Authentication => "Wrong password or damaged vault".into(),
        HubError::UnsupportedFormat => "Unsupported vault version".into(),
        _ => "Vault operation failed; inspect local diagnostics".into(),
    }
}

#[tauri::command]
fn vault_exists() -> Result<bool, String> {
    Ok(vault_path()?.exists())
}

#[tauri::command]
fn vault_initialize(master_password: String) -> Result<(), String> {
    let path = vault_path()?;
    passh7_core::create(&path, &master_password).map_err(safe_err)
}

#[tauri::command]
fn vault_list_hosts(master_password: String) -> Result<Vec<HostSummary>, String> {
    let vault = passh7_core::load(&vault_path()?, &master_password).map_err(safe_err)?;
    Ok(vault.hosts.into_iter().map(|h| HostSummary {
        alias: h.alias, hostname: h.hostname, port: h.port, username: h.username,
        identity_alias: h.identity_alias, host_key_pinned: h.pinned_host_key.is_some()
    }).collect())
}

#[tauri::command]
fn vault_add_host(master_password: String, host: HostInput) -> Result<(), String> {
    let path = vault_path()?;
    passh7_core::transaction(&path, &master_password, |vault| {
        vault.add_host(HostProfile {
            alias: host.alias.clone(), hostname: host.hostname.clone(), port: host.port,
            username: host.username.clone(), identity_alias: host.identity_alias.clone(),
            pinned_host_key: host.pinned_host_key.clone(), extensions: Default::default(),
        })?;
        Ok(true)
    }).map_err(safe_err)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostInput {
    alias: String,
    hostname: String,
    port: u16,
    username: String,
    identity_alias: String,
    pinned_host_key: Option<String>,
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            vault_exists, vault_initialize, vault_list_hosts, vault_add_host
        ])
        .run(tauri::generate_context!())
        .expect("unable to start PaSSH7");
}
