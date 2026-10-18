# PaSSH7

**PaSSH7** is an open-source SSH manager and future local AI agent gateway for Windows, built in Rust.

> **Experimental v0.2. Not production-ready.** The encrypted vault, pinned SSH terminal, basic SFTP, Docker inventory and localhost tunnels are implemented in the desktop application, but have **not** undergone an independent security audit or full real-server Windows acceptance testing. Do not treat this as a production-ready secrets manager. The local CLI-to-SSH MCP bridge is experimental and **not** a fine-grained audited security sandbox.

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

## AI agents: remote signed-in CLI or local CLI over PaSSH7 SSH

PaSSH7 uses your existing **Codex CLI, Claude Code CLI and OpenCode CLI logins**. It does **not** use provider APIs, pass API keys into another process, or install a daemon on SSH hosts.

In **AI Agents**, the compact launcher keeps the CLI selector, **Auto / Remote SSH / Local + SSH** mode, discovery status, and main launch action together. The live SSH PTY is the primary work surface, with local-agent SSH grants and revoke controls alongside it. Choose *any connected SSH session* from the top target picker without disconnecting other hosts. Setup diagnostics and the non-secret context preview open only when needed. PaSSH7 remembers the last selected CLI and run mode as non-secret local UI preferences; it never persists a grant or login. Local CLI execution still opens a **separate Windows console** (the embedded terminal is the remote SSH PTY, not a local ConPTY console). Connect to a saved pinned SSH host and choose:

- **Auto**: probe the SSH user's CLI; if missing, probe the local machine and launch its CLI with PaSSH7 remote tools.
- **Remote CLI**: launch the remote signed-in CLI in the existing native SSH PTY.
- **Local CLI + SSH**: launch a local CLI in its **own Windows console**. A temporary per-session grant enables four MCP tools: `remote_exec`, `remote_list`, `remote_read`, `remote_write`.

The local bridge is integrated into the desktop binary (`--passh7-mcp` stdio child mode) and talks to PaSSH7 through an authenticated **127.0.0.1-only** IPC channel. Codex launches with a per-invocation `mcp_servers.passh7.env_vars` allowlist for `PASSH7_BRIDGE_ADDR` and `PASSH7_BRIDGE_TOKEN`, because its stdio MCP child may otherwise filter token-named environment variables. The allowlist contains variable **names**, not the temporary token value. It reuses PaSSH7's already authenticated and host-key-pinned Rust SSH transport, SFTP and permissions. The token is randomly generated for that launch, passed through process environment rather than agent command arguments, and revoked when its local console exits. Closing the native SSH session, explicitly locking Vault, or reaching the 15-minute Vault idle expiry makes tools fail closed. The AI Agents tab lists live local SSH tool grants by CLI and target host, and can revoke any grant without closing the separate CLI console. Revocation blocks new tool requests; an already running remote operation may still finish. Every bridge RPC checks Vault liveness without resetting its idle timer; an expired Vault also stops SSH sessions. MCP configuration is ephemeral and contains no SSH secrets. Remote shell results have a 60-second timeout, 256 KiB combined output cap, stderr and exit code; file reads/writes are UTF-8 up to 256 KiB; MCP remote_read returns the original file text (no JSON-string quoting). **remote_write overwrites existing files**. Do not use on untrusted servers or with an untrusted local CLI session.

The agent's own built-in shell and file tools still run on your **local machine**. For remote operations, instruct the agent to use the `passh7` `remote_*` MCP tools. Local OpenCode V1 loads a temporary flat `mcp.passh7` config through `OPENCODE_CONFIG`. OpenCode V2 needs `mcp.servers.passh7` and starts with `--standalone` inside a per-launch temporary project containing `opencode.json`; it does not rely on V2's known-broken legacy `OPENCODE_CONFIG` override. Both launch paths use the same signed-in local CLI account; neither writes to your global CLI config. All local modes now start in a fresh disposable working directory rather than PaSSH7's installation directory. PaSSH7 writes temporary `AGENTS.md` and `CLAUDE.md` instructions telling the CLI to use the four `passh7` MCP tools for SSH operations. On normal console exit PaSSH7 removes its generated instructions and config, then removes the temporary directory if empty. Any files the agent deliberately creates in its local workspace are preserved rather than silently deleted; they remain on this computer, not on the SSH host. Neither provider credentials nor SSH secrets are written to PaSSH7-generated temporary files. A local CLI is **not** a remote sandbox, and its ability to use MCP tools depends on its installed CLI version and local login. Opening an interactive local terminal is currently implemented for **Windows desktop**; Unix local CLI console launch is not enabled. No background service, provider SDK, API token storage, or GUI app automation is installed.

