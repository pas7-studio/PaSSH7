# ADR-0002 — PaSSH7 Desktop UX + context integrations

**Stage:** UX prototype, unconnected to SSH/vault. UI MUST NOT imply an actual secure connection.

## Product principles

1. Connect in two actions: choose host → Connect; keyboard-first, accessible and consistent.
2. One navigation sidebar; terminal takes the largest area. Context sidebar is optional/collapsible, never a modal for routine tasks.
3. Show connection identity at all times: alias, user, hostname, host-key status, read-only/privileged capabilities.
4. Context follows the **active host and selected session**, never silently inherited from previously selected servers.
5. Locked vault = no SSH, commands or agent tools. No fake connections or demo credentials in shipping builds.
6. Configurable command palette (Ctrl+K); shortcuts Ctrl+1…9 tabs; Ctrl+Shift+P palette; Ctrl+L focus terminal (future).
7. Dark/light/system theme, resizable areas, keyboard navigation, WCAG AA contrast target. Status text never communicated only by color.
8. Avoid premature microservices: one Tauri app and Rust core modules; MCP becomes a separate optional local process later.

## Layout

- Left: Hosts, favorites, tags, filter/search; grouped by environment.
- Center: Tabs for SSH PTY sessions. Empty and disconnected states explain exactly what is available.
- Right (toggle): contextual Tools: Files (SFTP), Docker (only after capability discovery), Ports, Agent.
- Footer: vault state, active host identity, trust status, session state and minimal contextual notifications.
- Advanced settings in a dedicated view: keys, backup/restore, integrations, policies, theme, shortcuts.

## Context integration architecture

`ContextProvider` proposal:
- `HostIdentityProvider`: hostname, user, port, pin and capabilities **without exposing private key**.
- `SftpProvider`: cwd, selected path, recent directory (only if allowed).
- `DockerProvider`: explicit docker context and container names, only if socket/CLI accessible for that SSH user.
- `DiagnosticsProvider`: selected non-secret errors, command exit code, bounded output excerpt.
- `AgentContextBuilder`: constructs a preview with host alias, workspace, permissions, selected log/file references.

Every provider returns typed capability + current context + sensitivity labels. Agent receives *only user-reviewed scopes*, no ambient machine authority. SSH gateway enforces permissions at execution time, not just in UI. Do not forward entire terminal scrollback automatically. Redact or omit credentials and env values. Default agent mode: **read-only**; write/run requests require scoped grants and clear confirmation. Show active grants and revoke from current session immediately.

## Release sequencing

1. Visual React prototype, clear `Not connected` / `Unavailable` states (this change).
2. Back-end typed command contract and Tauri wiring; vault remains locked until explicit unlock.
3. Verified SSH transport + PTY streaming; terminal via xterm.js only then.
4. Capability-gated SFTP, Docker context, port forwarding.
5. MCP bridge and opt-in provider adapters for Codex, Claude Code and OpenCode.

No server connections, credentials, SSH mock output, or agent authority are implemented in the first UI prototype.
