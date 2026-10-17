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
| AppShell | single left rail, active-host header, page navigation, persistent sidebar visibility | interactive Windows WebView2 and full accessibility audit |
| Settings | 12 sections with functional collapsible cards, remembered category, live xterm font/cursor controls, inspector rail, import/export and pane reset | native config/log folders and advanced backend settings |
| Remote Files | lazy SFTP tree with active-path reveal, text preview and bounded raster image preview (PNG/JPEG/GIF/WebP ≤768 KiB), history, resizable tree/inspector, multiselect, serial transfer queue (pause pending, cancel, retry, progress/history) and Vault backups | multi-file native upload picker, pause/resume active transfer, large files |
| Docker | resource tabs, native KPIs, CPU/RAM sortable inventory, sanitized inspector, live/fullscreen logs, split sizes, confirmed container shell, read-only Compose project discovery and project-container listing | Compose service controls, mutations, richer metrics and Windows live verification |
| Connections | Vault hosts, fingerprint state, connection and terminal actions | host groups/tags, favorites |
| Snippets | command cards, user-entered command with explicit SSH confirmation | encrypted reusable user snippets, platform-aware templates |
| Port Forwarding | standalone native SSH forwarding workspace | presets and recovery experience |
| AI Agents | dedicated workspace, remote probes and PTY launches | scoped MCP agent broker is future work |

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
`?__reference=1&screen=settings|files|docker`. It is watermarked and does not
connect to SSH, Vault or Docker. The CI build gate checks that `DEV UI FIXTURE`
is absent from the production Vite bundle.

`.github/workflows/reference-ui-screenshots.yml` is manual (`workflow_dispatch`)
on the existing self-hosted runner. It uses Chromium bundled with an isolated
npm test dependency, not the blocked Playwright CDN, AWS, or hosted Actions runners.

Last green visual evidence: https://github.com/pas7-studio/PaSSH7/actions/runs/39031809762
- Nine screenshots: three workspaces at 1440x900, 1920x1080 and 900x720.
- Viewport overflow, required layout elements, resize keyboard, accordion and Docker search checks.
- Actual offline App sidebar persistence across reload and header restore.
- Screenshot artifact: `PaSSH7-reference-UI-screenshots`.

This evidence checks the real React layout using synthetic data. It does NOT prove
pixel-perfect parity or native Windows WebView2 behavior. Windows interactive
acceptance with pinned SSH test hosts remains a separate release gate.

For local reference screenshots: install desktop npm dependencies, run Vite on
127.0.0.1:4187, open `http://127.0.0.1:4187/?__reference=1&screen=settings`,
and use `apps/passh7-desktop/tests/visual` for isolated Playwright tests.
