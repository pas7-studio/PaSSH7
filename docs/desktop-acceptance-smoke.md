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
| JUMP-01 | Connect pinned public gateway (e.g. Main Server); add target private IP `192.168.1.20`, select Via Main Server, then Connect | Target fingerprint is discovered via gateway and verified independently; target password/key authenticates end-to-end; UI shows route and session state |
| JUMP-02 | Connect private target, start SFTP, Docker, remote agent, and port-forward on its session | Each operation reaches private TARGET through nested SSH, never gateway shell; local private keys are never uploaded to gateway |
| JUMP-03 | Drop/lock gateway, attempt private target connection while gateway is offline | Actionable gateway-not-connected error; dependent nested session exits instead of falsely staying connected |
| JUMP-04 | Configure self-hop, missing gateway, gateway without host-key pin, or two-hop cycle | Vault refuses configuration; existing route remains intact |
| JUMP-05 | Reject target fingerprint, force forwarding disabled in gateway sshd, change internal target address | Independent target pin is never bypassed; actionable SSH forwarding/network failure, no fallback to direct or TOFU trust |
| DOCKER-LIVE-01 | Select a running container, read its recent logs, then enable Follow live while generating new lines | New lines appear incrementally without periodic full-tail polling; visible lines and memory remain bounded |
| DOCKER-LIVE-02 | Switch container, host or workspace while following, or lock Vault | Old remote `docker logs --follow` SSH channel is cancelled, no late lines render for another container; normal SSH terminal continues |
| DOCKER-LIVE-03 | Docker daemon permission denied, invalid container, stopped container with no new logs, and failed SSH exec | UI shows actionable error/closed state; no misleading Connected/Streaming state and no silent infinite loader |
| DOCKER-LIVE-04 | Click Follow off, refresh recent logs, then follow again | No duplicate or leaked background Docker log streams; manual static tail continues to work |
| SSH-01 | Unlock vault with correct password; list hosts | Saved hosts/identities appear, no secrets are rendered |
| SSH-01A | Create a new Windows/Linux host using **Password only** with no generated or imported SSH identity | Host saves, independent host-key pin is verified, password login opens PTY and works |
| SSH-01B | Generate/import a key after initial password login, install PUBLIC key remotely, attach it to the existing host | Host keeps same alias; key-based or key+password authentication works without creating a duplicate profile |
| SSH-01C | Select an invalid or missing SSH key for a host | Native Vault refuses unknown identity; already-saved host remains intact |
| SSH-01D | Import local OpenSSH config containing direct hosts, wildcard entries, ProxyJump and Include | Only direct, supported host profiles appear in the preview; SSH user is editable; selected hosts are imported without secrets or trusted fingerprints; duplicate aliases are skipped |
| SSH-02 | Connect with pin verified independently | Shell prompt visible, terminal accepts keyboard input |
| SSH-03 | Close terminal; repeat with invalid credentials | Disconnected dot appears; actionable authentication error |
| SSH-04 | Check **Remember authentication**, successfully connect, lock and unlock, use **Quick connect** | No password prompts when saved valid credentials can be reused |
| SSH-05 | Forget credentials; attempt Quick connect | Saved password reuse unavailable, manual authentication required |
| SSH-06 | Open 10+ terminals across two hosts; switch rapidly | Correct host status and selected terminal; input never goes to another host |
| SSH-06A | Type a 60-character command normally in a responsive SSH shell; compare with system OpenSSH client on the same host | Characters appear smoothly, in order; no bursts of late letters or duplicated characters; 3 ms maximum intentional input batch delay |
| SSH-06B | Hold an arrow key, run `vim`/`nano` and an interactive Codex/Claude/OpenCode CLI | Escape sequences, control keys, password/no-echo prompts and full-screen TUI remain correct, without speculative local echo |
| SSH-06C | Paste UTF-8 text longer than 64 KiB, run fast terminal output, open SFTP/Docker panels concurrently | No reordered keyboard input, truncated Unicode surrogate pairs or frozen terminal; normal CLI output and prompts remain usable |
| SSH-07 | Abruptly stop remote sshd / disconnect VPN | Disconnected status and reason after reconnect/poll; stale tunnels cleaned |
| SSH-08 | Remove a saved host with active SSH and forward | Only that host's sessions and tunnels close |
| SSH-09 | Browse a slow SFTP directory and load Docker inventory/logs while running interactive commands | Terminal input and output stay responsive; slow inspections time out independently |
| SSH-10 | Keep two native SSH sessions active and reload the WebView without exiting the app | If native Vault remains unlocked, saved hosts and session tabs reappear; PTY input still works |
| SSH-11 | Close remote shell unexpectedly, then press Reconnect | Notice identifies the closed host; saved credentials initiate explicit Quick Connect, otherwise manual login dialog opens |
| SSH-12 | Fully exit desktop app and relaunch | Vault remains locked and secrets are never automatically unlocked; user must enter master password |
| VAULT-M1 | Save private backup folders on two different hosts, lock and re-unlock Vault | Per-host destination paths remain persisted only in the encrypted Vault; no credentials transmitted |
| VAULT-M2 | Connect two configured SSH hosts and choose **Back up to all connected targets** | One new independently verified versioned encrypted snapshot appears on each server; no existing backup overwritten; progress identifies each host |
| VAULT-M2A | Start a batch to two remote servers, change a host record locally while the first copy is uploading, then inspect both backups | Both remote backups decrypt to the exact **same starting generation**; local edit is not silently mixed into the second copy |
| VAULT-M3 | Keep one configured host disconnected and make another reject SFTP writes | Batch reports successes, disconnected targets and failures individually; successful copies remain usable; SSH terminals stay responsive |
| VAULT-M4 | Remove a backup destination, then click batch backup | Removed host is not a target; existing remote backup files remain untouched |
| VAULT-00 | Browse an SSH backup directory with multiple versions; click Refresh versions | Versioned snapshots are listed newest first with size/date and unverified state; unrelated JSON files are ignored |
| VAULT-00A | Inspect versioned backups with additions/removals/changes to hosts, identities and saved passwords | Native compare reports only record aliases and change categories, never secret values. Identical decrypted contents are recognized even if ciphertext nonces differ |
| VAULT-00B | Select a snapshot whose decrypted Vault matches current local data | Review shows no content changes; Replace action stays disabled |
| VAULT-01 | Back up unlocked Vault to a private directory on an authenticated SSH server | New versioned ciphertext-only `passh7-vault-*.enc.json` file appears; full SFTP readback matches bytes; prior backups remain untouched |
| VAULT-02 | Create local encrypted export using native Save As; cancel or select an existing destination | Cancel is non-destructive; never overwrite or delete a preexisting local backup; verify byte-identical export |
| VAULT-03 | Select **Review Vault backup** next to remote `.enc.json` or download that file and inspect locally | Host/key counts and aliases show; remote ciphertext is never returned to JavaScript, wrong master password or corrupt ciphertext refuses recovery without writing current Vault |
| VAULT-04 | Restore a validated older backup with typed RESTORE and final confirmation | Old local Vault is preserved in a verified encrypted backup; active SSH connections close; restored hosts and identities become visible |
| VAULT-05 | Modify active Vault after recovery preview but before Restore | Commit fails with a generation/conflict error and original data remains intact |
| VAULT-06 | Disconnect SSH or deny write permissions during remote backup; target path already exists | Operation fails without false success or overwriting another remote file; incomplete cleanup is best effort |
| VAULT-07 | Restore on a second device with a matching master password, without access to the original device | Snapshot opens, Vault import is explicit, SSH keys/pins restored; no automatic background merge or silent sync |
| SFTP-META-01 | Browse a directory of Linux files with varied modes/ownership and a Windows SFTP server that does not supply POSIX attrs | File table/inspector show octal mode, UID/GID where supplied; unknown metadata displays a dash/Unknown, never invented values |
| SFTP-META-02 | Browse a folder containing 5,000 entries and search for an item near the end | Initial DOM renders at most 250 file rows; filtering matches all fetched entries and Load 250 more increments predictably |
| SFTP-META-03 | Focus a file row and press Enter, Space, Ctrl/Cmd+C; switch to another SSH host | Keyboard opens/previews/selects/copies the correct path; selection/history reset on host change, no stale destructive operations |
| SFTP-01 | Browse multiple folders, use breadcrumbs and parent directory, filter/sort by name, size and modified date, read UTF-8 file | Correct remote entries, local timestamps and readable size; unrelated session not used |
| SFTP-02 | Preview a binary file | Helpful UTF-8/binary error, no corruption |
| SFTP-03 | Upload test binary file via native file picker | New file present on remote host; matching SHA-256 checksum |
| SFTP-04 | Download same binary via native Save As dialog | Matching SHA-256 checksum and byte size locally |
| SFTP-05 | Upload/download to existing filename | No silent overwrite; meaningful error |
| SFTP-06 | Cancel file dialog, use file larger than 64 MiB, revoke remote write permission | Cancel is non-error; size and permissions have actionable errors |
| SFTP-07 | Upload while typing in terminal; then lock Vault mid-transfer | Terminal stays responsive; transfer cancels on lock, partial cleanup best effort |
| SFTP-08 | Transfer a 10–30 MiB binary file and click Cancel during upload/download | Live byte count advances, upload percentage is correct, only targeted transfer stops while terminal stays usable |
| SFTP-09 | Select an existing local destination (or race a second writer creating it before completion) | Existing local bytes remain unchanged; download publish fails instead of clobbering |
| DOCKER-R1 | Open the Docker workspace and switch between Containers, Images, Volumes and Networks | Each tab shows its own real resource inventory and search; no resource is modified |
| DOCKER-R2 | Disconnect SSH while a catalog request is active, then reconnect and refresh | Catalog errors are clearly shown; cached data from another SSH session is not presented as current |
| DOCKER-01 | Refresh containers; inspect logs | Real `docker ps -a` inventory; logs capped at 200 lines and 512 KiB |
| DOCKER-02 | Start/stop/restart throwaway container | Per-operation confirmation, expected state shown after refresh |
| DOCKER-03 | Reject action confirmation; use SSH user lacking Docker permission | No action when cancelled; explicit permission error when rejected |
| PORT-01 | Bind local port and request remote test service | Service reachable from local `127.0.0.1:<port>`; no public bind |
| PORT-02 | Stop tunnel, lock Vault | Listener disappears and cannot be reached |
| PORT-03 | Start two local forwards, reload only the WebView, then open Ports | Native forward inventory restores both active listeners; Refresh forwards matches backend; listeners still work |
| AI-01 | Launch installed Codex/Claude/OpenCode CLI | Command goes only to selected terminal; CLI runs with SSH account permissions |
| AI-02 | Check an uninstalled CLI | Native version probe returns Not detected; Launch shows actionable message instead of claiming success |
| AI-03 | Check installed Codex, Claude Code and OpenCode CLIs on Linux and Windows OpenSSH | Installed/version indicators reflect remote `--version`; each probe times out independently without blocking terminal input |
| AI-04 | Send modified Tauri IPC with unsupported agent value | Native allowlist rejects arbitrary shell commands without starting a remote process |

