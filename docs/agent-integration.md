# ADR-0003: PaSSH7 agent onboarding and contextual handoff

## Desired user experience

1. Add a host via alias, address, user, port, authentication source, trust verification. Test handshake separately after transport exists.
2. Pick a host in PaSSH7 and open **Agents → Connect agent**.
3. Choose Codex, Claude Code, or OpenCode. Show a preview of exactly which host, resource selection, and capabilities will be shared.
4. PaSSH7 installs or displays a per-client MCP configuration pointing to the local `passh7-mcp` stdio broker. Changes to external agent settings require user confirmation and a backup.
5. Once user grants a session, the agent discovers `passh7.list_hosts`, `passh7.get_context`, `passh7.read_file`, `passh7.exec` as supported; actual tools must be capability-gated. The active host is NOT silently switched by client prompts.
6. Provide bundled `skills/passh7-remote-assistant/SKILL.md` instructions for compatible agent environments. Install in their supported skill directory only after opt-in; installations differ by client/version and must be feature-detected, not assumed.
7. Revoke grant from UI or when vault locks. No persistent passwords or SSH private key bytes in agent configuration, MCP responses, logs or Skill files.

## Host wizard

Steps: Connection → Authentication → Host key → Confirm. Connection may be configured without a key but **Connect must fail closed** until host fingerprint is independently verified. User can choose imported key, Windows OpenSSH agent, or password only when respective backend implementations exist. Never retain plaintext password in frontend state after submission. No probing during typing.

## Broker security contract

- Spawn local child process via stdio; no default network listener.
- Desktop holds an isolated short-lived session capability. An MCP client never receives a master passphrase. Its authorization is bound to agent installation identity, host UUID, operations, time-to-live and session ID.
- Re-authorize each mutating / privileged operation in Rust, independently of LLM prompts and Skill guidance; do not rely on naive shell command allowlists.
- No raw shell access under a read-only grant: commands are not generally classifiable as read-only. Provide narrowly scoped inspection operations for read-only mode.
- Confirm explicit, previewable write actions. Apply redaction to output before sending it to an agent.
- Deny host migration across sessions, locked vault, revoked grants, unknown resources and unverified host keys.
- Future audit records are append-only and separate from encrypted identity storage.

## Integration adapter outputs

The first adapter registry is pure data describing clients and safe launch intent. **It does not write or modify agent configurations**. A future installer will detect the user scope and version before generating the correct config file for each CLI.

The Skill is a reusable set of instructions; MCP tools are the real transport. Installing a Skill alone cannot connect agents to SSH.

## Non-goals of this stage

No live MCP tools, no agent launch, no credential broker, no Windows SSH setup, no editing of external agent configuration. All UI capabilities must clearly be shown as unavailable until the backend exists.
