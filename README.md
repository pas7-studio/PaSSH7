# PaSSH7

**PaSSH7** is an open-source SSH manager and future local AI agent gateway for Windows, built in Rust.

> **Experimental v0.2. Not production-ready.** The encrypted vault, pinned SSH terminal, basic SFTP, Docker inventory and localhost tunnels are implemented in the desktop application, but have **not** undergone an independent security audit or full real-server Windows acceptance testing. Do not treat this as a production-ready secrets manager. An isolated, scoped MCP broker is **not** implemented.

## Workspace

- `crates/passh7-core`: vault model and authenticated encryption
- `crates/passh7-cli`: interactive-password CLI for vault setup and SSH profiles
- `apps/passh7-desktop`: React + Tauri 2 desktop; encrypted vault, authenticated SSH terminal tabs, per-host remembered credentials, SFTP browsing and UTF-8 preview, Docker inventory and localhost TCP forwarding
- `docs/desktop-ux.md`: UX principles, contextual integrations and agent trust boundaries
- `docs/threat-model.md`: security assumptions and open risks
- `docs/vault-format-and-migrations.md`: stable schema contract, compatibility and migration strategy

## Crypto format

Argon2id (64 MiB, 3 iterations, parallelism 1) derives a key from a master password with a random 16-byte salt. XChaCha20-Poly1305 authenticates and encrypts the serialized vault using a random 24-byte nonce and versioned associated data. These are established cryptographic primitives, **not** a claim that the overall product has been audited.

## Quick start (development test data only)

```shell
cargo build --workspace
cargo test --workspace
cargo run -p passh7 -- --vault test-vault.json init
cargo run -p passh7 -- --vault test-vault.json list
cargo run -p passh7 -- --vault test-vault.json import-key --alias demo --file /path/to/test-private-key
cargo run -p passh7 -- --vault test-vault.json add-host --alias test --hostname example.test --username ubuntu --identity demo
cargo run -p passh7 -- --vault test-vault.json pin-host --alias test --fingerprint SHA256:REPLACE_WITH_INDEPENDENTLY_VERIFIED_FINGERPRINT
cargo run -p passh7 -- --vault test-vault.json change-password
cargo run -p passh7 -- --vault test-vault.json remove-host --alias test
cargo run -p passh7 -- --vault test-vault.json remove-key --alias demo
```

**Password rotation caveat:** previous encrypted Windows backups may still be decryptable using the old master password; store and dispose of backups deliberately. The operation is not yet verified under concurrent writers.

**Windows status:** the vault uses Windows-specific atomic replacement/recovery handling. The Windows GNU target cross-build passes CI, but that does not validate real Windows filesystem behavior or server authentication. Keep backup/recovery tests and permissions hardening on the release checklist.

**CI policy:** exclusively dedicated self-hosted runners. See [runner setup](docs/self-hosted-ci.md). Automatic runs for untrusted public PRs are disabled.

## Host-key trust policy

Host keys must be verified against a trusted, independently obtained SHA-256 fingerprint before connection. The new `hostkey::verify_host_key` API fails closed when the pin is missing, malformed or mismatched; `pin-host` stores a user-supplied pin. The desktop SSH client verifies the pinned server key during handshake. First-time fingerprint discovery is unauthenticated and requires explicit user review; verify it independently with an administrator. A changed pin blocks authentication, rather than silently accepting the new key.

## Migration safety and compatibility

The encrypted envelope version and the decrypted data schema version are independent. Legacy v1 vaults (missing `schema_version`) remain readable. Unknown optional fields are preserved when a vault is re-encrypted, while unsupported future schema versions are rejected rather than silently rewritten. Regression tests cover those cases. See [migration ADR](docs/vault-format-and-migrations.md).

**Not yet guaranteed:** concurrent-writer isolation, filesystem ACL retention, power-loss rollback and full Windows crash recovery. Until those are implemented and independently verified, do not rely on PaSSH7 for irreplaceable keys.

## Desktop app (experimental)

The browser preview uses synthetic `.invalid` hosts and cannot open real SSH connections. Real SSH operations run only inside the Tauri desktop app.

```shell
cd apps/passh7-desktop
npm install
npm run dev          # synthetic browser preview
npm run build        # frontend type check and build
npm run tauri dev    # native SSH desktop app
```

After unlocking the encrypted vault, create a host with **Password only** (no SSH key required) or choose an existing vault SSH identity. You may also select **Import SSH config** in **Your Hosts** to review and explicitly import supported direct hosts from your local `~/.ssh/config` (aliases, hostnames, usernames, ports only). Complex wildcard, proxy, `Include` and `Match` directives are intentionally skipped; no private keys or trusted fingerprints are imported. Select the host and approve its verified SHA-256 host-key pin. To upgrade a password-bootstrap host to key authentication later, install the generated PUBLIC key on the remote server, then use **Attach key to host** in its Connect dialog (the private key stays in the encrypted vault). Use **Connect** for first login or **Quick connect** when the authentication mode and required secrets have been saved in the encrypted vault. When **Remember authentication** is checked, PaSSH7 stores successful login credentials encrypted and can reuse them after the next vault unlock. **Forget saved passwords** removes them. The UI does not receive stored secrets from the Rust vault.

