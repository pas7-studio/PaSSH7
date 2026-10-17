export type PaneSizes={
  filesTree:number;
  filesInspector:number;
  dockerInspector:number;
  dockerLogs:number;
};
export const defaultPaneSizes:PaneSizes={
  filesTree:212,filesInspector:300,dockerInspector:310,dockerLogs:310
};
const paneSize=(value:unknown,fallback:number,min:number,max:number)=>
  typeof value==="number"&&Number.isFinite(value)?Math.min(max,Math.max(min,Math.round(value))):fallback;

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
  paneSizes:PaneSizes;
};
export const defaultPreferences:AppPreferences={
  theme:"dark",density:"comfortable",terminalFontSize:13,terminalScrollback:5000,
  dockerTail:200,dockerAutoRefresh:false,dockerFollowLogs:false,
  sftpShowHidden:true,sftpSort:"folders",confirmTransfer:true,
  rememberWorkspace:true,paneSizes:{...defaultPaneSizes}
};
const KEY="passh7.preferences.v1";
// This is non-secret UI configuration only. SSH keys, passwords and host pins
// never enter browser storage; they live in the separately encrypted native Vault.
export function validatePreferences(source:unknown):AppPreferences{
  if(source===null||typeof source!=="object"||Array.isArray(source)){
    return {...defaultPreferences};
  }
  const data=source as Partial<AppPreferences>;
  const layout=data.paneSizes;
  return {
    theme:data.theme==="light"?"light":"dark",
    density:data.density==="compact"?"compact":"comfortable",
    terminalFontSize:typeof data.terminalFontSize==="number"&&Number.isInteger(data.terminalFontSize)&&data.terminalFontSize>=10&&data.terminalFontSize<=22?data.terminalFontSize:13,
    terminalScrollback:[1000,5000,10000,20000].includes(data.terminalScrollback??0)?data.terminalScrollback!:5000,
    dockerTail:[50,100,200,500,1000].includes(data.dockerTail??0)?data.dockerTail!:200,
    dockerAutoRefresh:data.dockerAutoRefresh===true,
    dockerFollowLogs:data.dockerFollowLogs===true,
    sftpShowHidden:data.sftpShowHidden!==false,
    sftpSort:["folders","name","size","modified"].includes(data.sftpSort??"")?data.sftpSort!:"folders",
    confirmTransfer:data.confirmTransfer!==false,
    rememberWorkspace:data.rememberWorkspace!==false,
    paneSizes:{
      filesTree:paneSize(layout?.filesTree,defaultPaneSizes.filesTree,150,360),
      filesInspector:paneSize(layout?.filesInspector,defaultPaneSizes.filesInspector,245,500),
      dockerInspector:paneSize(layout?.dockerInspector,defaultPaneSizes.dockerInspector,265,520),
      dockerLogs:paneSize(layout?.dockerLogs,defaultPaneSizes.dockerLogs,240,620)
    }
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
