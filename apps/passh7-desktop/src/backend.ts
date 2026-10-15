import {invoke} from "@tauri-apps/api/core";

export type HostSummary = {
  alias:string; hostname:string; port:number; username:string;
  identityAlias:string; hostKeyPinned:boolean;
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

export async function getIdentities():Promise<string[]>{
  if(!desktop())throw new Error("Requires the PaSSH7 desktop app");
  return invoke<string[]>("vault_list_identities");
}
export async function importIdentity(alias:string,privateKeyPem:string):Promise<void>{
  if(!desktop())throw new Error("Requires the PaSSH7 desktop app");
  await invoke("vault_import_identity",{alias,privateKeyPem});
}

export async function removeHost(alias:string):Promise<void>{
  if(!desktop())throw new Error("Requires the PaSSH7 desktop app");
  await invoke("vault_remove_host",{alias});
}
export async function removeIdentity(alias:string):Promise<void>{
  if(!desktop())throw new Error("Requires the PaSSH7 desktop app");
  await invoke("vault_remove_identity",{alias});
}
