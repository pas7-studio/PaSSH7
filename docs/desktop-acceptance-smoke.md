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
| DOCKER-LIVE-05 | Repeatedly toggle Follow on/off quickly while a container produces immediate log lines and an older stream is closing | Events arriving before native start acknowledgment are buffered by unique stream ID and replayed only for the new stream; old stream lines and close events cannot corrupt the new log panel. Buffer overflow is visible, not silently misreported |
| DOCKER-LOG-EXPORT-01 | In Docker Logs, apply search/severity filter, click Save As and select a new destination via native Windows/Linux dialog | Exactly the visible filtered UTF-8 lines are saved; saved bytes are verified; no browser Blob download or remote mutation occurs |
| DOCKER-LOG-EXPORT-02 | Save As: Cancel, select an existing filename, or use a container name with path characters | Cancel changes nothing; existing files remain intact with actionable error; suggested name is sanitized and limited, never a Docker-provided path |
| DOCKER-LOG-EXPORT-03 | Switch SSH host/container while the Save As dialog is open | Original snapshot may be explicitly saved, but its completion/error message does not display under the different host; saving button re-enables |

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
| SSH-INPUT-01 | Type a partial command in xterm, click outside it and immediately launch an AI CLI or a saved snippet | Pending keystrokes flush before the button-generated command. Native PTY receives exact FIFO bytes, not interleaved sequences |
| SSH-INPUT-02 | Hold the first write on one SSH session, queue a second command to that same PTY and type in a different connected terminal | Second write for the first session waits in FIFO; independent session input continues immediately, with no global serial bottleneck |
| DOCKER-FAILURE-01 | Deny remote account access to the Docker daemon, use a host without Docker CLI, then retry after repair | UI distinguishes permissions, missing CLI, unavailable daemon and SSH interruption with clear remediation; successful retry restores inventory without changing hosts |
| DOCKER-LOG-FAILURE-01 | Stop Docker daemon or sever remote SSH while static tail / live Follow is running | Missing exit status is not reported as a successful empty log result. Follow reports an error rather than “stream finished normally”; manually stopping a stream remains non-error |

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
| SFTP-HOST-01 | Open a slow folder on host A, switch to host B and load its directory, then allow A's response to finish | B's listing, path, loading state and errors remain B-specific. Late results from A do not replace the visible directory |
| SFTP-HOST-02 | Browse a nested folder on host A, switch to host B and navigate elsewhere, then switch back to A while both SSH PTYs remain open | Each SSH session remembers its last successfully browsed path, without leaking another host's path or restarting at an unrelated directory |
| SFTP-HOST-03 | Trigger a slow file preview on host A, switch to B, then let A's preview finish | Preview body, error and busy states are scoped to the originating SSH session and do not appear on B |

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
| DOCKER-JSON-01 | On Linux SSH, refresh Containers, Images, Volumes, Networks, CPU/memory stats and Compose projects | All supported inventory commands use Docker's literal `--format json` mode with no Go-template braces, quoted templates or shell-dependent escaping; UI receives only projected fields |
| DOCKER-JSON-02 | Repeat Docker inventories over Windows OpenSSH (PowerShell and cmd default-shell variants) | JSON lines parse without `template parsing error: unclosed action`; container list is populated with real states; stale/unsupported Docker CLI versions produce actionable errors |
| DOCKER-JSON-03 | Add test canaries to container labels, command arguments and unrelated Docker JSON fields | Rust strips non-allowlisted fields before native IPC. Canary strings do not enter the WebView, console diagnostics or copied inventory data |
| DOCKER-JSON-04 | Docker process fails or remote SSH exec does not report successful exit status | UI shows Docker execution error, not a misleading empty inventory or successful listing |
| DOCKER-JSON-05 | Docker CLI produces a warning on stderr but valid JSON on stdout with exit 0 | Native reader parses stdout only, warning does not corrupt JSON. On nonzero exit, a bounded stderr error is shown without inventing inventory rows |

