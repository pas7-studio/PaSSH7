/**
 * Agent metadata and installation references for PaSSH7 workspaces.
 * Native Rust creates short-lived local MCP configuration on launch;
 * this browser-side registry never manages SSH credentials or CLI logins.
 */
export type AgentKind = "codex" | "claude" | "opencode";
export interface AgentDefinition {
  kind: AgentKind;
  name: string;
  description: string;
  supportsLocalStdioMcp: boolean;
  skillPackage: string;
}
export const AGENTS: AgentDefinition[] = [
  {kind:"codex",name:"Codex",description:"Remote coding and terminal workflows",supportsLocalStdioMcp:true,skillPackage:"skills/passh7-remote-assistant"},
  {kind:"claude",name:"Claude Code",description:"Remote project analysis and debugging",supportsLocalStdioMcp:true,skillPackage:"skills/passh7-remote-assistant"},
  {kind:"opencode",name:"OpenCode",description:"Remote developer tasks and code assistance",supportsLocalStdioMcp:true,skillPackage:"skills/passh7-remote-assistant"}
];
export type HostDraft = {
  label: string;
  hostname: string;
  port: number;
  username: string;
  auth: "password" | "key" | "agent";
  identity: string;
  fingerprint: string;
};
export function validateHostDraft(draft:HostDraft):string|null {
  if (!draft.label.trim()) return "Give this host a recognizable name";
  if (!draft.hostname.trim() || /\s/.test(draft.hostname)) return "Enter a valid hostname or IP";
  if (!Number.isInteger(draft.port) || draft.port<1 || draft.port>65535) return "Port must be between 1 and 65535";
  if (!draft.username.trim()) return "Enter the SSH username";
  if (draft.auth==="key" && !draft.identity.trim()) return "Select a key from the unlocked vault";
  if (draft.fingerprint && !/^SHA256:[A-Za-z0-9+/]{43}$/.test(draft.fingerprint)) return "Use a verified OpenSSH SHA256 fingerprint";
  return null;
}
