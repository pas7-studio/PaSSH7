//! Strict SSH host-key fingerprint pinning. No trust-on-first-use or auto-accept.
use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine as _};
use sha2::{Digest, Sha256};
use crate::HubError;

/// OpenSSH-compatible SHA256 fingerprint over the *raw SSH public key blob*.
pub fn fingerprint(raw_key_blob: &[u8]) -> Result<String, HubError> {
    if raw_key_blob.is_empty() || raw_key_blob.len() > 64 * 1024 {
        return Err(HubError::InvalidInput("invalid SSH public key blob length"));
    }
    let hash = Sha256::digest(raw_key_blob);
    Ok(format!("SHA256:{}", STANDARD_NO_PAD.encode(hash)))
}

/// Validate a stored OpenSSH SHA256 fingerprint. Not a host-key authenticity check.
pub fn validate_fingerprint(pin: &str) -> Result<(), HubError> {
    let digest = pin.strip_prefix("SHA256:")
        .ok_or(HubError::InvalidInput("host key must use SHA256: fingerprint format"))?;
    let decoded = STANDARD_NO_PAD.decode(digest)
        .map_err(|_| HubError::InvalidInput("invalid host-key fingerprint encoding"))?;
    if decoded.len() != 32 || STANDARD_NO_PAD.encode(&decoded) != digest {
        return Err(HubError::InvalidInput("invalid host-key SHA256 digest"));
    }
    Ok(())
}

/// Must be called on the actual server host key received during SSH handshake,
/// before any authentication or command execution. Never auto-accept a changed key.
pub fn verify_host_key(pin: Option<&str>, actual_raw_key_blob: &[u8]) -> Result<(), HubError> {
    let expected = pin.ok_or(HubError::InvalidInput("SSH host key not pinned"))?;
    validate_fingerprint(expected)?;
    let actual = fingerprint(actual_raw_key_blob)?;
    // Fingerprints aren't secret; ordinary equality is sufficient.
    if expected != actual {
        return Err(HubError::InvalidInput("SSH host key mismatch"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn matches_exact_pinned_key_only() {
        let blob = b"synthetic ssh public key wire blob";
        let pin = fingerprint(blob).unwrap();
        verify_host_key(Some(&pin), blob).unwrap();
        assert!(verify_host_key(Some(&pin), b"replacement key").is_err());
        assert!(verify_host_key(None, blob).is_err());
    }
    #[test]
    fn rejects_malformed_pins() {
        for pin in ["", "MD5:abc", "SHA256:", "SHA256:@@@@",
                    "SHA256:AAAA", "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="] {
            assert!(validate_fingerprint(pin).is_err(), "{pin}");
        }
    }
}
