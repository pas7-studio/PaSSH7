# PaSSH7 v0.1 threat model (draft)

## Assets
Master passphrase, SSH private keys, connection metadata, host-key pins.

## Assumed trust boundaries
Only a local human user accesses this CLI. Disk files may be stolen or modified. The local OS process, terminal and keyboard are trusted while vault is unlocked. Malware with user privileges is **out of scope** for strong protection.

## Controls
- Argon2id with bounded fixed KDF parameters and random 16-byte salt.
- XChaCha20-Poly1305 with random 24-byte nonce and fixed authenticated associated data.
- Decryption does not print private keys.
- KDF key and decrypted plaintext buffers use zeroizing wrappers.

## Known unresolved risks
- Windows ReplaceFileW path retains encrypted backups, but has not been compiled or exercised on a Windows runner. Backup rotation, rollback, ACL preservation, and crash tests remain outstanding.
- SSH key validity is only superficially checked on import.
- Serialized secrets may leave copies in heap buffers; zeroization is best effort.
- No guarantee against master-password keylogging or process memory inspection.
- No password rotation, backup/recovery strategy or filesystem permissions hardening.
- SSH host pinning is a data field only; no SSH connection is implemented.
- No guarantee of integrity of profile aliases before authenticated decrypt.
- CI/security audit pending; never call this production-ready.

## AI agent boundary (future)
Agents must never receive vault master password or SSH private keys. Use a separate privileged broker process, explicit per-host permissions, narrowly scoped operations, least-privilege remote OS accounts and approval gates.