- **Terminal:** authenticated pinned SSH connection with PTY and multiple tabs; active host and selected tab stay aligned. Interactive transport enables TCP_NODELAY, gives keyboard data its own priority queue, batches keystrokes for at most 3 ms, serializes writes to preserve order and coalesces high-rate xterm output while showing isolated shell echo immediately. Network RTT and server load still determine when the remote shell echoes characters; local speculative echo is deliberately disabled to preserve password masking, Unicode and TUI behavior.
- **Multiple SSH backup targets:** optionally store an encrypted per-host destination directory in Vault. Use **Back up to all connected targets** to create independent, no-overwrite, verified ciphertext snapshots on every connected configured server. Native Rust decrypt-validates and captures the encrypted Vault **once** at batch start, then sends that exact generation sequentially to all targets; concurrent local edits cannot cause inconsistent backup contents within a batch. Native IPC emits per-target progress without including secrets. Missing sessions and partial failures are reported. This is **one-way, explicit backup replication**, not automatic conflict-free synchronization. Target directories must already exist and be private; no remote folders are created and no master password is sent to a host.
- **Encrypted Vault history and compare:** scan the current remote directory for versioned `passh7-vault-*.enc.json` snapshots, see each backup's size/date and explicitly inspect one. The native Vault inspector compares individual host/identity records against the current local Vault and returns only alias/category differences (never passwords, private keys or fingerprints). Because encryption is randomized, ciphertext difference does not imply that the decrypted content differs; identical content disables unnecessary Restore. History entries are marked *unverified* until individually authenticated. No automatic merging or conflict resolution is performed.
- **Encrypted Vault backup/recovery:** create versioned encrypted Vault snapshots without overwriting earlier backup files on any **already-connected, pinned SSH server** via authenticated SFTP, then read back and compare the complete encrypted file; or export a local ciphertext-only backup with a native Save As dialog. To restore a remote backup, use **Review Vault backup** next to a versioned `passh7-vault-*.enc.json` in the SFTP explorer, preview host/key counts and explicitly type `RESTORE`. Remote backup bytes stay in native Rust and are decrypted only for verification. Alternatively download the encrypted file and restore later through **Restore from encrypted file**. Recovery requires the **same master password** as the backup, refuses to overwrite a locally changed Vault, first preserves and verifies the previous encrypted generation and closes old SSH sessions. Remote backup creation requests POSIX mode `0600` from SFTP (the server may ignore this; restrict and verify directory permissions). No automatic conflict resolution, two-way synchronization, scheduling or backup purge is implemented. Store backups in private server directories and keep at least one independently accessible offline copy: losing the Vault may also lose the SSH credentials needed to fetch remote backups.
- **Files:** searchable SFTP directory browsing with breadcrumbs, size/modified timestamps, natural sorting (folder, name, size, date), read-only UTF-8 text preview (256 KiB), native **Upload** and **Download** dialogs for binary files up to 64 MiB per operation; existing local/remote files are not intentionally overwritten. Native transfers use independent SSH channels to avoid blocking interactive terminal output. Uploads show bytes and a progress percentage, downloads show transferred bytes, and both support explicit cancellation. Completed downloads use atomic no-clobber publication (hard link within the destination folder), never check-then-rename.
- **Docker:** read-only `docker ps -a` inventory and bounded timestamped logs, plus explicit-confirmation container **Start**, **Stop**, **Restart** actions using the SSH account's Docker permissions. Operations are limited to validated container IDs and fixed actions; no arbitrary command execution via the panel.
- **Ports:** localhost-bound local TCP forwarding to destinations reachable by the SSH server; tunnels stop on session shutdown or vault lock; SOCKS/remote forwarding are not implemented
- **AI Agent:** checks availability of remote Codex / Claude Code / OpenCode via allowlisted `--version` probes, then launches an installed CLI in an interactive SSH terminal with the remote account's **full permissions**. A non-interactive version probe can miss shell-only aliases. This is **not** an isolated sandbox, MCP authorization layer or provider setup wizard.

The unlocked vault keeps sensitive material in the application's process, subject to a 15-minute idle timeout and explicit lock. Passwords also exist temporarily in the WebView/IPC during unlock and login. Independent Windows security tests, real-server acceptance testing, permission hardening, and crash recovery validation are still needed.

The CI pipeline runs on dedicated self-hosted runners; automatic execution of public pull request code is deliberately disabled. See [CI setup](docs/self-hosted-ci.md) and [threat model](docs/threat-model.md).

## Next milestones

1. End-to-end Windows acceptance suite with a real SSH server: saved credentials, SFTP, Docker, tunnel lifecycle and disconnections
2. Reliable SFTP file transfers and optional controlled write operations, with explicit permissions and progress/error states
3. Improved remote Docker diagnostics and responsive UX under several concurrent terminal sessions
4. Isolated local MCP broker with per-agent permissions, audit trail and scoped actions

## License

Apache-2.0; see LICENSE. Security reports: see SECURITY.md.