## Release gate

- Attach Linux + Windows CI run URLs at the tested commit.
- Record failures with app screenshot, SSH server type, OS and *sanitized* technical error.
- Never upload private SSH keys, passwords, token files, raw authorization headers or
  unredacted environment-variable dumps to issues/logs.
- Do not mark real-server E2E **passed** until these checks are actually run.


## AI Agent workspace smoke (October 2026)

| ID | Scenario | Expected result |
| --- | --- | --- |
| AGENT-UI-01 | Open Terminal, AI Agent, Docker, Files, then Terminal via top navigation | Terminal and AI Agent are separate tabs; AI Agent is full-size; switching does not disconnect or recreate the native SSH session |
| AGENT-UI-02 | Lock Vault or choose an unconnected host and open AI Agent | Clearly says no active authenticated SSH session; checking and launching are disabled; Open Terminal takes user to connection flow |
| AGENT-UI-03 | Connect to a host with Codex/Claude/OpenCode in an interactive shell; run Check installed tools | Results are scoped to the *active session*; versions are shown where available; failures are actionable, never represented as successful detection |
| AGENT-UI-04 | Remote CLI is in interactive PATH but not found by version probe | Agent is still selectable and Launch remains possible; the UI explains the probe limitation |
| AGENT-UI-05 | Choose an agent and press Launch; accept confirmation | Exactly the selected CLI command is written to the currently authenticated PTY; UI switches to Terminal, with no second SSH connection or fake MCP sandbox |
| AGENT-UI-06 | Have two sessions for the same host and select one in AI Agent | Launch targets the explicitly selected session; no command is written to a different host |
| AGENT-UI-07 | Copy SSH context; inspect remote terminal and settings | Context contains non-secret host and route information only; no passwords, private keys or Vault secrets are copied or supplied to the agent |


