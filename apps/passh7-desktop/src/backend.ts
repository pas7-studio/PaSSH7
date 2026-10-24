import {invoke} from "@tauri-apps/api/core";

export type HostSummary = {
  alias:string; displayName:string|null; hostname:string; port:number; username:string;
  identityAlias:string; hostKeyPinned:boolean; hasSavedCredentials:boolean; savedAuthMode:string|null; backupDirectory:string|null; jumpAlias:string|null;
};
export type AddHostInput = {
  alias:string; hostname:string; port:number; username:string;
  identityAlias:string; pinnedHostKey:string|null;
};
const desktop = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
export function desktopAvailable(){return desktop();}
export async function vaultExists():Promise<boolean>{
  if(!desktop())return false;
  return invoke<boolean>("vault_exists");
}
export async function initializeVault(masterPassword:string):Promise<void>{
  if(!desktop())throw new Error("Requires the PaSSH7 desktop app");
  await invoke("vault_initialize",{masterPassword});
}
export async function unlockVault(masterPassword:string):Promise<void>{
  await invoke("vault_unlock",{masterPassword});
}
export async function lockVault():Promise<void>{await invoke("vault_lock")}
export async function vaultStatus():Promise<boolean>{return invoke<boolean>("vault_status")}
/** Refresh decrypted-Vault idle TTL only in response to local human input.
 * Never use this for remote PTY output, heartbeats, polling or timers. */
export async function touchVaultActivity():Promise<boolean>{
  return invoke<boolean>("vault_touch");
}
export type VaultBackupResult={remotePath:string;bytes:number;verified:boolean};
export type VaultBackupBatchTarget={id:string;alias:string;directory:string};
export type VaultBackupBatchOutcome={alias:string;remotePath:string|null;error:string|null};
export type VaultBackupBatchProgress={alias:string;index:number;total:number;stage:"started"|"verified"|"failed"};
export async function backupEncryptedVaultBatch(targets:VaultBackupBatchTarget[]):Promise<VaultBackupBatchOutcome[]>{
  return invoke<VaultBackupBatchOutcome[]>("ssh_session_vault_backup_batch",{targets});
}
export type VaultDifference={
  backupOnlyHosts:string[];
  localOnlyHosts:string[];
  changedHosts:string[];
  backupOnlyIdentities:string[];
  localOnlyIdentities:string[];
  changedIdentities:string[];
  otherMetadataChanged:boolean;
};
export type VaultRestorePreview={
  token:string;hosts:number;identities:number;hostAliases:string[];
  bytes:number;identicalToCurrent:boolean;sameContents:boolean;
  difference:VaultDifference;
};
export async function exportEncryptedVaultLocally():Promise<string|null>{
  return invoke<string|null>("vault_export_encrypted_backup");
}
export async function backupEncryptedVaultToSsh(sessionId:string,directory:string):Promise<VaultBackupResult>{
  return invoke<VaultBackupResult>("ssh_session_vault_backup",{id:sessionId,directory});
}
export async function inspectRemoteEncryptedVaultBackup(sessionId:string,path:string):Promise<VaultRestorePreview>{
  return invoke<VaultRestorePreview>("vault_restore_inspect_remote",{id:sessionId,path});
}
export async function inspectEncryptedVaultBackup():Promise<VaultRestorePreview|null>{
  return invoke<VaultRestorePreview|null>("vault_restore_inspect");
}
export async function commitEncryptedVaultRestore(token:string):Promise<void>{
  return invoke<void>("vault_restore_commit",{token});
}

export async function getHosts():Promise<HostSummary[]>{
  if(!desktop())throw new Error("Requires the PaSSH7 desktop app");
  return invoke<HostSummary[]>("vault_list_hosts");
}
export type LocalSshConfigHost={alias:string;hostname:string;username:string;port:number};
export async function discoverLocalSshConfigHosts():Promise<LocalSshConfigHost[]>{
  return invoke<LocalSshConfigHost[]>("ssh_discover_local_config_hosts");
}
export async function addHost(host:AddHostInput):Promise<void>{
  if(!desktop())throw new Error("Requires the PaSSH7 desktop app");
  await invoke("vault_add_host",{host});
}