| DOCKER-01 | Refresh containers; inspect logs | Real `docker ps -a` inventory; logs capped at 200 lines and 512 KiB |
| DOCKER-02 | Start/stop/restart throwaway container | Per-operation confirmation, expected state shown after refresh |
| DOCKER-03 | Reject action confirmation; use SSH user lacking Docker permission | No action when cancelled; explicit permission error when rejected |
| PORT-01 | Bind local port and request remote test service | Service reachable from local `127.0.0.1:<port>`; no public bind |
| PORT-02 | Stop tunnel, lock Vault | Listener disappears and cannot be reached |
| PORT-03 | Start two local forwards, reload only the WebView, then open Ports | Native forward inventory restores both active listeners; Refresh forwards matches backend; listeners still work |
| PORT-04 | With two live SSH PTYs on one host, create one localhost forward in each and open Port Forwarding | Both native listeners are visible on that host, with a distinction between the selected terminal and another PTY. Other hosts' tunnels remain hidden |
| PORT-05 | Delay a tunnel start on host A, switch to B and start another tunnel before A finishes | B remains interactive and its Start button is not disabled by A's operation. Completing A cannot replace B's list/error/loading state; returning to A reveals its forward |
| PORT-06 | Disconnect one SSH PTY while another on the same host continues, then Refresh forwards | Each PTY inventory is reconciled independently. One failed/disconnected PTY does not erase healthy forwards owned by its sibling, and no detached native listener is claimed active |

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
| AGENT-UI-05 | Choose an agent and press Launch; accept confirmation | Exactly the selected CLI command is written to the currently authenticated PTY; AI Agents stays open and the live interactive terminal shows the result, without opening a second SSH connection or fake MCP sandbox |
| AGENT-UI-08 | Run an interactive full-screen Claude/Codex/OpenCode TUI, switch AI Agents ↔ Terminal ↔ Files and back, focus/expand the console, and switch between two SSH sessions | Each native SSH session owns exactly one xterm instance and one event subscriber. Scrollback and TUI state survive workspace switching; no second login, duplicate remote process, stale resize, or cross-session input occurs |
| AGENT-UI-09 | Lock Vault or disconnect while AI Agents embedded terminal is running | Terminal disappears, old session events cannot be routed to another host, and launch/check actions disable immediately |
| AGENT-UI-10 | Start Check installed tools on host A, then switch immediately to host B before the native probe completes | Host B never displays A's errors, versions or completion notice; A's stale request cannot leave B's Check installed tools button busy; fresh B probe succeeds |
| AGENT-UI-11 | Initiate CLI launch on host A, quickly change selected host before SSH write resolves | No misleading A launch success or failure banner is shown on B. The original SSH command is never retargeted to B |
| SSH-DISCONNECT-UI-01 | While viewing Docker or AI Agents, terminate the selected SSH connection unexpectedly | A persistent, accessible host-labelled banner appears outside the hidden Terminal panel, with Reconnect (when Vault remains unlocked) and Dismiss; other hosts' PTYs, logs and connections remain unaffected |
| SSH-DISCONNECT-UI-02 | Keep two SSH sessions open on host A; select its second shell, switch to host B, then return to A | The second shell remains selected and receives typed commands; UI never falls back to another PTY silently |
| SSH-DISCONNECT-UI-03 | Force native `ssh_session_close` to reject and leave the target session in `ssh_session_list` | PTY, scrollback and selected session stay visible, with global "could not confirm disconnect" banner; do not offer Reconnect until loss is confirmed |
| SSH-LONG-IDLE-01 | Keep a CLI terminal open for 10+ minutes while continuing to type/click locally at least once every 15 minutes | Native SSH keepalive probes every 30 seconds, not injected shell keystrokes. Genuine local interaction refreshes Vault idle timer; healthy terminal remains active |
| SSH-LONG-IDLE-02 | Let Codex, Claude Code or OpenCode run without local keyboard/mouse input for over 15 minutes | Vault auto-locks and closes SSH even if remote agent output and keepalives continue. This prevents indefinite unattended remote access |
| VAULT-ACTIVITY-01 | While Vault is unlocked, type or click in Terminal, Docker, Files or Agents; then check idle behavior | Native Vault touch is throttled to at most one refresh per minute. Active local input prolongs the existing session only; remote output does not |
| VAULT-ACTIVITY-02 | Let Vault expire or press Lock, then send keyboard/pointer events before unlocking | Expired or explicitly locked Vault cannot be revived by an activity event. Re-enter the master password to reconnect |

