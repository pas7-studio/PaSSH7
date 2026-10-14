# PaSSH7

**PaSSH7** is an open-source SSH manager and future local AI agent gateway for Windows, built in Rust.

> **Experimental v0.1. Not production-ready.** The current milestone implements an encrypted local vault and a CLI. It does **not** yet establish SSH connections, enforce SSH host-key pins, provide a desktop UI, or expose MCP tools. **Do not import real production SSH keys** before security review and Windows persistence fixes.

## Workspace

- `crates/passh7-core`: vault model and authenticated encryption
- `crates/passh7-cli`: interactive-password CLI for vault setup and SSH profiles
- `docs/threat-model.md`: security assumptions and open risks

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
```

**Windows status:** code now uses `ReplaceFileW` with an encrypted recovery backup, but this path is still unverified in Windows CI. Do not store valuable keys until validation, permissions hardening and recovery tests are complete.

**CI policy:** exclusively dedicated self-hosted runners. See [runner setup](docs/self-hosted-ci.md). Automatic runs for untrusted public PRs are disabled.

## Planned milestones

1. Security and Windows persistence review; key-format validation and filesystem permissions.
2. SSH client with strict pinned host-key verification, PTY and SFTP.
3. Tauri desktop app.
4. Isolated local MCP broker with agent-specific permissions and audit logs.

## License

Apache-2.0; see LICENSE. Security reports: see SECURITY.md.