export type UpdateHostInput={
  alias:string;displayName:string;hostname:string;port:number;username:string;identityAlias:string;
  resetHostKey:boolean;forgetCredentials:boolean;
};
export async function updateHost(host:UpdateHostInput):Promise<void>{
  if(!desktop())throw new Error("Requires the PaSSH7 desktop app");
  await invoke("vault_update_host",{host});
}

export async function setHostBackupDirectory(alias:string,directory:string|null):Promise<void>{
  await invoke<void>("vault_set_backup_directory",{alias,directory});
}

export async function setHostJumpRoute(alias:string,jumpAlias:string|null):Promise<void>{
  await invoke<void>("vault_set_jump_host",{alias,jumpAlias});
}
export async function setHostIdentity(alias:string,identityAlias:string):Promise<void>{
  await invoke("vault_set_host_identity",{alias,identityAlias});
}

export async function saveHostCredentials(alias:string,authMode:"key"|"password"|"key-password",accountPassword:string,keyPassphrase:string,preserveExisting=false):Promise<void>{
  await invoke("vault_save_host_credentials",{alias,authMode,accountPassword,keyPassphrase,preserveExisting});
}
export async function forgetHostCredentials(alias:string):Promise<void>{
  await invoke("vault_forget_host_credentials",{alias});
}
export async function getIdentities():Promise<string[]>{
  if(!desktop())throw new Error("Requires the PaSSH7 desktop app");
  return invoke<string[]>("vault_list_identities");
}
export async function importIdentity(alias:string,privateKeyPem:string,keyPassphrase?:string):Promise<void>{
  if(!desktop())throw new Error("Requires the PaSSH7 desktop app");
  await invoke("vault_import_identity",{alias,privateKeyPem,keyPassphrase:keyPassphrase||null});
}

export async function removeHost(alias:string):Promise<void>{
  if(!desktop())throw new Error("Requires the PaSSH7 desktop app");
  await invoke("vault_remove_host",{alias});
}
export async function removeIdentity(alias:string):Promise<void>{
  if(!desktop())throw new Error("Requires the PaSSH7 desktop app");
  await invoke("vault_remove_identity",{alias});
}

export type BuildInfo = {
  version:string; publisher:string; repository:string; commit:string;
  builtAt:string; runNumber:string; target:string;
};
export async function getBuildInfo():Promise<BuildInfo>{
  if(!desktop())return {version:"0.1.0",publisher:"PAS7 Studio",repository:"pas7-studio/PaSSH7",commit:"web-preview",builtAt:"not a packaged build",runNumber:"preview",target:"Web preview"};
  return invoke<BuildInfo>("app_build_info");
}

export type SshProbeResult = {banner:string; elapsedMs:number};
export async function probeSshHost(alias:string):Promise<SshProbeResult>{
  if(!desktop())throw new Error("SSH probes require the PaSSH7 desktop app");
  return invoke<SshProbeResult>("ssh_probe_host",{alias});
}

export type SshAuthResult={username:string;hostAlias:string;authenticated:boolean};
export async function authenticateSshHost(alias:string):Promise<SshAuthResult>{
  if(!desktop())throw new Error("Requires the PaSSH7 desktop app");
  return invoke<SshAuthResult>("ssh_authenticate",{alias});
}