**Connections** shows distinct counts for connected hosts and native SSH sessions. A directly reachable saved host can be tested for a valid SSH identification banner and response time; that test does not authenticate or verify the host key. Jump-routed private targets intentionally cannot be misleadingly probed directly from the PC. **Settings** includes a searchable category navigation, with actual local MCP architecture, CLI sign-in limitations and permission scope documented in AI Agents settings.

## Edit and remove SSH connections

Use **Connections → Edit** (in a host row or inspector), the small pencil beside the host in the **left sidebar**, or the pencil in **Terminal**. The encrypted Vault editor updates a host's friendly name, SSH hostname/IP, port, username and assigned private-key identity together. You can import or generate a new Ed25519 key directly from the editor; the resulting key is selected for the host but is not attached until you choose **Save**. Display names are independent of immutable Vault IDs, so renaming does not break a jump-host route.

**Security invariants:** editing a connected SSH host is blocked rather than silently moving live terminals or MCP grants to a different address. Changing the server address/port forgets the old pinned host fingerprint and saved login: the new server must be independently verified before authentication. Changing SSH account or identity clears saved login, but retains a verified host key for the unchanged server. You can also explicitly reset the host-key pin or forget saved login. Imported private keys are never deleted by editing or removing a host.

Use **Connections → Remove**, the inspector's **Remove**, or Terminal's trash icon to delete a host. The dialog warns about connected PTYs, remote commands, SFTP, tunnels and local agent capabilities. Deleting a jump gateway referenced by other saved hosts is blocked until those routes are removed. The host's standalone SSH keys remain encrypted in Vault.

The redundant four-icon navigation previously shown on the right has been removed. The left sidebar is the primary workspace navigation, while the shared session strip now appears across **every** workspace, including Terminal; this avoids duplicate terminal tab bars and vertical layout shifts.

## Navigation without extra SSH sessions

The global command palette uses **Ctrl/Cmd+Shift+P everywhere** or **Ctrl/Cmd+K outside the live SSH xterm**. When xterm has keyboard focus, Ctrl+K stays available to remote shells and agents for normal command-line editing. The palette searches individual live SSH PTYs, saved hosts, workspaces and safe app actions. Clicking the **current host name in the top bar** also opens this palette prefiltered to SSH hosts and terminal sessions. Use `@` to filter hosts/sessions or `>` for workspaces/actions. Enter on a live terminal reuses that exact native SSH session. Enter on a saved host selects it and opens Terminal; **Ctrl/Cmd+Enter** on a host explicitly runs the normal Connect flow (pinned host-key verification and regular login still apply). Adding a host or unlocking Vault from the palette uses the existing dialogs. The palette never executes remote shell commands.

Every session has a separate, keyboard-accessible **Disconnect** control. Topbar, terminal tabs and the session strip all request explicit confirmation, serialize repeated native close attempts and keep the tab visible if the backend cannot verify closure. Confirmations name active local tunnels and warn when the SSH host serves as a gateway for other connected targets; those dependent sessions may also be affected. In Port Forwarding, stopping a tunnel also confirms the owning PTY, local port, remote endpoint and interruption of connected clients.

A compact **SSH session strip** stays visible above Connections, Files, Docker, Port Forwarding, Snippets, AI Agents and Settings. Click a session to change the current host and PTY together while remaining in the current workspace. Sessions stay open on the other hosts; context changes do not migrate MCP grants or Docker/SFTP requests to another server. The strip offers a clear Connect or Unlock Vault action when no SSH session is active, and respects the same authenticated native SSH lifecycle.

## Remote host readiness diagnostics

Open **Settings → About & Diagnostics → Live SSH host health** with an authenticated host selected, then choose **Run host checks**. PaSSH7 checks the selected SSH account's SFTP directory access, Docker inventory and Codex/Claude Code/OpenCode terminal CLI availability without modifying files, containers or services. It distinguishes a usable Windows CLI from a Start Menu desktop application that cannot run in an SSH PTY. Results and failures are specific to the currently selected SSH session; switching hosts clears them. **Copy safe health summary** omits host addresses, usernames, file and container names, credentials and raw remote command output.

A **Ready** result means the corresponding read-only check succeeded for that SSH account. It is not a guarantee that all agent workflows or remote Docker actions work: use actual Windows WebView2 + remote SSH acceptance before relying on them.

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

