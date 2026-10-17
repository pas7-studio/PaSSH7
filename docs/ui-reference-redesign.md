# PaSSH7 Reference UI Redesign — Implementation contract

Date: 2026-10-17
Status: implementing; not yet Windows desktop acceptance-tested.

## Canonical visual reference

Three user-approved mockups from 2026-10-17:
1. Settings: app left rail, active-host header, vertical settings categories, large forms, right about/config/Vault/tips column.
2. Remote Files: shared chrome, breadcrumbs/toolbar, folder tree, table, detail/preview inspector, transfer queue, Vault backup section.
3. Docker: shared chrome, six KPIs, resource tabs, containers table, inspector and permanent searchable live log viewer.

Mock hostnames, transfer percentages, CPU/memory values and dates are visual example data only. The shipping UI must use authenticated native SSH facts and must never synthesize working telemetry.

## Visual design system

| Token | Reference |
| --- | --- |
| App | deep navy #081420 and subtle radial blue glow |
| Panels | #0d1b2c and #112237 |
| Foreground | #ecf4ff, muted #94a9c5 |
| Borders | #253a52, 1px |
| Accent | #3287ff, soft selected #173d72 |
| Status | green #43d78d, amber warning, red error/destructive |
| Typography | Inter / Segoe UI Variable / Segoe UI, dense controls 11–13px, headings 18–24px |
| Corner radii | controls 6px, panels 8–12px |
| Left sidebar | 222px |
| Top host header | 61px |
| Structure | fixed chrome + independently scrolling workspace, details on right |

Migration layer: apps/passh7-desktop/src/reference-ui.css, loaded after legacy styles. Avoid removing legacy styles until Windows screenshot regression testing.

## Macro implementation backlog

| Workstream | Implemented in redesign branch | Remaining |
| --- | --- | --- |
| AppShell | persistent left rail, native active-host header, shared WorkspaceHeader/Status/Metric/Empty foundations, consistent light/dark design language and optional terminal inspector | interactive Windows WebView2 and deep accessibility audit |
| Settings | 12 sections with functional collapsible cards, remembered category, live xterm font/cursor controls, inspector rail, import/export and pane reset | native config/log folders and advanced backend settings |
| Remote Files | lazy SFTP tree with active-path reveal, text preview and bounded raster image preview (PNG/JPEG/GIF/WebP ≤768 KiB), history, resizable tree/inspector, multiselect, serial transfer queue (pause pending, cancel, retry, progress/history) and Vault backups | multi-file native upload picker, pause/resume active transfer, large files |
| Docker | resource tabs, native KPIs, CPU/RAM sortable inventory, sanitized inspector, live/fullscreen logs, split sizes, confirmed container shell, read-only Compose project discovery and project-container listing | Compose service controls, mutations, richer metrics and Windows live verification |
| Connections | Vault hosts, verified/offline/connected status, group-aware search, accessible keyboard table, All/Connected/Trusted filters, side inspector and authenticated actions | persisted host groups/tags, favorites |
| Snippets | unified categorized command cards, searchable Shell/System/Docker templates, review/copy/run inspector, keyboard shortcut and existing explicit PTY confirmation | encrypted reusable user snippets, platform-aware templates |
| Port Forwarding | unified SSH tunnel dashboard, route preview, loopback bind guarantee, accessible table, selected endpoint inspector and copy/stop actions | presets and recovery experience |
| AI Agents | unified target-status header, honest detected/missing status, remotely checked CLI selection, explicit PTY launches and prominent permission summary | scoped MCP agent broker is future work |

## Security and transport truth

- Credentials, SSH identities and verified pins remain in the Rust encrypted Vault. Only non-secret view preferences belong to browser local storage.
- Agent CLIs and snippets run with the remote SSH user's privileges, NOT a PaSSH7 sandbox.
- Small supported text/raster files auto-preview after a 350 ms selection debounce to avoid burst SFTP requests. Hidden and credential-like filenames never auto-preview (manual Preview required); unknown binary types still require explicit download. Native image preview is capped at 768 KiB; only PNG/JPEG/GIF/WebP are accepted after native magic-byte sniffing. SVG/HTML are never rendered as image previews. UTF-8 text preview is capped at 256 KiB. Native SFTP transfers are limited to 64 MiB per file. The UI queue serializes native dialog-based operations and supports cancelling an active transfer, pausing *pending* work, and retrying as a new job. Active bytes cannot be paused/resumed. Every download still requires a system Save dialog; batch upload selection and large-file resume are future work.
- Docker stats is a single read-only sample collected using a fixed SSH command; CPU is aggregate container percent, not host CPU. Memory is summed reported container usage, not total host RAM.
- Docker Compose project discovery runs a fixed read-only command; project container listing uses validated project names and Docker labels without opening YAML/.env files. Docker logs stream on a dedicated native SSH exec channel. Follow is cancelled on host/container/workspace change or Vault lock; static logs remain available for stopped containers.
- All real connection/authentication paths require independently verified pinned host keys. No mock data can imply a live connection.