export type OpenedSshSession = {id:string;alias:string};
export async function listLiveSshSessions():Promise<OpenedSshSession[]>{
  return invoke<OpenedSshSession[]>("ssh_session_list");
}
export type SshSessionEvent = {id:string;kind:"data"|"closed";data?:string;detail?:string};
export async function openSshSession(alias:string,cols:number,rows:number,accountPassword?:string,authMode:"key"|"password"|"key-password"="key",keyPassphrase?:string,useSavedCredentials=false):Promise<OpenedSshSession>{
  return invoke<OpenedSshSession>("ssh_session_open",{alias,cols,rows,accountPassword:accountPassword||null,authMode,keyPassphrase:keyPassphrase||null,useSavedCredentials});
}
// One FIFO per SSH session, shared by xterm keystrokes, snippets, Docker
// shell launch and AI agent launch. Tauri IPC calls are individually async:
// without this queue a later UI action can reach the native PTY before bytes
// queued by the interactive terminal. Different SSH sessions never block
// each other. Always remove settled tails so closed sessions retain no state.
const pendingSshWrites=new Map<string,Promise<void>>();
export function writeSshSession(id:string,data:string):Promise<void>{
  const previous=pendingSshWrites.get(id);
  const next=(previous??Promise.resolve()).catch(()=>{}).then(()=>
    invoke<void>("ssh_session_write",{id,data})
  );
  pendingSshWrites.set(id,next);
  void next.then(
    ()=>{if(pendingSshWrites.get(id)===next)pendingSshWrites.delete(id)},
    ()=>{if(pendingSshWrites.get(id)===next)pendingSshWrites.delete(id)}
  );
  return next;
}
export async function resizeSshSession(id:string,cols:number,rows:number):Promise<void>{
  return invoke("ssh_session_resize",{id,cols,rows});
}
export async function readySshSession(id:string):Promise<void>{
  return invoke("ssh_session_ready",{id});
}
export async function closeSshSession(id:string):Promise<void>{
  return invoke("ssh_session_close",{id});
}

export type GeneratedPublicKey={alias:string;publicKey:string;fingerprint:string};
export async function generateEd25519(alias:string,comment:string):Promise<GeneratedPublicKey>{
  return invoke<GeneratedPublicKey>("vault_generate_ed25519",{alias,comment});
}

export async function getPublicIdentity(alias:string):Promise<GeneratedPublicKey>{
  return invoke<GeneratedPublicKey>("vault_public_identity",{alias});
}

/** Remote Docker CLI JSON lines, collected through an authenticated SSH exec channel. */
export async function listDockerContainers(sessionId:string):Promise<string>{
  return invoke<string>("ssh_session_docker_list",{id:sessionId});
}
export type DockerDetails={
  created:string|null;startedAt:string|null;finishedAt:string|null;restartPolicy:string|null;image:string|null;
  mounts:{type:string|null;source:string|null;destination:string|null;rw:boolean|null}[];
  networks:string[];
};
/** Only a Rust-projected safe subset of docker inspect is exposed; Env and Labels are excluded. */
export async function inspectDockerContainer(sessionId:string,containerId:string):Promise<DockerDetails>{
  const json=await invoke<string>("ssh_session_docker_inspect",{id:sessionId,containerId});
  return JSON.parse(json) as DockerDetails;
}
export type DockerRuntimeStats={ID?:string;Name?:string;CPUPerc?:string;MemUsage?:string;MemPerc?:string};
/** Single read-only sample from docker stats; neither secrets nor inspect Env are requested. */
export async function listDockerStats(sessionId:string):Promise<DockerRuntimeStats[]>{
  const raw=await invoke<string>("ssh_session_docker_catalog",{id:sessionId,kind:"stats"});
  return raw.split(/\r?\n/).map(line=>line.trim()).filter(Boolean)
    .map(line=>JSON.parse(line) as DockerRuntimeStats);
}
/** Returns at most 200 timestamped lines for one container. Does not start, stop or mutate Docker. */
export type DockerCatalogKind="images"|"volumes"|"networks"|"compose";
export async function listDockerCatalog(sessionId:string,kind:DockerCatalogKind):Promise<Record<string,string>[]>{
  const raw=await invoke<string>("ssh_session_docker_catalog",{id:sessionId,kind});
  if(kind==="compose"){
    const parsed=JSON.parse(raw.trim()) as unknown;
    if(!Array.isArray(parsed))throw Error("Docker Compose returned an unexpected project list format.");
    return parsed.slice(0,250).map((item:unknown)=>{
      if(!item||typeof item!=="object"||Array.isArray(item))throw Error("Invalid Docker Compose project record.");
      const record=item as Record<string,unknown>;
      return {Name:String(record.Name??"—"),Status:String(record.Status??"—"),
        ConfigFiles:String(record.ConfigFiles??"—")};
    });
  }
  return raw.split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line) as Record<string,string>);
}
/** Read-only Compose project member lookup by validated Docker label. Never reads compose files. */
export async function listComposeProjectContainers(sessionId:string,projectName:string):Promise<Record<string,string>[]>{
  if(!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(projectName))throw Error("Invalid Docker Compose project name.");
  const raw=await invoke<string>("ssh_session_docker_catalog",{id:sessionId,kind:"compose-project:"+projectName});
  return raw.split(/\r?\n/).filter(Boolean).slice(0,500)
    .map(line=>JSON.parse(line) as Record<string,string>);
}
export type DockerLogEvent={
  sessionId:string;streamId:string;containerId:string;
  kind:"data"|"closed"|"error";data:string|null;detail:string|null;
};
export async function startDockerLogStream(sessionId:string,containerId:string,tail=0):Promise<string>{
  return invoke<string>("ssh_session_docker_log_start",{id:sessionId,containerId,tail});
}
export async function stopDockerLogStream(sessionId:string,streamId:string):Promise<void>{
  await invoke<void>("ssh_session_docker_log_stop",{id:sessionId,streamId});
}
export async function readDockerLogs(sessionId:string,containerId:string,tail=200):Promise<string>{
  return invoke<string>("ssh_session_docker_logs",{id:sessionId,containerId,tail});
}
/** Native Windows/Linux Save As. Returns null on cancel; existing files are not overwritten. */
export async function saveVisibleDockerLogs(containerName:string,contents:string):Promise<string|null>{
  return invoke<string|null>("docker_save_visible_logs",{containerName,contents});
}
/** Explicitly confirmed container state operation. Container ID and action are native validated. */
export async function controlDockerContainer(sessionId:string,containerId:string,action:"start"|"stop"|"restart"):Promise<string>{
  return invoke<string>("ssh_session_docker_action",{id:sessionId,containerId,action});
}