## Reference UI and sanitized Docker inspection acceptance (2026-10-17)

| ID | Scenario | Expected result |
| --- | --- | --- |
| REF-UI-01 | Open Settings, Remote Files and Docker at 1440×900 and 1920×1080 on packaged Windows 11 app | Shared left rail, connected-host header, consistent deep-navy tokens and responsive three-column settings/files/two-column Docker layouts; no unreadable control or clipped text |
| REF-UI-02 | Toggle light theme, shrink window, return to dark | Controls keep readable contrast, keyboard focus visible, panes scroll without covering the Vault or login dialogs |
| REF-UI-03 | Select two connected hosts in Connections, then open Files, Docker, Ports and Snippets | Every workspace targets only the currently selected authenticated session; no stale content or wrong-host mutations |
| REF-UI-04 | Open Snippets, select a template, run with connected host, decline confirmation, then accept on next run | Decline sends no command; accept writes exactly one line into selected PTY and returns to Terminal |
| REF-UI-05 | Open Port Forwarding, start loopback tunnel, refresh, stop | Native forward appears with correct local/remote endpoints and closes promptly; no non-loopback listener allowed |
| DOCKER-INSPECT-01 | Select running/stopped container in Docker and open Details / Volumes / Network | Real Created/Started/Restart Policy/mount and network values appear from native Docker inspect; no fabricated fields |
| DOCKER-INSPECT-02 | Inspect container with environment variables and labels containing known test canary | Sensitive Env, labels and full command args do not cross native Rust IPC, appear in UI or diagnostics |
| DOCKER-INSPECT-03 | Deny Docker daemon permissions or disconnect during read-only stats and inspect | Containers view keeps usable prior data where safe, shows explicit errors and offers Retry; native SSH terminal remains responsive |
| DOCKER-INSPECT-04 | Switch between two hosts while inspector request or live logs are running | Old host's inspect/logs are never shown for the newly selected session, and previous live log stream is cancelled |
| DOCKER-LOG-UI-01 | Follow logs, search, choose another container, expand fullscreen and exit | Search, changing container and full-screen toggle work; output remains bounded and belongs to the selected container |