- **SSH Jump Host / bastion (one hop):** Save an internal `192.168.x.x` / `10.x.x.x` host as a normal PaSSH7 Vault profile, then select **SSH route → Via gateway** on that host. Connect the saved, pinned, directly reachable gateway first; **Connect** to the internal target next. PaSSH7 opens `direct-tcpip` through the existing gateway SSH connection and negotiates a completely separate end-to-end SSH session (with the target's independent pinned host key and its private key kept locally inside Vault). Initial target fingerprint discovery goes through the gateway without accepting it automatically. Files/SFTP, Docker, port forwarding and remote AI terminals use the nested target connection. No ssh binary or private key is installed on the gateway; private DNS names/IPs are resolved on the gateway network. One hop only; routes that introduce cycles or put a gateway behind another gateway are rejected. The gateway must remain connected and allow `AllowTcpForwarding`/`direct-tcpip`; its disconnection also disconnects dependent target SSH sessions.
- **Terminal:** authenticated pinned SSH connection with PTY and multiple tabs; active host and selected tab stay aligned. Interactive transport enables TCP_NODELAY, gives keyboard data its own priority queue, batches keystrokes for at most 3 ms, serializes writes to preserve order and coalesces high-rate xterm output while showing isolated shell echo immediately. Network RTT and server load still determine when the remote shell echoes characters; local speculative echo is deliberately disabled to preserve password masking, Unicode and TUI behavior.
- **Multiple SSH backup targets:** optionally store an encrypted per-host destination directory in Vault. Use **Back up to all connected targets** to create independent, no-overwrite, verified ciphertext snapshots on every connected configured server. Native Rust decrypt-validates and captures the encrypted Vault **once** at batch start, then sends that exact generation sequentially to all targets; concurrent local edits cannot cause inconsistent backup contents within a batch. Native IPC emits per-target progress without including secrets. Missing sessions and partial failures are reported. This is **one-way, explicit backup replication**, not automatic conflict-free synchronization. Target directories must already exist and be private; no remote folders are created and no master password is sent to a host.
- **Encrypted Vault history and compare:** scan the current remote directory for versioned `passh7-vault-*.enc.json` snapshots, see each backup's size/date and explicitly inspect one. The native Vault inspector compares individual host/identity records against the current local Vault and returns only alias/category differences (never passwords, private keys or fingerprints). Because encryption is randomized, ciphertext difference does not imply that the decrypted content differs; identical content disables unnecessary Restore. History entries are marked *unverified* until individually authenticated. No automatic merging or conflict resolution is performed.
- **Encrypted Vault backup/recovery:** create versioned encrypted Vault snapshots without overwriting earlier backup files on any **already-connected, pinned SSH server** via authenticated SFTP, then read back and compare the complete encrypted file; or export a local ciphertext-only backup with a native Save As dialog. To restore a remote backup, use **Review Vault backup** next to a versioned `passh7-vault-*.enc.json` in the SFTP explorer, preview host/key counts and explicitly type `RESTORE`. Remote backup bytes stay in native Rust and are decrypted only for verification. Alternatively download the encrypted file and restore later through **Restore from encrypted file**. Recovery requires the **same master password** as the backup, refuses to overwrite a locally changed Vault, first preserves and verifies the previous encrypted generation and closes old SSH sessions. Remote backup creation requests POSIX mode `0600` from SFTP (the server may ignore this; restrict and verify directory permissions). No automatic conflict resolution, two-way synchronization, scheduling or backup purge is implemented. Store backups in private server directories and keep at least one independently accessible offline copy: losing the Vault may also lose the SSH credentials needed to fetch remote backups.
- **Remote file operations:** full-width SFTP browser supports new folder, same-directory rename with destination-exists check, and individually confirmed deletion of files or empty directories. Names are validated natively to reject traversal, separators and control characters. No recursive delete or shell command execution is used. On SFTP servers with concurrent writers, a rename can race between the existence check and actual operation; avoid conflicting writes during a rename.
- **Remote file permissions and fast directory tables:** SFTP table/inspector show optional POSIX mode (octal), owner UID and group GID when supplied by the server, alongside size/date/type. File rows support Enter to open/preview, Space to select, Ctrl/Cmd+C to copy the selected file path. Very large directories render the first 250 rows initially and provide progressive Load more controls, avoiding thousands of DOM rows at once; search/sort still operate on the full fetched list. Selecting another SSH host resets the file selection/history to prevent stale cross-host actions. No chmod/chown API is exposed or inferred from unavailable metadata.
- **Files:** a separate SSH Home button, explicit Go-to-path action and copy-multiple-remote-paths controls, plus searchable SFTP directory browsing with breadcrumbs, size/modified timestamps, natural sorting (folder, name, size, date), read-only UTF-8 text preview (256 KiB), native **Upload** and **Download** dialogs for binary files up to 64 MiB per operation; existing local/remote files are not intentionally overwritten. Native transfers use independent SSH channels to avoid blocking interactive terminal output. Uploads show bytes and a progress percentage, downloads show transferred bytes, and both support explicit cancellation. Completed downloads use atomic no-clobber publication (hard link within the destination folder), never check-then-rename.
- **Docker resources:** dedicated Containers, **Logs**, Images, Volumes and Networks tabs in the large Docker workspace. Image, volume and network inventories use native allowlisted, read-only commands (`docker image ls`, `docker volume ls`, `docker network ls` with JSON formatting), bounded output and client-side search. Container state actions remain explicitly confirmed; timestamped Logs have a dedicated full-width tab, adjustable recent tail, client-side search/severity filtering, download and a bounded optional SSH live stream; no arbitrary remote command or destructive image/volume/network operation is exposed.
- **Docker log usability:** the selected container stays identified while recent lines load or fail; Retry reloads that precise container, not the previously selected one. **Pause view** freezes the displayed log snapshot for inspection while Follow live, if enabled, may continue in the bounded native/React stream. Resume view and Latest return to the live buffer; they never start a second SSH stream. The log panel's resizable height now honors the saved user value throughout 240–620 px; new installations default to 560 px without overriding existing preferences.
- **Docker live logs:** a dedicated authenticated SSH exec channel streams `docker logs --follow --tail 0 --timestamps` for the selected container, using the same pinned target session and local Vault credentials (including via Jump Host). Native events carry bounded base64 binary chunks, then the UI incrementally UTF-8 decodes/coalesces them and retains only a bounded recent buffer. Follow streams are stopped when leaving Docker, changing the SSH session/container, turning Follow off or locking Vault. Concurrent native log channels are capped per SSH session; log output is rendered as text, never interpreted as HTML. Static `View logs` with selectable tail remains available. Docker's remote account and container privileges apply. 
- **Docker:** read-only `docker ps -a` inventory and bounded timestamped logs, plus explicit-confirmation container **Start**, **Stop**, **Restart** actions using the SSH account's Docker permissions. Container action busy/progress state is bound to its originating native SSH session, so a slow action on host A does not block or incorrectly reset host B's controls. Operations are limited to validated container IDs and fixed actions; no arbitrary command execution via the panel.
- **Ports:** localhost-bound local TCP forwarding to destinations reachable by the SSH server, with reviewed form-only Web/Redis/PostgreSQL/RDP presets and early detection of local port collisions across SSH sessions; tunnels stop on session shutdown or Vault lock. Presets do not start a tunnel. SOCKS/remote forwarding are not implemented
- **AI Agent:** checks availability of remote Codex / Claude Code / OpenCode via allowlisted `--version` probes, then launches an installed CLI in an interactive SSH terminal with the remote account's **full permissions**. A non-interactive version probe can miss shell-only aliases. This is **not** an isolated sandbox, MCP authorization layer or provider setup wizard.

The unlocked vault keeps sensitive material in the application's process, subject to a 15-minute **local user inactivity** timeout and explicit lock. Real keyboard and pointer input inside PaSSH7 refreshes that timeout (including interactive SSH terminal input); remote process output and SSH transport keepalives intentionally do **not** refresh it. An unattended agent's SSH connection is closed when the Vault automatically locks after 15 minutes, even though an active user can work in the terminal indefinitely without triggering the idle lock. Passwords also exist temporarily in the WebView/IPC during unlock and login. Independent Windows security tests, real-server acceptance testing, permission hardening, and crash recovery validation are still needed.

The CI pipeline runs on dedicated self-hosted runners; automatic execution of public pull request code is deliberately disabled. See [CI setup](docs/self-hosted-ci.md) and [threat model](docs/threat-model.md).

## Next milestones

1. End-to-end Windows acceptance suite with a real SSH server: saved credentials, SFTP, Docker, tunnel lifecycle and disconnections
2. Reliable SFTP file transfers and optional controlled write operations, with explicit permissions and progress/error states
3. Improved remote Docker diagnostics and responsive UX under several concurrent terminal sessions
4. Isolated local MCP broker with per-agent permissions, audit trail and scoped actions

## License

Apache-2.0; see LICENSE. Security reports: see SECURITY.md.