/** Configures the bounded native Vault idle lock. This is a local UI policy,
 * never extended by remote CLI or SSH background activity. */
export async function setVaultIdleTimeout(minutes:15|30|60|240|480):Promise<number>{
  return invoke<number>("vault_set_idle_timeout",{minutes});
}
/** Reads user clipboard for interactive SSH terminal paste, never logs or persists it.
 * On Windows native Win32 clipboard avoids WebView permission-prompt failures. */
/** Remaining idle-lock time in seconds; null when Never or Vault is locked.
 * Observation does not keep the Vault or any SSH capability alive. */
export async function getVaultIdleRemaining():Promise<number|null>{
  return invoke<number|null>("vault_idle_remaining");
}
export async function readTerminalClipboard():Promise<string>{
  return invoke<string>("terminal_clipboard_read");
}
export type LocalAgentAvailability={installed:boolean;path:string|null;diagnostic:string};
export async function probeLocalAgent(agent:"codex"|"claude"|"opencode"):Promise<LocalAgentAvailability>{
  return invoke<LocalAgentAvailability>("local_agent_probe",{agent});
}
export async function launchLocalAgent(agent:"codex"|"claude"|"opencode",sessionId:string):Promise<string>{
  return invoke<string>("local_agent_launch",{agent,id:sessionId});
}
/** Non-secret inventory of SSH capabilities issued to live local CLI consoles. */
export type LocalAgentConnection={
  id:string;agent:"codex"|"claude"|"opencode";
  sessionId:string;host:string;ageSeconds:number;
  status:"active"|"expired"|"disconnected";
};
export async function listLocalAgentConnections():Promise<LocalAgentConnection[]>{
  return invoke<LocalAgentConnection[]>("local_agent_connections");
}
/** Only the desktop user can restore the original process token to an SSH
 * session on the same saved host. Never returns secret grant material. */