### Resize and launch behaviors
- Files tree, Files inspector, Docker inspector and Docker logs have keyboard-accessible splitters; their sizes are validated, exported and imported as non-secret local preferences. The Appearance settings screen can reset all split sizes.
- The SFTP file table supports arrows, Enter, F2 and Delete, plus a right-click menu with shared confirmation paths for mutations.
- The Docker "Open shell" action validates the selected inventory ID and requires explicit confirmation before writing a docker exec command to the authenticated PTY. It may affect another interactive command currently running in the PTY and therefore never executes silently.

## Required release gates

1. Trusted self-hosted frontend TypeScript/Vite build passes.
2. Rust Docker command allowlist tests, Linux build and Windows GNU cross-build pass on trusted runners.
3. Windows 11/WebView2 visual smoke against all three references at 1440×900, 1920×1080 and narrow windows.
4. Two real independent SSH hosts: switching hosts never causes a command, SFTP operation, Docker action, or snippet to target the wrong session.
5. Native Docker permissions denied / stopped container / stream disconnect show explicit errors, stable inventory and bounded logs.
6. SFTP lazy tree, directory history, file metadata, non-overwriting transfers and backup operations verified against a disposable test host.
7. Settings import/export/reset never affects credentials or Vault data; encrypted backup restore keeps conflict check.
8. Terminal input remains responsive while Docker and SFTP inspect asynchronously.

Do not claim release readiness or exact pixel parity based on CI alone; Windows interactive acceptance remains mandatory.

## Repeatable visual screenshot smoke (2026-10-17)

The approved Settings / Remote Files / Docker mockups remain the canonical visual target.
The actual workspace React components have a **development-only** deterministic fixture at
`?__reference=1&screen=connections|terminal|files|docker|ports|snippets|agent|settings`. It is watermarked and does not
connect to SSH, Vault or Docker. The CI build gate checks that `DEV UI FIXTURE`
is absent from the production Vite bundle.

`.github/workflows/reference-ui-screenshots.yml` is manual (`workflow_dispatch`)
on the existing self-hosted runner. It uses Chromium bundled with an isolated
npm test dependency, not the blocked Playwright CDN, AWS, or hosted Actions runners.

Last green visual evidence: https://github.com/pas7-studio/PaSSH7/actions/runs/39033405449
- Twenty-four screenshots: all eight workspaces at 1440x900, 1920x1080 and 900x720.
- Viewport overflow, real layout/card tables and inspectors, resizing by keyboard, Settings accordion, Docker search, Connections filters and Snippets categories.
- Actual offline App sidebar persistence across reload and header restore.
- Screenshot artifact: `PaSSH7-reference-UI-screenshots`.

This evidence checks the real React layout using synthetic data. It does NOT prove
pixel-perfect parity or native Windows WebView2 behavior. Windows interactive
acceptance with pinned SSH test hosts remains a separate release gate.

For local reference screenshots: install desktop npm dependencies, run Vite on
127.0.0.1:4187, open `http://127.0.0.1:4187/?__reference=1&screen=settings`,
and use `apps/passh7-desktop/tests/visual` for isolated Playwright tests.

## Full UI consistency pass

- Shared `WorkspaceChrome.tsx`: one page header, status, empty-state and metric vocabulary for Connections, Terminal-adjacent workflows, Files, Docker, Ports, Snippets, Agents and Settings. The design layer reuses navy color, spacing, form, error and focus tokens.
- Real terminal view now prioritizes a full-width SSH canvas. Session details are hidden by default and can be reopened with a button. SSH session tabs use separate keyboard-focusable select/disconnect buttons, not a clickable nested span.
- Native dialogs (Vault, host onboarding, SSH login) use a unified high-contrast modal treatment, keyboard focus and responsive bounds without altering credential flow.
- The screenshot fixture for Terminal contains only illustrative text, not a running PTY. Other screens use real React components with synthetic data only in the DEV fixture. All fixtures remain excluded from the production bundle by CI.
- Last 24-screenshot validation: https://github.com/pas7-studio/PaSSH7/actions/runs/39033405449. This verifies browser layout, not Windows WebView2 fonts/metrics or real SSH behavior.



