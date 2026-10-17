export type AppPreferences={
  theme:"dark"|"light";
  density:"comfortable"|"compact";
  terminalFontSize:number;
  terminalScrollback:number;
  dockerTail:number;
  dockerAutoRefresh:boolean;
  dockerFollowLogs:boolean;
  vaultAutoLockMinutes:0|5|15|30|60;
  vaultLockOnBlur:boolean;
  sftpShowHidden:boolean;
  sftpSort:"folders"|"name"|"size"|"modified";
  confirmTransfer:boolean;
  rememberWorkspace:boolean;
};
export const defaultPreferences:AppPreferences={
  theme:"dark",density:"comfortable",terminalFontSize:13,terminalScrollback:5000,
  dockerTail:200,dockerAutoRefresh:false,dockerFollowLogs:false,
  vaultAutoLockMinutes:0,vaultLockOnBlur:false,
  sftpShowHidden:true,sftpSort:"folders",confirmTransfer:true,
  rememberWorkspace:true
};
const KEY="passh7.preferences.v1";
// This is non-secret UI configuration only. SSH keys, passwords and host pins
// never enter browser storage; they live in the separately encrypted native Vault.
export function validatePreferences(source:unknown):AppPreferences{
  if(source===null||typeof source!=="object"||Array.isArray(source)){
    return {...defaultPreferences};
  }
  const data=source as Partial<AppPreferences>;
  return {
    theme:data.theme==="light"?"light":"dark",
    density:data.density==="compact"?"compact":"comfortable",
    terminalFontSize:typeof data.terminalFontSize==="number"&&Number.isInteger(data.terminalFontSize)&&data.terminalFontSize>=10&&data.terminalFontSize<=22?data.terminalFontSize:13,
    terminalScrollback:[1000,5000,10000,20000].includes(data.terminalScrollback??0)?data.terminalScrollback!:5000,
    dockerTail:[50,100,200,500,1000].includes(data.dockerTail??0)?data.dockerTail!:200,
    dockerAutoRefresh:data.dockerAutoRefresh===true,
    dockerFollowLogs:data.dockerFollowLogs===true,
    vaultAutoLockMinutes:([0,5,15,30,60].includes(data.vaultAutoLockMinutes??-1)?data.vaultAutoLockMinutes:0) as AppPreferences["vaultAutoLockMinutes"],
    vaultLockOnBlur:data.vaultLockOnBlur===true,
    sftpShowHidden:data.sftpShowHidden!==false,
    sftpSort:["folders","name","size","modified"].includes(data.sftpSort??"")?data.sftpSort!:"folders",
    confirmTransfer:data.confirmTransfer!==false,
    rememberWorkspace:data.rememberWorkspace!==false
  };
}
export function loadPreferences():AppPreferences{
  try{return validatePreferences(JSON.parse(localStorage.getItem(KEY)||"{}"))}
  catch{return {...defaultPreferences}}
}
export function savePreferences(value:AppPreferences):void{
  const normalized=validatePreferences(value);
  localStorage.setItem(KEY,JSON.stringify(normalized));
  window.dispatchEvent(new CustomEvent("passh7:preferences",{detail:normalized}));
}
