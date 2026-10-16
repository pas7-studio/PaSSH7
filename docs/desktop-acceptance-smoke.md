# PaSSH7 Desktop — real-server acceptance checklist

> CI cross-compilation validates Rust/TypeScript/build artifacts but **does not**
> exercise Windows WebView2, a live SSH daemon, remote SFTP, Docker, or file dialogs.
> Record OS, app commit, remote SSH server and each result before release.

## Test environment

- Windows 11 PaSSH7 portable desktop executable (run the **actual downloaded EXE**).
- At least one disposable Linux OpenSSH host and one Windows OpenSSH host.
- A user-owned non-production Docker container on one host.
- A known test file with random bytes, SHA-256 checksum and size below 64 MiB.
- A test TCP service bound to remote `127.0.0.1:8080`.
- A second, separate SSH profile to exercise parallel host switching.

Do not perform destructive operations on production services or rotate live credentials
during this checklist. Use a throwaway identity and Docker container.

## Expected results

| ID | Scenario | Expected result |
| --- | --- | --- |
| SSH-01 | Unlock vault with correct password; list hosts | Saved hosts/identities appear, no secrets are rendered |
| SSH-02 | Connect with pin verified independently | Shell prompt visible, terminal accepts keyboard input |
| SSH-03 | Close terminal; repeat with invalid credentials | Disconnected dot appears; actionable authentication error |
| SSH-04 | Check **Remember authentication**, successfully connect, lock and unlock, use **Quick connect** | No password prompts when saved valid credentials can be reused |
| SSH-05 | Forget credentials; attempt Quick connect | Saved password reuse unavailable, manual authentication required |
| SSH-06 | Open 10+ terminals across two hosts; switch rapidly | Correct host status and selected terminal; input never goes to another host |
| SSH-07 | Abruptly stop remote sshd / disconnect VPN | Disconnected status and reason after reconnect/poll; stale tunnels cleaned |
| SSH-08 | Remove a saved host with active SSH and forward | Only that host's sessions and tunnels close |
| SSH-09 | Browse a slow SFTP directory and load Docker inventory/logs while running interactive commands | Terminal input and output stay responsive; slow inspections time out independently |
| SFTP-01 | Browse multiple folders, parent directory, read UTF-8 file | Correct entries and preview; unrelated session not used |
| SFTP-02 | Preview a binary file | Helpful UTF-8/binary error, no corruption |
| SFTP-03 | Upload test binary file via native file picker | New file present on remote host; matching SHA-256 checksum |
| SFTP-04 | Download same binary via native Save As dialog | Matching SHA-256 checksum and byte size locally |
| SFTP-05 | Upload/download to existing filename | No silent overwrite; meaningful error |
| SFTP-06 | Cancel file dialog, use file larger than 64 MiB, revoke remote write permission | Cancel is non-error; size and permissions have actionable errors |
| SFTP-07 | Upload while typing in terminal; then lock Vault mid-transfer | Terminal stays responsive; transfer cancels on lock, partial cleanup best effort |
| SFTP-08 | Transfer a 10–30 MiB binary file and click Cancel during upload/download | Live byte count advances, upload percentage is correct, only targeted transfer stops while terminal stays usable |
| SFTP-09 | Select an existing local destination (or race a second writer creating it before completion) | Existing local bytes remain unchanged; download publish fails instead of clobbering |
| DOCKER-01 | Refresh containers; inspect logs | Real `docker ps -a` inventory; logs capped at 200 lines and 512 KiB |
| DOCKER-02 | Start/stop/restart throwaway container | Per-operation confirmation, expected state shown after refresh |
| DOCKER-03 | Reject action confirmation; use SSH user lacking Docker permission | No action when cancelled; explicit permission error when rejected |
| PORT-01 | Bind local port and request remote test service | Service reachable from local `127.0.0.1:<port>`; no public bind |
| PORT-02 | Stop tunnel, lock Vault | Listener disappears and cannot be reached |
| AI-01 | Launch installed Codex/Claude/OpenCode CLI | Command goes only to selected terminal; CLI runs with SSH account permissions |
| AI-02 | Launch an uninstalled CLI | Shell reports missing command; UI makes no false success claim |

## Release gate

- Attach Linux + Windows CI run URLs at the tested commit.
- Record failures with app screenshot, SSH server type, OS and *sanitized* technical error.
- Never upload private SSH keys, passwords, token files, raw authorization headers or
  unredacted environment-variable dumps to issues/logs.
- Do not mark real-server E2E **passed** until these checks are actually run.