export async function reauthorizeLocalAgentConnection(id:string,sessionId:string):Promise<boolean>{
  return invoke<boolean>("local_agent_reauthorize",{id,sessionId});
}
/** Revokes SSH tool access only. Does not close or kill the local CLI console. */
export async function revokeLocalAgentConnection(id:string):Promise<boolean>{
  return invoke<boolean>("local_agent_revoke",{id});
}
export type RemoteExecResult={stdout:string;stderr:string;exitCode:number;truncated:boolean};
export async function executeRemoteCommand(sessionId:string,command:string):Promise<RemoteExecResult>{
  return invoke<RemoteExecResult>("ssh_session_exec",{id:sessionId,command});
}
export type RemoteAgentAvailability={
  installed:boolean;version:string|null;
  platform:"windows"|"unix";
  source:string|null;location:string|null;
  desktopApp:string|null;launchCommand:string|null;diagnostic:string|null;
};
export async function probeRemoteAgent(sessionId:string,agent:"codex"|"claude"|"opencode"):Promise<RemoteAgentAvailability>{
  return invoke<RemoteAgentAvailability>("ssh_session_agent_probe",{id:sessionId,agent});
}

export type DiscoveredHostKey = {fingerprint:string};
export async function discoverSshHostKeyVia(alias:string):Promise<DiscoveredHostKey>{
  return invoke<DiscoveredHostKey>("ssh_discover_host_key_via",{alias});
}
export async function discoverSshHostKey(alias:string):Promise<DiscoveredHostKey>{
  return invoke<DiscoveredHostKey>("ssh_discover_host_key",{alias});
}
export async function pinSshHostKey(alias:string,fingerprint:string):Promise<void>{
  return invoke("vault_pin_host_key",{alias,fingerprint});
}

export type SftpEntry={name:string;isDir:boolean;sizeBytes:number|null;modifiedAt:number|null;unixPermissions:number|null;ownerId:number|null;groupId:number|null};
export async function mutateSftpFile(sessionId:string,operation:"mkdir"|"delete"|"rename",directory:string,name:string,isDirectory=false,newName?:string):Promise<void>{
  return invoke<void>("ssh_session_sftp_mutate",{id:sessionId,operation,directory,name,newName:newName??null,isDirectory});
}
export async function listSftpDirectory(sessionId:string,path:string):Promise<SftpEntry[]>{
  return invoke<SftpEntry[]>("ssh_session_sftp_list",{id:sessionId,path});
}

export async function startLocalForward(sessionId:string,localPort:number,targetHost:string,remotePort:number):Promise<void>{
  return invoke("ssh_session_forward_start",{id:sessionId,localPort,targetHost,remotePort});
}
export type NativeLocalForward={localPort:number;targetHost:string;remotePort:number};
export async function listLocalForwards(sessionId:string):Promise<NativeLocalForward[]>{
  return invoke<NativeLocalForward[]>("ssh_session_forward_list",{id:sessionId});
}
export async function stopLocalForward(sessionId:string,localPort:number):Promise<void>{
  return invoke("ssh_session_forward_stop",{id:sessionId,localPort});
}

/** Returns a completion message or null if the native Save As dialog was cancelled.
 * Transfers are native streamed SFTP, never JS blobs or browser downloads.
 */
export type SftpTransferEvent={
  sessionId:string;
  transferId:string;
  direction:"upload"|"download";
  stage:"started"|"progress";
  bytes:number;
  totalBytes:number|null;
};
export async function downloadSftpFile(sessionId:string,path:string,transferId:string):Promise<string|null>{
  return invoke<string|null>("ssh_session_sftp_download",{id:sessionId,path,transferId});
}
export async function uploadSftpFile(sessionId:string,directory:string,transferId:string):Promise<string|null>{
  return invoke<string|null>("ssh_session_sftp_upload",{id:sessionId,directory,transferId});
}
export async function cancelSftpTransfer(sessionId:string,transferId:string):Promise<void>{
  await invoke("ssh_session_sftp_cancel",{id:sessionId,transferId});
}

/** Small, magic-byte-verified PNG/JPEG/GIF/WebP data URL. Max 768 KiB. */
export async function readSftpImage(sessionId:string,path:string):Promise<string>{
  return invoke<string>("ssh_session_sftp_read_image",{id:sessionId,path});
}
export async function readSftpText(sessionId:string,path:string):Promise<string>{
  return invoke<string>("ssh_session_sftp_read_text",{id:sessionId,path});
}