## Persisted split panes and daily file/Docker actions

| ID | Scenario | Expected result |
| --- | --- | --- |
| LAYOUT-01 | Drag Files folder-tree and details inspector separators at 1440×900 | Smooth independent resizing; file table remains readable; no table resize causes SFTP reconnect |
| LAYOUT-02 | Drag Docker inspector and logs separators, then switch to Settings and back | Chosen widths/heights persist across workspace switches and window reload; follow stream remains bound to original SSH session |
| LAYOUT-03 | Focus each separator and press arrows / Shift+arrows / Enter | Arrow = 8px; Shift = 32px; Enter resets the specific panel; screen reader announces separator and value |
| LAYOUT-04 | Export non-secret UI settings, reset all panel sizes in Appearance, then import exported settings | Default sizes are restored and exported sizes reappear after import; SSH credentials and Vault data remain unchanged |
| LAYOUT-05 | Shrink window below 1080 / 960 / 800 px | Files and Docker fall back to responsive stacked layouts; separators disappear where split panels no longer fit |
| FILE-ACTIONS-01 | Navigate from /home to /home/user, press Back | Back returns to the starting directory and Forward returns to the destination |
| FILE-ACTIONS-02 | Right-click a file; choose Preview, Copy path, Rename and Delete in a disposable fixture | All menu actions target clicked file; mutations keep confirmation and native SFTP validation; F2/Delete keyboard routes behave identically |
| FILE-ACTIONS-03 | Enter /home/user/projects/myapp in file path | Directory tree reveals only ancestors on current path, not unrelated branches; lazy SFTP calls are bounded by depth |
| DOCKER-SHELL-01 | Choose running fixture container and click Open shell, then reject confirmation | No terminal command executes and the current PTY remains unchanged |
| DOCKER-SHELL-02 | Choose running fixture container and accept shell launch while at SSH shell prompt | Validated container ID and one docker exec command written to current connected PTY; Terminal workspace shown |


