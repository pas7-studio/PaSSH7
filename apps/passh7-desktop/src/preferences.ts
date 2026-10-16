export type AppPreferences={
  theme:"dark"|"light";
  density:"comfortable"|"compact";
  terminalFontSize:number;
  terminalScrollback:number;
  dockerTail:number;
  dockerAutoRefresh:boolean;
  dockerFollowLogs:boolean;
  sftpShowHidden:boolean;
  sftpSort:"folders"|"name"|"size"|"modified";
  confirmTransfer:boolean;
  rememberWorkspace:boolean;
};
export const defaultPreferences:AppPreferences={
  theme:"dark",density:"comfortable",terminalFontSize:13,terminalScrollback:5000,
  dockerTail:200,dockerAutoRefresh:false,dockerFollowLogs:false,
  sftpShowHidden:true,sftpSort:"folders",confirmTransfer:true,
  rememberWorkspace:true
};
const KEY="passh7.preferences.v1";
// Settings here contain no secrets. SSH keys, credentials, host pins and vault
// backups remain native Rust Vault data, never stored in browser storage.
export function loadPreferences():AppPreferences{
  try{
    const data=JSON.parse(localStorage.getItem(KEY)||"{}") as Partial<AppPreferences>;
    return {
      theme:data.theme==="light"?"light":"dark",
      density:data.density==="compact"?"compact":"comfortable",
      terminalFontSize:Number.isInteger(data.terminalFontSize)&&data.terminalFontSize!>=10&&data.terminalFontSize!<=22?data.terminalFontSize!:13,
      terminalScrollback:[1000,5000,10000,20000].includes(data.terminalScrollback||0)?data.terminalScrollback!:5000,
      dockerTail:[50,100,200,500,1000].includes(data.dockerTail||0)?data.dockerTail!:200,
      dockerAutoRefresh:data.dockerAutoRefresh===true,
      dockerFollowLogs:data.dockerFollowLogs===true,
      sftpShowHidden:data.sftpShowHidden!==false,
      sftpSort:["folders","name","size","modified"].includes(data.sftpSort||"")?data.sftpSort!: "folders",
      confirmTransfer:data.confirmTransfer!==false,
      rememberWorkspace:data.rememberWorkspace!==false
    };
  }catch{return {...defaultPreferences}}
}
export function savePreferences(value:AppPreferences):void{
  localStorage.setItem(KEY,JSON.stringify(value));
  window.dispatchEvent(new CustomEvent("passh7:preferences",{detail:value}));
}