| AGENT-UI-06 | Have two sessions for the same host and select one in AI Agent | Launch targets the explicitly selected session; no command is written to a different host |
| AGENT-UI-07 | Copy SSH context; inspect remote terminal and settings | Context contains non-secret host and route information only; no passwords, private keys or Vault secrets are copied or supplied to the agent |
| AGENT-LOCAL-01 | Windows has an authenticated OpenCode CLI, Linux SSH account has no OpenCode CLI, choose Auto and Launch | Remote probe finds no CLI; local CLI opens in a separate local console; only the selected authenticated SSH session is granted remote_exec, remote_list, remote_read, remote_write via stdio MCP |
| AGENT-LOCAL-02 | Codex CLI installed locally and logged in; choose Local CLI + SSH | Opens the local CLI with ephemeral MCP configuration. Existing Codex login remains local; no API keys, passwords, Vault private keys or agent binaries are sent to the server |
| AGENT-LOCAL-03 | Claude Code CLI signed in locally; choose Local CLI + SSH | Uses temporary non-secret --mcp-config and starts in a separate local console; MCP child can access only the selected live SSH session and never a remote provider API |
| AGENT-LOCAL-04 | Start a local CLI for host A, change selected host to B without restarting the CLI | Existing local CLI tools remain bound to A, never silently retarget to B. Launching a new agent for B uses a distinct temporary grant |
| AGENT-LOCAL-05 | Lock Vault, disconnect SSH, close the local CLI console or close PaSSH7 | Tools fail closed on revoked/missing native SSH session; console exit revokes its temporary token; a new GUI/app process never inherits a previous grant |
| AGENT-LOCAL-06 | Probe invalid local CLI shim, path with spaces/apostrophes and a GUI-only desktop installation | Local probe checks actual CLI --version and refuses broken aliases; quoted command paths do not execute interpolated shell text |
| AGENT-LOCAL-07 | Through local CLI, run remote command that exits nonzero, output exceeds 256 KiB, or runs longer than 60s | Exit status/stdout/stderr are separate and bounded; missing SSH exit status, closed session, output truncation and timeout are explicit |
| AGENT-LOCAL-08 | Local agent reads remote UTF-8 text, lists folder, and overwrites a test file | Operates via the existing SFTP subsystem with a 256 KiB bound. Write is explicitly destructive: test backups/permissions and ensure normal SSH account access applies |
| AGENT-LOCAL-09 | Local CLI has built-in shell and files tools | They remain LOCAL and are never falsely presented as server operations. Agent must use passh7 remote_* MCP tools for all remote operations |



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
| SETTINGS-HEALTH-01 | Open Settings → About & Diagnostics for an authenticated Linux SSH host and click Run host checks | One read-only check each for SFTP and Docker inventory, plus independent Codex / Claude Code / OpenCode CLI discovery; statuses explain working and missing capabilities |
| SETTINGS-HEALTH-02 | Repeat checks through a Windows OpenSSH account with Claude desktop GUI installed but no Claude CLI | Shows desktop app as GUI-only; does not claim usable SSH CLI and does not attempt to launch desktop application |
| SETTINGS-HEALTH-03 | Start checks on host A, immediately switch to host B while the first host is slow | A's delayed responses cannot overwrite B's statuses, and health report shows Not checked yet until B is probed |
| SETTINGS-HEALTH-04 | Copy the completed host health summary | JSON report contains component statuses, app version and target only; never includes host IP, usernames, Docker container IDs/names, filenames, private keys or remote probe stdout |
| SETTINGS-HEALTH-05 | Run diagnostics while Docker daemon is down or SFTP permission is denied | Specific failing capability shows remediation while SSH and unaffected capabilities remain available; no modifications to the remote host |

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

## Visual fixture screenshots vs native Windows acceptance

The on-demand `PaSSH7 reference UI screenshot smoke` workflow captures 9 screenshots
from development-only fixtures and verifies keyboard resize, Docker search,
Settings accordion and real offline App sidebar persistence.
Latest passed run: https://github.com/pas7-studio/PaSSH7/actions/runs/39031809762

Compare generated screenshots side by side with the 3 approved mockups.
Look at hierarchy, font scaling, contrast, table/inspector proportions,
transfer queue, Docker KPIs, logs height and responsive fallbacks.
A green screenshot smoke is NOT proof of pixel-perfect parity.

On packaged Windows 11 WebView2, separately verify native rendering,
keyboard and pointer interactions, font fallback, Vault locking, file dialogs,
SFTP transfer queue, real Docker stats/logs, and switching two pinned hosts.

## UI consistency pass (all workspaces)

Run manual `PaSSH7 reference UI screenshot smoke` and compare the 24 images: Connections, Terminal (visual-only fixture), Files, Docker, Port Forwarding, Snippets, AI Agents and Settings at 1440x900, 1920x1080 and 900x720. Latest green evidence: https://github.com/pas7-studio/PaSSH7/actions/runs/39033405449.

On Windows 11 verify real Terminal: switching multiple SSH tabs preserves PTY output; close buttons are independently keyboard accessible; Session details opens/closes without disconnect; selected host, info header and xterm resize stay consistent. Verify Connections filters, Snippets search/copy/confirmation, Ports copy/stop, Agent missing-CLI message and all native modal contrast. Real native smoke is not replaced by headless fixtures.


## Command palette, dialogs and Appearance

