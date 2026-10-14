//! PaSSH7 encrypted local vault. Network SSH is not implemented in v0.1.
pub mod hostkey;
use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::{aead::{Aead, Payload}, KeyInit, XChaCha20Poly1305, XNonce};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use std::{fs::{self, OpenOptions}, io::Write, path::Path};
use thiserror::Error;
use zeroize::{Zeroize, Zeroizing};

const FORMAT: u32 = 1;
const AAD: &[u8] = b"passh7/vault/v1";
const MEM_KIB: u32 = 65_536;
const ITERATIONS: u32 = 3;
const PARALLELISM: u32 = 1;
const MAX_SIZE: u64 = 16 * 1024 * 1024;

#[derive(Debug, Error)]
pub enum HubError {
    #[error("incorrect master password or modified vault")]
    Authentication,
    #[error("unsupported vault format")]
    UnsupportedFormat,
    #[error("invalid input: {0}")]
    InvalidInput(&'static str),
    #[error("I/O: {0}")]
    Io(#[from] std::io::Error),
    #[error("serialization: {0}")]
    Json(#[from] serde_json::Error),
    #[error("KDF error")]
    Kdf,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HostProfile {
    pub alias: String,
    pub hostname: String,
    pub port: u16,
    pub username: String,
    pub identity_alias: String,
    /// Data-only for now: SSH host key validation not implemented.
    pub pinned_host_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Identity {
    pub alias: String,
    pub private_key_pem: String,
}
impl Drop for Identity {
    fn drop(&mut self) { self.private_key_pem.zeroize(); }
}

#[derive(Default, Serialize, Deserialize)]
pub struct Vault {
    pub hosts: Vec<HostProfile>,
    pub identities: Vec<Identity>,
}
impl Vault {
    pub fn add_identity(&mut self, identity: Identity) -> Result<(), HubError> {
        if identity.alias.trim().is_empty()
            || !identity.private_key_pem.contains("-----BEGIN ")
            || !identity.private_key_pem.contains("PRIVATE KEY-----") {
            return Err(HubError::InvalidInput("invalid alias or unsupported private key encoding"));
        }
        if self.identities.iter().any(|i| i.alias == identity.alias) {
            return Err(HubError::InvalidInput("identity alias already exists"));
        }
        self.identities.push(identity);
        Ok(())
    }

    pub fn add_host(&mut self, host: HostProfile) -> Result<(), HubError> {
        if host.alias.trim().is_empty() || host.hostname.trim().is_empty()
            || host.username.trim().is_empty() || host.identity_alias.trim().is_empty() || host.port == 0 {
            return Err(HubError::InvalidInput("missing host field or invalid port"));
        }
        if self.hosts.iter().any(|h| h.alias == host.alias) {
            return Err(HubError::InvalidInput("host alias already exists"));
        }
        if !self.identities.iter().any(|i| i.alias == host.identity_alias) {
            return Err(HubError::InvalidInput("unknown identity alias"));
        }
        if let Some(pin) = &host.pinned_host_key {
            hostkey::validate_fingerprint(pin)?;
        }
        self.hosts.push(host);
        Ok(())
    }
    /// Explicitly pin an already verified host fingerprint (never discover blindly).
    pub fn pin_host_key(&mut self, alias: &str, pin: &str) -> Result<(), HubError> {
        hostkey::validate_fingerprint(pin)?;
        let host = self.hosts.iter_mut().find(|h| h.alias == alias)
            .ok_or(HubError::InvalidInput("host alias not found"))?;
        host.pinned_host_key = Some(pin.to_owned());
        Ok(())
    }

    /// Remove a host without touching the referenced SSH identity.
    pub fn remove_host(&mut self, alias: &str) -> Result<(), HubError> {
        let index = self.hosts.iter().position(|h| h.alias == alias)
            .ok_or(HubError::InvalidInput("host alias not found"))?;
        self.hosts.remove(index);
        Ok(())
    }

    /// Refuse removal while a host still depends on the identity.
    pub fn remove_identity(&mut self, alias: &str) -> Result<(), HubError> {
        if self.hosts.iter().any(|h| h.identity_alias == alias) {
            return Err(HubError::InvalidInput("identity is still used by a host"));
        }
        let index = self.identities.iter().position(|i| i.alias == alias)
            .ok_or(HubError::InvalidInput("identity alias not found"))?;
        self.identities.remove(index);
        Ok(())
    }

    /// Validate internal references after decrypting a potentially older vault.
    pub fn validate(&self) -> Result<(), HubError> {
        let mut hosts = std::collections::HashSet::new();
        let mut keys = std::collections::HashSet::new();
        for i in &self.identities {
            if i.alias.trim().is_empty() || !keys.insert(i.alias.as_str()) {
                return Err(HubError::InvalidInput("duplicate or empty identity alias"));
            }
        }
        for h in &self.hosts {
            if h.alias.trim().is_empty() || h.hostname.trim().is_empty() ||
                h.username.trim().is_empty() || h.port == 0 || !hosts.insert(h.alias.as_str()) {
                return Err(HubError::InvalidInput("invalid or duplicate host profile"));
            }
            if let Some(pin) = &h.pinned_host_key {
                hostkey::validate_fingerprint(pin)?;
            }
            if !keys.contains(h.identity_alias.as_str()) {
                return Err(HubError::InvalidInput("host references missing identity"));
            }
        }
        Ok(())
    }

}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    format: u32,
    memory_kib: u32,
    iterations: u32,
    parallelism: u32,
    salt: [u8; 16],
    nonce: [u8; 24],
    ciphertext: Vec<u8>,
}
fn key_from_password(password: &str, e: &Envelope) -> Result<Zeroizing<[u8; 32]>, HubError> {
    if e.memory_kib != MEM_KIB || e.iterations != ITERATIONS || e.parallelism != PARALLELISM {
        return Err(HubError::UnsupportedFormat);
    }
    let params = Params::new(e.memory_kib, e.iterations, e.parallelism, Some(32)).map_err(|_| HubError::Kdf)?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = Zeroizing::new([0u8; 32]);
    argon.hash_password_into(password.as_bytes(), &e.salt, &mut *key).map_err(|_| HubError::Kdf)?;
    Ok(key)
}

pub fn encrypt(vault: &Vault, password: &str) -> Result<Vec<u8>, HubError> {
    if password.chars().count() < 12 {
        return Err(HubError::InvalidInput("master password must be at least 12 characters"));
    }
    let mut salt = [0; 16];
    let mut nonce = [0; 24];
    OsRng.fill_bytes(&mut salt);
    OsRng.fill_bytes(&mut nonce);
    let mut e = Envelope { format: FORMAT, memory_kib: MEM_KIB, iterations: ITERATIONS,
        parallelism: PARALLELISM, salt, nonce, ciphertext: vec![] };
    let key = key_from_password(password, &e)?;
    let cipher = XChaCha20Poly1305::new_from_slice(&*key).map_err(|_| HubError::Kdf)?;
    vault.validate()?;
    let plaintext = Zeroizing::new(serde_json::to_vec(vault)?);
    e.ciphertext = cipher.encrypt(XNonce::from_slice(&e.nonce),
        Payload { msg: &plaintext, aad: AAD }).map_err(|_| HubError::Authentication)?;
    Ok(serde_json::to_vec_pretty(&e)?)
}
pub fn decrypt(bytes: &[u8], password: &str) -> Result<Vault, HubError> {
    if bytes.len() as u64 > MAX_SIZE { return Err(HubError::InvalidInput("vault file too large")); }
    let e: Envelope = serde_json::from_slice(bytes)?;
    if e.format != FORMAT { return Err(HubError::UnsupportedFormat); }
    let key = key_from_password(password, &e)?;
    let cipher = XChaCha20Poly1305::new_from_slice(&*key).map_err(|_| HubError::Kdf)?;
    let plaintext = Zeroizing::new(cipher.decrypt(XNonce::from_slice(&e.nonce),
        Payload { msg: &e.ciphertext, aad: AAD }).map_err(|_| HubError::Authentication)?);
    let vault: Vault = serde_json::from_slice(&plaintext)?;
    vault.validate()?;
    Ok(vault)
}
pub fn load(path: &Path, password: &str) -> Result<Vault, HubError> {
    if fs::metadata(path)?.len() > MAX_SIZE {
        return Err(HubError::InvalidInput("vault file too large"));
    }
    decrypt(&fs::read(path)?, password)
}
pub fn create(path: &Path, password: &str) -> Result<(), HubError> {
    let data = encrypt(&Vault::default(), password)?;
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    file.write_all(&data)?;
    file.sync_all()?;
    Ok(())
}
/// Save new ciphertext through a synced temporary file with platform-specific replacement.
/// Windows replacement retains an encrypted backup pending a reviewed rotation policy.
#[cfg(not(windows))]
fn replace_vault_file(temp: &Path, destination: &Path) -> Result<(), HubError> {
    fs::rename(temp, destination)?;
    Ok(())
}

#[cfg(windows)]
fn replace_vault_file(temp: &Path, destination: &Path) -> Result<(), HubError> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::ReplaceFileW;
    fn wide(path: &Path) -> Vec<u16> {
        path.as_os_str().encode_wide().chain(std::iter::once(0)).collect()
    }
    if !destination.exists() {
        fs::rename(temp, destination)?;
        return Ok(());
    }
    let mut random = [0u8; 8];
    OsRng.fill_bytes(&mut random);
    let backup = destination.with_extension(format!("bak-{:016x}", u64::from_be_bytes(random)));
    let result = unsafe {
        ReplaceFileW(wide(destination).as_ptr(), wide(temp).as_ptr(),
                     wide(&backup).as_ptr(), 0, std::ptr::null(), std::ptr::null())
    };
    if result == 0 { return Err(HubError::Io(std::io::Error::last_os_error())); }
    Ok(())
}

pub fn save(path: &Path, vault: &Vault, password: &str) -> Result<(), HubError> {
    let data = encrypt(vault, password)?;
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let filename = path.file_name().ok_or(HubError::InvalidInput("missing vault filename"))?.to_string_lossy();
    let mut random = [0u8; 8];
    OsRng.fill_bytes(&mut random);
    let tmp = parent.join(format!(".{filename}.{:016x}.tmp", u64::from_be_bytes(random)));
    let result = (|| -> Result<(), HubError> {
        let mut file = OpenOptions::new().write(true).create_new(true).open(&tmp)?;
        file.write_all(&data)?;
        file.sync_all()?;
        replace_vault_file(&tmp, path)?;
        Ok(())
    })();
    if result.is_err() { let _ = fs::remove_file(&tmp); }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    fn password() -> &'static str { "long-example-master-password" }
    #[test]
    fn roundtrip_wrong_password_and_tamper() {
        let mut v = Vault::default();
        v.add_identity(Identity { alias: "mykey".into(), private_key_pem:
            "-----BEGIN OPENSSH PRIVATE KEY-----\\nTEST\\n-----END OPENSSH PRIVATE KEY-----".into() }).unwrap();
        v.add_host(HostProfile { alias: "dev".into(), hostname: "dev.example".into(), port: 22,
            username: "ubuntu".into(), identity_alias: "mykey".into(), pinned_host_key: None }).unwrap();
        let data = encrypt(&v, password()).unwrap();
        assert_eq!(decrypt(&data, password()).unwrap().hosts[0].alias, "dev");
        assert!(matches!(decrypt(&data, "incorrect password"), Err(HubError::Authentication)));
        let mut e: Envelope = serde_json::from_slice(&data).unwrap();
        e.ciphertext[0] ^= 1;
        assert!(matches!(decrypt(&serde_json::to_vec(&e).unwrap(), password()), Err(HubError::Authentication)));
    }
    #[test]
    fn save_replaces_existing_vault_and_preserves_decryptability() {
        let mut random = [0u8; 8];
        OsRng.fill_bytes(&mut random);
        let dir = std::env::temp_dir().join(format!("passh7-test-{:016x}", u64::from_be_bytes(random)));
        fs::create_dir(&dir).unwrap();
        let path = dir.join("vault.json");
        create(&path, password()).unwrap();
        let mut updated = load(&path, password()).unwrap();
        updated.add_identity(Identity { alias: "test".into(), private_key_pem:
            "-----BEGIN OPENSSH PRIVATE KEY-----\\nTEST\\n-----END OPENSSH PRIVATE KEY-----".into() }).unwrap();
        save(&path, &updated, password()).unwrap();
        assert_eq!(load(&path, password()).unwrap().identities.len(), 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn identity_cannot_be_removed_when_host_uses_it() {
        let mut vault = Vault::default();
        vault.add_identity(Identity { alias: "key".into(),
            private_key_pem: "-----BEGIN OPENSSH PRIVATE KEY-----\\nTEST\\n-----END OPENSSH PRIVATE KEY-----".into() }).unwrap();
        vault.add_host(HostProfile { alias: "node".into(), hostname: "node.test".into(),
            port: 22, username: "ubuntu".into(), identity_alias: "key".into(), pinned_host_key: None }).unwrap();
        assert!(vault.remove_identity("key").is_err());
        assert_eq!(vault.identities.len(), 1);
        vault.remove_host("node").unwrap();
        vault.remove_identity("key").unwrap();
        assert!(vault.hosts.is_empty() && vault.identities.is_empty());
    }

    #[test]
    fn rejects_inconsistent_vault_before_encryption() {
        let mut vault = Vault::default();
        vault.hosts.push(HostProfile { alias: "node".into(), hostname: "node.test".into(),
            port: 22, username: "ubuntu".into(), identity_alias: "missing".into(), pinned_host_key: None });
        assert!(encrypt(&vault, password()).is_err());
    }

    #[test]
    fn rotating_password_invalidates_old_password_on_new_ciphertext() {
        let original = encrypt(&Vault::default(), password()).unwrap();
        let vault = decrypt(&original, password()).unwrap();
        let rotated = encrypt(&vault, "another-long-master-password").unwrap();
        assert!(matches!(decrypt(&rotated, password()), Err(HubError::Authentication)));
        assert!(decrypt(&rotated, "another-long-master-password").is_ok());
    }
    #[test]
    fn randomness_and_validation() {
        assert_ne!(encrypt(&Vault::default(), password()).unwrap(), encrypt(&Vault::default(), password()).unwrap());
        assert!(encrypt(&Vault::default(), "short").is_err());
        assert!(Vault::default().add_host(HostProfile { alias: "h".into(), hostname: "localhost".into(),
            port: 22, username: "u".into(), identity_alias: "missing".into(), pinned_host_key: None }).is_err());
    }
}