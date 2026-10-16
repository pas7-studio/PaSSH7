import {useRef,useState} from "react";
import {Activity, Bot, Container, FolderClosed, LockKeyhole, Monitor, Settings2, ShieldCheck, TerminalSquare} from "lucide-react";
import {type AppPreferences,defaultPreferences,validatePreferences} from "./preferences";
import type {BuildInfo} from "./backend";

type Section="general"|"terminal"|"files"|"docker"|"security"|"network"|"agents"|"diagnostics";
const sections:{id:Section;label:string;hint:string;Icon:typeof Settings2}[]=[
  {id:"general",label:"General",hint:"Workspace & appearance",Icon:Settings2},
  {id:"terminal",label:"Terminal",hint:"Fonts and scrolling",Icon:TerminalSquare},
  {id:"files",label:"Transfers & SFTP",hint:"File browser options",Icon:FolderClosed},
  {id:"docker",label:"Docker",hint:"Inventory and log viewer",Icon:Container},
  {id:"security",label:"Vault & Security",hint:"Encrypted credentials",Icon:LockKeyhole},
  {id:"network",label:"SSH & Networking",hint:"Jump routes and forwards",Icon:Activity},
  {id:"agents",label:"AI Agents",hint:"Remote CLI diagnostics",Icon:Bot},
  {id:"diagnostics",label:"About & Diagnostics",hint:"Build information",Icon:ShieldCheck}
];
type Props={preferences:AppPreferences;onChange:(p:AppPreferences)=>void;
  buildInfo:BuildInfo|null;vaultUnlocked:boolean;onLock:()=>void;onExport:()=>void;onRestore:()=>void};