| Case | Procedure | Expected |
| --- | --- | --- |
| UI-KB-01 | Focus empty desktop canvas, press Ctrl+K; search Docker, press Enter | Palette opens globally and switches workspace without opening an SSH session |
| UI-KB-02 | Open Quick Switch with mouse; focus Close; Shift+Tab; Escape | Focus wraps within dialog then returns to the actual button that opened it |
| UI-KB-03 | Open Vault/login/host trust dialogs; press Escape and Tab | Focus remains inside dialog; Escape uses the dialog's Close/Cancel, blocked when an operation is busy |
| UI-KB-04 | With Vault dialog open, press Ctrl+K | Quick Switch does not open on top of sensitive authentication flow |
| UI-KB-05 | While a real SSH PTY is connected, change Appearance from dark to light and back | PTY is not disconnected, scrollback persists, text/cursor/ANSI colors remain readable |
| UI-KB-06 | Select a host result in Quick Switch | Selection changes, but no credentials are sent and no SSH session is opened implicitly |

Headless UI keyboard and appearance test PASS: https://github.com/pas7-studio/PaSSH7/actions/runs/39035191959.


## Docker Inspect shell-agnostic regression

| Case | Procedure | Expected |
| --- | --- | --- |
| DOCKER-INSPECT-01 | On a real Linux Docker host, select a running container and press Inspect | Detail fields render; no Go-template parse errors |
| DOCKER-INSPECT-02 | On a Windows OpenSSH host with Docker, repeat Inspect | Uses the same `docker container inspect <validated hex ID>` command, without PowerShell/cmd Go-template quoting |
| DOCKER-INSPECT-03 | Inspect a stopped container | Image, lifecycle timestamps, restart policy and networks are shown where available |
| DOCKER-INSPECT-04 | Try a missing/deleted container | Native Docker exit error appears and Retry remains available, not a fake empty detail |
| DOCKER-INSPECT-05 | Inspect an image with `Config.Env`, `Config.Labels` and command arguments | Only the explicit allowlisted detail fields reach the WebView; environment/labels and commands are excluded |

Underlying fix: use Docker's normal JSON array output instead of `docker inspect --format '{{json .}}'`. Parse the array and reduce to the existing allowlisted detail shape in the native SSH actor. No secrets, arbitrary shell strings or Go templates are accepted as JavaScript inputs.

## Windows OpenSSH: GUI apps vs coding CLI tools

| Case | Procedure | Expected |
| --- | --- | --- |
| AGENT-WIN-01 | Connect to a Windows 11 SSH host with cmd.exe defaultShell, run Check installed tools | Probe reports Windows and does not use Unix `$SHELL` as a false missing result |
| AGENT-WIN-02 | Install npm CLI in the SSH user's %APPDATA%/npm outside SSH PATH | Probe finds its .cmd, shows source and safely launches via a quoted encoded absolute PowerShell path |
| AGENT-WIN-03 | CLI on standard Windows PATH | Detected CLI and version displayed; launching remains subject to explicit permission confirmation |
| AGENT-WIN-04 | Only Codex/Claude/OpenCode Windows GUI application installed | State says Desktop app only, launch CLI disabled and RDP guidance shown; no attempt to run a GUI via SSH |
| AGENT-WIN-05 | Neither GUI nor CLI, or PowerShell denied | Show missing or actionable diagnostic, not green Installed; leave terminal available |
| AGENT-WIN-06 | CLI installed under a different Windows profile | Do not infer availability from desktop app on another user account; report the actual SSH user's environment |
| AGENT-WIN-07 | Agent path contains spaces, apostrophes or command metacharacters | Native UTF-16LE encoded command safely quotes path; shell injection rejected |
| AGENT-WIN-08 | Check installed tools on Ubuntu/Linux | Unix login-shell version probing continues to work, with no Windows-specific false positive |
| AGENT-WIN-09 | Start CLI in a connected PTY, then lock Vault | CLI process tied to the SSH session terminates when the session closes; no background hidden process is created |
| AGENT-WIN-10 | User tries to run desktop app without RDP | UI states an SSH text terminal cannot render desktop windows; no fake Open App action |

Automated Rust + frontend + visual evidence:
https://github.com/pas7-studio/PaSSH7/actions/runs/39039408111

## Additional Windows agent runtime smoke

- AGENT-WIN-11: Create a fake/nonworking `claude.cmd` in SSH account user
  bin. The CLI must show **needs repair** and stay disabled, not installed.
- AGENT-WIN-12: With desktop-only Codex/Claude/OpenCode, choose **Prepare RDP
  tunnel**. Port Forwarding displays 13389 -> 127.0.0.1:3389 but does not
  start until user explicitly requests. With RDP enabled, connect using
  `mstsc /v:127.0.0.1:13389`.
- AGENT-WIN-13: WindowsApps App Execution Alias alone must not be treated as a
  runnable CLI. A successful `--version` is required for installed status.

Automated unit/UI/visual PASS:
https://github.com/pas7-studio/PaSSH7/actions/runs/39040275865
