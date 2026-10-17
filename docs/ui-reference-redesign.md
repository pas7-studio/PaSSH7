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
| AppShell | single left rail, true active-host header, page navigation | resize/persistence and accessibility audit |
| Settings | 12 section categories, bound existing preferences, right information rail | native config/log folders and advanced backend settings |
| Remote Files | lazy SSH SFTP tree, file metadata, preview, transfers and Vault backups | batch queue, multi-select, image preview, resizing |
| Docker | resource tabs, state actions, six KPI cards with genuine stats sampling, sanitized lifecycle/volumes/network inspector, live searchable/fullscreen logs | Compose workflows, per-container metrics and Windows live verification |
| Connections | Vault hosts, fingerprint state, connection and terminal actions | host groups/tags, favorites |
| Snippets | command cards, user-entered command with explicit SSH confirmation | encrypted reusable user snippets, platform-aware templates |
| Port Forwarding | standalone native SSH forwarding workspace | presets and recovery experience |
| AI Agents | dedicated workspace, remote probes and PTY launches | scoped MCP agent broker is future work |

## Security and transport truth

- Credentials, SSH identities and verified pins remain in the Rust encrypted Vault. Only non-secret view preferences belong to browser local storage.
- Agent CLIs and snippets run with the remote SSH user's privileges, NOT a PaSSH7 sandbox.
- Native SFTP transfer size is currently 64 MiB; never show fake 1.2 GiB uploads. Transfer cancellation works; native pause/retry/concurrent queue are future work.
- Docker stats is a single read-only sample collected using a fixed SSH command; CPU is aggregate container percent, not host CPU. Memory is summed reported container usage, not total host RAM.
- Docker logs stream on a dedicated native SSH exec channel. Follow is cancelled on host/container/workspace change or Vault lock; static logs remain available for stopped containers.
- All real connection/authentication paths require independently verified pinned host keys. No mock data can imply a live connection.

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