export default function SettingsWorkspace({preferences,onChange,buildInfo,vaultUnlocked,onLock,onExport,onRestore}:Props){
  const [section,setSection]=useState<Section>("general");
  const [importError,setImportError]=useState("");
  const inputRef=useRef<HTMLInputElement>(null);
  const exportSettings=()=>{
    const blob=new Blob([JSON.stringify({format:"passh7-preferences",version:1,preferences},null,2)],{type:"application/json"});
    const url=URL.createObjectURL(blob);
    const a=document.createElement("a");
    a.href=url;a.download="passh7-preferences.json";a.click();
    window.setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
  const importSettings=async(file:File|undefined)=>{
    if(!file)return;
    if(file.size>16*1024){setImportError("Settings file exceeds 16 KiB.");return;}
    try{
      const json=JSON.parse(await file.text()) as unknown;
      if(!json||typeof json!=="object"||Array.isArray(json)||
         (json as Record<string,unknown>).format!=="passh7-preferences"||
         (json as Record<string,unknown>).version!==1){
        throw new Error("Not a supported PaSSH7 settings export.");
      }
      const imported=validatePreferences((json as Record<string,unknown>).preferences);
      if(window.confirm("Replace local non-secret interface preferences with the imported settings? Vault credentials, SSH keys and host profiles are not affected.")){
        onChange(imported);setImportError("");
      }
    }catch(error){setImportError("Cannot import settings: "+String(error))}
    finally{if(inputRef.current)inputRef.current.value="";}
  };

  const update=<K extends keyof AppPreferences>(key:K,value:AppPreferences[K])=>
    onChange({...preferences,[key]:value});
  const toggle=(label:string,hint:string,key:keyof AppPreferences)=>(
    <label className="prefRow"><span><strong>{label}</strong><small>{hint}</small></span>
      <input type="checkbox" checked={Boolean(preferences[key])} onChange={e=>update(key,e.target.checked as never)}/></label>
  );
  return <div className="widePage settingsPage">
    <div className="widePageTitle"><Settings2 size={25}/><div><h1>Settings</h1><p>Configure how PaSSH7 works. Preferences are saved automatically on this device.</p></div></div>
    <div className="settingsImportBar">
      <button onClick={exportSettings}>Export UI settings…</button>
      <button onClick={()=>inputRef.current?.click()}>Import UI settings…</button>
      <button onClick={()=>{if(window.confirm("Reset all interface preferences? This will NOT delete your encrypted Vault or remote server backups."))onChange({...defaultPreferences})}}>Reset all preferences</button>
      <input hidden ref={inputRef} type="file" accept=".json,application/json" aria-label="Import PaSSH7 preferences JSON" onChange={e=>void importSettings(e.target.files?.[0])}/>
      {importError&&<p className="workspaceError" role="alert">{importError}</p>}
    </div>
    <div className="settingsLayout">
      <nav className="settingsNav" aria-label="Settings categories">{sections.map(({id,label,hint,Icon})=>
        <button key={id} className={section===id?"selected":""} onClick={()=>setSection(id)}><Icon size={18}/><span><strong>{label}</strong><small>{hint}</small></span></button>)}</nav>
      <div className="settingsContent">
        <div className="settingsHeading"><div><h2>{sections.find(s=>s.id===section)?.label}</h2><p>Changes apply immediately. Options not supported by the SSH backend are not presented as active controls.</p></div><button disabled={!["general","terminal","files","docker"].includes(section)} onClick={()=>{switch(section){case "general":onChange({...preferences,theme:defaultPreferences.theme,density:defaultPreferences.density,rememberWorkspace:defaultPreferences.rememberWorkspace});break;case "terminal":onChange({...preferences,terminalFontSize:defaultPreferences.terminalFontSize,terminalScrollback:defaultPreferences.terminalScrollback});break;case "files":onChange({...preferences,sftpShowHidden:defaultPreferences.sftpShowHidden,sftpSort:defaultPreferences.sftpSort,confirmTransfer:defaultPreferences.confirmTransfer});break;case "docker":onChange({...preferences,dockerTail:defaultPreferences.dockerTail,dockerAutoRefresh:defaultPreferences.dockerAutoRefresh,dockerFollowLogs:defaultPreferences.dockerFollowLogs});break;default:break}}}>Reset section</button></div>
        {section==="general"&&<section className="settingsCard"><h3>Workspace & appearance</h3>
          {toggle("Remember workspace","Reopen the selected Files, Docker or Terminal page after restart.","rememberWorkspace")}
          <label className="prefRow"><span><strong>Theme</strong><small>Choose the app's appearance.</small></span><select value={preferences.theme} onChange={e=>update("theme",e.target.value as AppPreferences["theme"])}><option value="dark">Dark</option><option value="light">Light</option></select></label>
          <label className="prefRow"><span><strong>Display density</strong><small>Comfortable or compact tables and controls.</small></span><select value={preferences.density} onChange={e=>update("density",e.target.value as AppPreferences["density"])}><option value="comfortable">Comfortable</option><option value="compact">Compact</option></select></label>
        </section>}
        {section==="terminal"&&<section className="settingsCard"><h3>Terminal rendering</h3>
          <label className="prefRow"><span><strong>Font size</strong><small>Applied to xterm terminal instances.</small></span><input type="number" min={10} max={22} value={preferences.terminalFontSize} onChange={e=>update("terminalFontSize",Math.max(10,Math.min(22,Number(e.target.value)||13)))}/></label>
          <label className="prefRow"><span><strong>Scrollback</strong><small>Lines retained in each terminal tab.</small></span><select value={preferences.terminalScrollback} onChange={e=>update("terminalScrollback",Number(e.target.value))}>{[1000,5000,10000,20000].map(x=><option value={x} key={x}>{x.toLocaleString()} lines</option>)}</select></label>
        </section>}
        {section==="files"&&<section className="settingsCard"><h3>File browser and transfer options</h3>
          {toggle("Show hidden files","Include dotfiles in the remote file table.","sftpShowHidden")}
          {toggle("Confirm transfer","Ask for confirmation before initiating a file upload or download.","confirmTransfer")}
          <label className="prefRow"><span><strong>Default sort</strong><small>Ordering for SFTP directory tables.</small></span><select value={preferences.sftpSort} onChange={e=>update("sftpSort",e.target.value as AppPreferences["sftpSort"])}><option value="folders">Folders first</option><option value="name">Name</option><option value="size">Largest first</option><option value="modified">Newest first</option></select></label>
          <p className="prefInfo">Transfers remain bounded and non-overwriting by the native SFTP implementation. The current backend limit is 64 MiB per file.</p>
        </section>}
        {section==="docker"&&<section className="settingsCard"><h3>Container operations & logs</h3>
          <label className="prefRow"><span><strong>Log tail</strong><small>How many of the latest lines to request (bounded by native Rust).</small></span><select value={preferences.dockerTail} onChange={e=>update("dockerTail",Number(e.target.value))}>{[50,100,200,500,1000].map(x=><option value={x} key={x}>{x} lines</option>)}</select></label>
          {toggle("Auto-refresh inventory","Reload remote containers every 15 seconds while Docker is open.","dockerAutoRefresh")}
          {toggle("Follow recent logs","Poll for updated bounded log tail while a container is selected.","dockerFollowLogs")}
          <p className="prefInfo">These operations use your connected SSH user's Docker privileges. Follow mode polls the server and can be disabled at any time.</p>
        </section>}
        {section==="security"&&<section className="settingsCard"><h3>Encrypted Vault</h3>
          <p className="prefInfo">Keys, passwords and verified SSH host pins are stored only in the native encrypted Vault. These browser preferences contain no secrets.</p>
          <div className="settingsActions"><button onClick={onExport} disabled={!vaultUnlocked}>Export encrypted backup…</button><button onClick={onRestore} disabled={!vaultUnlocked}>Inspect and restore backup…</button><button onClick={onLock} disabled={!vaultUnlocked}>Lock Vault now</button></div>
          <p className="prefInfo">For remote backups, use Remote Files on a connected server. Restore requires explicit confirmation; it does not silently merge changes.</p>
        </section>}
        {section==="network"&&<section className="settingsCard"><h3>SSH routing and forwarding</h3>
          <p>Choose an SSH host in the left sidebar to configure its Direct / Via gateway route. Hosts maintain independent pinned fingerprints and identities.</p>
          <p className="prefInfo">Port forwards are available in the Terminal workspace under Context → Ports. Native networking only binds local listeners explicitly approved by you.</p>
        </section>}
        {section==="agents"&&<section className="settingsCard"><h3>Remote CLI agents</h3>
          <p>Codex, Claude Code and OpenCode run with your remote SSH account permissions. The detection probe searches the remote login-interactive PATH, not local Windows installations.</p>
          <p className="prefInfo">A failed version probe does not block manual agent launch. Configure provider credentials on each server and inspect the command in its SSH terminal.</p>
        </section>}
        {section==="diagnostics"&&<section className="settingsCard"><h3>Build details</h3>
          <dl className="diagnosticList"><dt>Version</dt><dd>{buildInfo?.version||"Unknown"}</dd><dt>Publisher</dt><dd>{buildInfo?.publisher||"PAS7 Studio"}</dd><dt>Target</dt><dd>{buildInfo?.target||"Unknown"}</dd><dt>Built at</dt><dd>{buildInfo?.builtAt||"Unknown"}</dd><dt>Commit</dt><dd>{buildInfo?.commit?.slice(0,16)||"Unknown"}</dd><dt>Build</dt><dd>{buildInfo?.runNumber||"Unknown"}</dd></dl>
          <button onClick={()=>navigator.clipboard.writeText(JSON.stringify({build:buildInfo,settings:preferences},null,2))}>Copy non-secret diagnostics</button>
        </section>}
      </div>
      <aside className="settingsHelp"><div className="settingsCard"><h3><Monitor size={17}/> Application</h3><p>PaSSH7 · {buildInfo?.version||"Preview"}</p><p className="prefInfo">Build {buildInfo?.runNumber||"Local"} · {buildInfo?.target||"Desktop"}</p></div>
        <div className="settingsCard"><h3><LockKeyhole size={17}/> Vault status</h3><p className={vaultUnlocked?"textGood":""}>{vaultUnlocked?"● Unlocked":"○ Locked"}</p><button onClick={onLock} disabled={!vaultUnlocked}>Lock now</button></div>
        <div className="settingsCard"><h3>Configuration</h3><p className="prefInfo">Appearance and interface preferences are stored locally on this computer. Encrypted Vault backups are a separate operation.</p></div></aside>
    </div>
  </div>;
}