## Terminal preferences and Docker inventory table UX

| ID | Scenario | Expected result |
| --- | --- | --- |
| TERM-PREF-01 | Set Cascadia / Consolas / JetBrains / monospace, change font size and line height while terminal is open | xterm renders new typography without reopening SSH session or dropping buffered PTY output; missing system fonts fall back |
| TERM-PREF-02 | Change cursor style block/underline/bar, toggle cursor blink | Current terminal updates without reconnect; values survive app reload |
| TERM-PREF-03 | Reset Terminal settings, export preferences, import on test profile | Defaults and imported non-secret values round-trip; Vault secret material unaffected |
| SETTINGS-UI-01 | Open Settings, navigate to Terminal, collapse and expand a form section | Chevron and aria-expanded track actual content visibility; active category restores after reopening Settings |
| DOCKER-TABLE-01 | Load 3 running containers and 1 stopped container, click Name/CPU/Memory headers | Rows sort correctly; per-container CPU/Memory come from read-only Docker stats; missing results display dash, not invented values |
| DOCKER-TABLE-02 | Toggle Auto-refresh inside Docker toolbar | Persists existing 15-second inventory refresh preference; SSH log streams remain on their own dedicated channel |


## SFTP Transfer Manager and Docker Compose discovery

| ID | Scenario | Expected result |
| --- | --- | --- |
| XFER-01 | Select 3 remote files with Ctrl/Shift and queue downloads | Three queued tasks appear; one native Save dialog opens at a time; file content streams only via native SFTP; no browser blob copies |
| XFER-02 | Cancel an active download and pause pending jobs | Staging partial file is cleaned up best effort; pending jobs stay queued without triggering dialogs until Resume |
| XFER-03 | Retry failed transfer, decline system file picker and retry again | New transfer ID used; declined picker marks job cancelled; prior history remains visible |
| XFER-04 | Lock Vault or disconnect the host while a transfer is active and others wait | Native active transfer cancels; queued jobs for missing sessions are marked cancelled, and no additional file picker opens |
| XFER-05 | Upload into directory A, browse to directory B while upload finishes | Background refresh never navigates the UI back to A, nor overwrites another SSH host's listing |
| XFER-06 | Clear finished jobs and inspect active row | Only completed/failed/cancelled history is cleared, active/pending work remains; no file paths/credentials stored in browser preferences |
| COMPOSE-01 | Host with Docker Compose v2, select Compose tab | Real project names/status/config filenames load through fixed read-only SSH command |
| COMPOSE-02 | Select Compose project, inspect its containers | Only containers with that Compose project label appear; UI shows real names, states, images, ports; no .env file or config values displayed |
| COMPOSE-03 | Host without Compose plugin or denied Docker rights | Actionable read-only error appears; other Docker tabs remain usable |
| COMPOSE-04 | Malicious/unexpected Compose project name from result | Project member query is rejected by both TS and Rust input validation; command injection is impossible |


## Raster image preview and context menu handling

| ID | Scenario | Expected result |
| --- | --- | --- |
| FILE-IMAGE-01 | Select a PNG/JPEG/GIF/WebP under 768 KiB on the authenticated SSH server and click Preview | Real image shown within right inspector; aspect ratio preserved and inspector width bounds respected |
| FILE-IMAGE-02 | Rename an HTML/SVG file to .png, or supply malformed image bytes | Native signature validation rejects unsupported format; no HTML/SVG or embedded script is passed to preview surface |
| FILE-IMAGE-03 | Preview a 769 KiB raster image, large text file or unsupported binary | Clear inline error with Retry; SFTP connection and file actions remain usable |
| FILE-IMAGE-04 | Preview on host A, switch to host B while read is pending | Previous host's image/text never appears in host B inspector; concurrent completions cannot overwrite newer preview |
| FILE-MENU-01 | Right-click a remote file, click outside, open again and press Escape | Context menu closes on outside interaction, resize and Escape; underlying selection remains consistent |