## Keyboard navigation, modal focus and terminal Appearance (2026-10-17)

- `Ctrl/Cmd+K` opens a searchable command palette for all 8 workspaces and
  saved SSH host aliases/address/user. Keyboard Up/Down/Enter navigates results;
  selecting a host changes the selection but does **not** silently connect.
  The global shortcut works when focus is on `body` or within the terminal.
- Modal focus management is shared across SSH login, key trust, Vault unlock,
  host onboarding, import, Windows Access and Quick Switch. Tab is contained in
  the active dialog; Escape invokes its own enabled Close/Cancel handler,
  preserving protection for in-progress operations. Focus returns to the opener.
  Nested dialogs retarget the focus manager without trapping focus in an old dialog.
- The live xterm palette now switches in place with light/dark Appearance
  preferences while keeping the same SSH PTY and scrollback. Light mode uses
  readable ANSI colors, selection and cursor styling rather than a forced
  dark terminal surface.
- Validated with a real offline App interaction test (Ctrl+K, search, Enter,
  Shift+Tab wrap, Escape, focus restoration) and DEV appearance light-mode
  visual test: https://github.com/pas7-studio/PaSSH7/actions/runs/39035191959.
  The full screenshot suite still covers all 8 screens at three viewports.
- Packaged Windows WebView2 accessibility and two-host live acceptance remain
  pending and cannot be inferred from the Chromium run.

## Windows SSH agent CLI vs desktop app detection (2026-10-17)

PaSSH7 must **not** treat a Windows desktop app installation as evidence that a
terminal CLI is installed. The authenticated Windows SSH account may start
under cmd.exe/PowerShell and may not inherit the logged-in desktop user's PATH,
especially npm/WinGet user-bin shims.

Agent discovery now uses separate bounded native SSH exec probes:
- Windows: exact allowlisted Codex/Claude/OpenCode names, PowerShell
  `-EncodedCommand` via UTF-16LE; check Get-Command and known CLI locations
  (%APPDATA%/npm, WinGet Links, ~/.local/bin, ~/.bun/bin). Get-StartApps is used
  **only** to label a GUI desktop app, never as an SSH terminal executable.
- Unix: existing login-shell allowlisted command + --version check.
- The native backend distinguishes CLI present, desktop-app-only, missing and
  probe errors, with the discovery source, non-secret executable path and
  actionable diagnostic. A resolved Windows CLI uses an encoded PowerShell
  command to invoke the exact probed absolute path (including spaces).
- CLI execution remains an **explicitly confirmed** action in an existing
  authenticated PTY, with full remote-account privileges. No auto-install, no
  permission escalation and no GUI injection into Windows Session 0.
- Desktop GUI programs require a proper interactive Windows desktop (e.g.
  Remote Desktop/RDP). SSH text sessions cannot show their windows.
- The UI offers copy-only, review-first installation commands and links to
  official install documentation; no shell install scripts are executed by
  clicking a button.
- Native safety tests, TypeScript production build and 8-workspace visual
  regression: https://github.com/pas7-studio/PaSSH7/actions/runs/39039408111
- Real Windows OpenSSH smoke against the intended Windows host remains to be
  done before claiming the app/CLI is actually present and launchable.


### Windows execution aliases, broken CLIs and GUI access

Windows Start Menu entries and WindowsApps execution aliases are **not**
accepted as evidence of a runnable terminal CLI. A discovered executable must
respond successfully to `--version`; a broken npm shim or missing Node.js
dependency is displayed as **CLI needs repair**, distinct from a GUI-only
application or an absent CLI. Version checks are read-only and bounded.

If only a Windows desktop application exists, **Prepare RDP tunnel** opens
PaSSH7's existing Port Forwarding workspace prefilled with local
`127.0.0.1:13389` to target `127.0.0.1:3389`. The user must explicitly
start the SSH forward. Only then, if Windows Remote Desktop is enabled,
`mstsc /v:127.0.0.1:13389` opens the GUI desktop. The GUI is never launched
into an invisible SSH service session, and RDP is not enabled automatically.

Final Rust/TypeScript/visual test evidence:
https://github.com/pas7-studio/PaSSH7/actions/runs/39040275865
