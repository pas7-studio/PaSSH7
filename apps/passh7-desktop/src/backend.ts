import {invoke} from "@tauri-apps/api/core";

export type HostSummary = {
  alias:string; hostname:string; port:number; username:string;
  identityAlias:string; hostKeyPinned:boolean; hasSavedCredentials:boolean; savedAuthMode:string|null;
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
export async function getHosts():Promise<HostSummary[]>{
  if(!desktop())throw new Error("Requires the PaSSH7 desktop app");
  return invoke<HostSummary[]>("vault_list_hosts");
}
export async function addHost(host:AddHostInput):Promise<void>{
  if(!desktop())throw new Error("Requires the PaSSH7 desktop app");
  await invoke("vault_add_host",{host});
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
export async function writeSshSession(id:string,data:string):Promise<void>{
  return invoke("ssh_session_write",{id,data});
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
/** Returns at most 200 timestamped lines for one container. Does not start, stop or mutate Docker. */
export async function readDockerLogs(sessionId:string,containerId:string):Promise<string>{
  return invoke<string>("ssh_session_docker_logs",{id:sessionId,containerId});
}

export type DiscoveredHostKey = {fingerprint:string};
export async function discoverSshHostKey(alias:string):Promise<DiscoveredHostKey>{
  return invoke<DiscoveredHostKey>("ssh_discover_host_key",{alias});
}
export async function pinSshHostKey(alias:string,fingerprint:string):Promise<void>{
  return invoke("vault_pin_host_key",{alias,fingerprint});
}

export type SftpEntry={name:string;isDir:boolean};
export async function listSftpDirectory(sessionId:string,path:string):Promise<SftpEntry[]>{
  return invoke<SftpEntry[]>("ssh_session_sftp_list",{id:sessionId,path});
}

export async function startLocalForward(sessionId:string,localPort:number,targetHost:string,remotePort:number):Promise<void>{
  return invoke("ssh_session_forward_start",{id:sessionId,localPort,targetHost,remotePort});
}
export async function stopLocalForward(sessionId:string,localPort:number):Promise<void>{
  return invoke("ssh_session_forward_stop",{id:sessionId,localPort});
}

/** Returns a completion message or null if the native Save As dialog was cancelled.
 * Transfers are native streamed SFTP, never JS blobs or browser downloads.
 */
export async function downloadSftpFile(sessionId:string,path:string):Promise<string|null>{
  return invoke<string|null>("ssh_session_sftp_download",{id:sessionId,path});
}
export async function uploadSftpFile(sessionId:string,directory:string):Promise<string|null>{
  return invoke<string|null>("ssh_session_sftp_upload",{id:sessionId,directory});
}

export async function readSftpText(sessionId:string,path:string):Promise<string>{
  return invoke<string>("ssh_session_sftp_read_text",{id:sessionId,path});
}
