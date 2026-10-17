import {useRef,useState,type ReactNode} from "react";
import {Activity,Bell,Bot,ChevronDown,Clipboard,Container,Download,FolderClosed,Info,Keyboard,LockKeyhole,Monitor,Palette,RefreshCw,Settings2,ShieldCheck,TerminalSquare,Upload} from "lucide-react";
import {type AppPreferences,defaultPreferences,defaultPaneSizes,validatePreferences} from "./preferences";
import type {BuildInfo} from "./backend";

type Section="general"|"ssh"|"security"|"terminal"|"files"|"docker"|"ports"|"agents"|"notifications"|"appearance"|"shortcuts"|"diagnostics";
const sections:{id:Section;label:string;hint:string;Icon:typeof Settings2}[]=[
  {id:"general",label:"General",hint:"App behavior and startup",Icon:Settings2},
  {id:"ssh",label:"SSH",hint:"Connections and host trust",Icon:TerminalSquare},
  {id:"security",label:"Vault & Security",hint:"Encryption and credentials",Icon:LockKeyhole},
  {id:"terminal",label:"Terminal",hint:"Appearance and behavior",Icon:Monitor},
  {id:"files",label:"Transfers & SFTP",hint:"Remote file settings",Icon:FolderClosed},
  {id:"docker",label:"Docker",hint:"Containers and logs",Icon:Container},
  {id:"ports",label:"Port Forwarding",hint:"Tunnels and networking",Icon:Activity},
  {id:"agents",label:"AI Agents",hint:"Remote CLI workflow",Icon:Bot},
  {id:"notifications",label:"Notifications",hint:"Connection status and alerts",Icon:Bell},
  {id:"appearance",label:"Appearance",hint:"Theme and layout",Icon:Palette},
  {id:"shortcuts",label:"Shortcuts",hint:"Keyboard navigation",Icon:Keyboard},
  {id:"diagnostics",label:"About & Diagnostics",hint:"Version, logs and support",Icon:Info}
];
type Props={preferences:AppPreferences;onChange:(p:AppPreferences)=>void;
 buildInfo:BuildInfo|null;vaultUnlocked:boolean;onLock:()=>void;onExport:()=>void;onRestore:()=>void};
export default function SettingsWorkspace({preferences,onChange,buildInfo,vaultUnlocked,onLock,onExport,onRestore}:Props){
  const [section,setSection]=useState<Section>("general");
  const [importError,setImportError]=useState("");
  const [notice,setNotice]=useState("");
  const fileInput=useRef<HTMLInputElement>(null);
  const exportSettings=()=>{
    const blob=new Blob([JSON.stringify({format:"passh7-preferences",version:1,preferences},null,2)],{type:"application/json"});
    const url=URL.createObjectURL(blob);const link=document.createElement("a");
    link.href=url;link.download="passh7-preferences.json";link.click();
    window.setTimeout(()=>URL.revokeObjectURL(url),1000);
    setNotice("Non-secret UI settings exported. Vault credentials were not included.");
  };
  const importSettings=async(file:File|undefined)=>{
    if(!file)return;
    if(file.size>16*1024){setImportError("Settings file exceeds 16 KiB.");return}
    try{
      const parsed=JSON.parse(await file.text()) as unknown;
      if(!parsed||typeof parsed!=="object"||Array.isArray(parsed)||
        (parsed as Record<string,unknown>).format!=="passh7-preferences"||
        (parsed as Record<string,unknown>).version!==1)throw Error("Not a supported PaSSH7 settings export.");
      const imported=validatePreferences((parsed as Record<string,unknown>).preferences);
      if(window.confirm("Replace local non-secret UI settings? SSH keys, passwords and host profiles remain untouched.")){
        onChange(imported);setImportError("");setNotice("Interface preferences imported.");
      }
    }catch(error){setImportError("Cannot import preferences: "+String(error))}
    finally{if(fileInput.current)fileInput.current.value=""}
  };
  const update=<K extends keyof AppPreferences>(key:K,value:AppPreferences[K])=>onChange({...preferences,[key]:value});
  const switchRow=(title:string,hint:string,key:keyof AppPreferences)=>(
    <label className="prefRow"><span><strong>{title}</strong><small>{hint}</small></span>
      <input type="checkbox" checked={Boolean(preferences[key])} onChange={e=>update(key,e.target.checked as never)}/></label>
  );
  const infoRow=(title:string,hint:string,value:string)=>(
    <div className="prefRow"><span><strong>{title}</strong><small>{hint}</small></span><span className="prefReadonly">{value}</span></div>
  );
  const sectionCard=(title:string,children:ReactNode)=>(
    <section className="settingsCard"><h3>{title}<ChevronDown size={15}/></h3>{children}</section>
  );
  const resettable=["general","terminal","files","docker","appearance"].includes(section);
  const resetSection=()=>{
    if(!window.confirm("Reset "+sections.find(s=>s.id===section)?.label+" preferences to defaults?"))return;
    switch(section){
      case "general":onChange({...preferences,rememberWorkspace:defaultPreferences.rememberWorkspace});break;
      case "appearance":onChange({...preferences,theme:defaultPreferences.theme,density:defaultPreferences.density,paneSizes:{...defaultPaneSizes}});break;
      case "terminal":onChange({...preferences,terminalFontSize:defaultPreferences.terminalFontSize,terminalScrollback:defaultPreferences.terminalScrollback});break;
      case "files":onChange({...preferences,sftpShowHidden:defaultPreferences.sftpShowHidden,sftpSort:defaultPreferences.sftpSort,confirmTransfer:defaultPreferences.confirmTransfer,paneSizes:{...preferences.paneSizes,filesTree:defaultPaneSizes.filesTree,filesInspector:defaultPaneSizes.filesInspector}});break;
      case "docker":onChange({...preferences,dockerTail:defaultPreferences.dockerTail,dockerAutoRefresh:defaultPreferences.dockerAutoRefresh,dockerFollowLogs:defaultPreferences.dockerFollowLogs,paneSizes:{...preferences.paneSizes,dockerInspector:defaultPaneSizes.dockerInspector,dockerLogs:defaultPaneSizes.dockerLogs}});break;
      default:break;
    }
    setNotice("Section preferences reset.");
  };
  return <div className="widePage settingsPage">
    <div className="widePageTitle"><Settings2 size={34}/><div><h1>Settings</h1><p>Configure your SSH environment, preferences, and application settings.</p></div></div>
    <div className="settingsLayout">
      <nav className="settingsNav" aria-label="Settings categories">{sections.map(({id,label,hint,Icon})=>
        <button type="button" key={id} aria-current={section===id?"page":undefined} className={section===id?"selected":""} onClick={()=>{setSection(id);setNotice("")}}>
          <Icon size={18}/><span><strong>{label}</strong><small>{hint}</small></span></button>)}</nav>
      <div className="settingsContent">
        <div className="settingsHeading"><div><h2>{sections.find(s=>s.id===section)?.label}</h2><p>{sections.find(s=>s.id===section)?.hint}. Changes to available settings are saved automatically.</p></div>
          <button disabled={!resettable} onClick={resetSection}><RefreshCw size={14}/> Reset section</button></div>
        {notice&&<p className="workspaceNotice" role="status">{notice}</p>}
        {section==="general"&&<>
          {sectionCard("Application behavior",<>
            {switchRow("Remember last workspace","Reopen the same workspace after the app window is reloaded.","rememberWorkspace")}
            {infoRow("Saved SSH host profiles","Host records and identities are stored in your encrypted Vault.","Vault only")}
            {infoRow("Start minimized","Not supported yet; this setting is not applied.","Not available")}
          </>)}
          {sectionCard("Startup & reconnection",<>
            {infoRow("Restore active SSH sessions","Sessions are recovered after WebView reload when the native Vault remains unlocked.","WebView reload")}
            {infoRow("Automatic SSH reconnection","Disconnected sessions require an explicit reconnect to avoid unexpected remote access.","Manual")}
            {infoRow("Shell configuration","Shell startup is controlled by the remote SSH account; there is no local override.","Remote account")}
          </>)}
          {sectionCard("Host identity & connection",<>
            {infoRow("Host-key verification","Connections require a stored verified SHA-256 host fingerprint.","Always enforced")}
            {infoRow("SSH gateway","Select a saved host, then set Direct or Via gateway in Terminal.","Per host")}
          </>)}
        </>}
        {section==="ssh"&&<>
          {sectionCard("Authentication & trust",<>
            {infoRow("Host-key policy","A missing or changed fingerprint prevents SSH authentication.","Pinned SHA-256")}
            {infoRow("Authentication","Password-only, key-only, and supported multi-factor flows are configured per host.","Per host")}
            {infoRow("Jump host","Configure a one-hop pinned gateway in the selected host's Terminal view.","Per host")}
          </>)}
          {sectionCard("Connection recovery",<>
            {infoRow("Reconnect","Closed SSH tabs never silently reconnect; use the session's Reconnect action.","Manual")}
            {infoRow("Network diagnostics","Use Test SSH port and the connection diagnostics shown in Terminal.","Available per host")}
          </>)}
        </>}
        {section==="security"&&<>
          {sectionCard("Encrypted Vault",<>
            <p className="prefInfo">Credentials, SSH private keys and trusted host pins stay inside the native encrypted Vault, never in browser preferences.</p>
            <div className="settingsActions"><button disabled={!vaultUnlocked} onClick={onExport}><Download size={14}/> Export encrypted backup</button>
              <button disabled={!vaultUnlocked} onClick={onRestore}><Upload size={14}/> Review or restore backup</button>
              <button disabled={!vaultUnlocked} className="settingsDanger" onClick={onLock}><LockKeyhole size={14}/> Lock Vault now</button></div>
            {infoRow("Automatic locking","Available only after native Vault lock policy is integrated into this build.","See release build")}
          </>)}
        </>}
        {section==="terminal"&&<>
          {sectionCard("Terminal rendering",<>
            <label className="prefRow"><span><strong>Font size</strong><small>Applied immediately to all mounted xterm terminal instances.</small></span><input type="number" min={10} max={22} value={preferences.terminalFontSize} onChange={e=>update("terminalFontSize",Math.max(10,Math.min(22,Number(e.target.value)||13)))}/></label>
            <label className="prefRow"><span><strong>Scrollback</strong><small>Maximum lines kept per interactive SSH terminal.</small></span><select value={preferences.terminalScrollback} onChange={e=>update("terminalScrollback",Number(e.target.value))}>{[1000,5000,10000,20000].map(n=><option key={n} value={n}>{n.toLocaleString()} lines</option>)}</select></label>
            {infoRow("Terminal engine","Native SSH PTY with xterm.js, ANSI output and keyboard input.","xterm.js")}
          </>)}
        </>}
        {section==="files"&&<>
          {sectionCard("Remote file explorer",<>
            {switchRow("Show hidden files","Include dotfiles in the remote directory listing.","sftpShowHidden")}
            <label className="prefRow"><span><strong>Default sorting</strong><small>Order of files and folders in Remote Files.</small></span><select value={preferences.sftpSort} onChange={e=>update("sftpSort",e.target.value as AppPreferences["sftpSort"])}><option value="folders">Folders first</option><option value="name">Name</option><option value="size">Largest first</option><option value="modified">Newest first</option></select></label>
          </>)}
          {sectionCard("File transfers",<>
            {switchRow("Confirm transfers","Confirm before starting an upload or download.","confirmTransfer")}
            {infoRow("Transfer safety","Native transfers have explicit cancellation and no silent overwrite.","64 MiB file limit")}
          </>)}
        </>}
        {section==="docker"&&<>
          {sectionCard("Containers and resource browser",<>
            {switchRow("Auto-refresh container inventory","Reload while Docker is open, every 15 seconds.","dockerAutoRefresh")}
            {infoRow("Remote Docker privileges","Actions execute with the authenticated SSH user's permissions.","SSH account")}
          </>)}
          {sectionCard("Container logs",<>
            <label className="prefRow"><span><strong>Default log tail</strong><small>Maximum number of recent log lines requested on load.</small></span><select value={preferences.dockerTail} onChange={e=>update("dockerTail",Number(e.target.value))}>{[50,100,200,500,1000].map(n=><option value={n} key={n}>{n} lines</option>)}</select></label>
            {switchRow("Follow logs by default","Use a dedicated streaming SSH channel, cancelled on navigation.","dockerFollowLogs")}
          </>)}
        </>}
        {section==="ports"&&<>
          {sectionCard("SSH forwarding",<>
            {infoRow("Listener safety","Port forwards bind to local loopback on your PC.","127.0.0.1")}
            {infoRow("Remote destinations","Configure a host, destination and port on the Port Forwarding page.","Per SSH session")}
            {infoRow("Forward lifetime","Native listeners close when their SSH session or Vault closes.","Session-bound")}
          </>)}
        </>}
        {section==="agents"&&<>
          {sectionCard("Remote coding assistants",<>
            {infoRow("Supported launchers","Codex, Claude Code and OpenCode can run in an existing SSH PTY.","Remote CLIs")}
            {infoRow("Availability detection","Checks installed tools on the remote host; an unrecognized interactive PATH can cause a false negative.","Manual check")}
            {infoRow("Permission model","Agents run with the remote SSH user's full privileges; no scoped MCP broker yet.","SSH account")}
          </>)}
        </>}
        {section==="notifications"&&<>
          {sectionCard("Connection diagnostics",<>
            {infoRow("Connection failures","Displayed alongside the active host with error details and retry guidance.","In-app")}
            {infoRow("Background notifications","Operating-system notifications are not currently integrated.","Not available")}
          </>)}
        </>}
        {section==="appearance"&&<>
          {sectionCard("Theme and layout",<>
            <label className="prefRow"><span><strong>Theme</strong><small>Switch between deep navy and light workspace themes.</small></span><select value={preferences.theme} onChange={e=>update("theme",e.target.value as AppPreferences["theme"])}><option value="dark">Dark navy</option><option value="light">Light</option></select></label>
            <label className="prefRow"><span><strong>Display density</strong><small>Control the spacing of tables and interactive controls.</small></span><select value={preferences.density} onChange={e=>update("density",e.target.value as AppPreferences["density"])}><option value="comfortable">Comfortable</option><option value="compact">Compact</option></select></label>
          </>)}
          {sectionCard("Resizable workspace panels",<>
            <p className="prefInfo">Drag the dividers in Files or Docker to resize panels. Use arrow keys while a divider is focused; double-click to restore its default. Sizes are kept only in local UI preferences, not in your encrypted Vault.</p>
            {infoRow("Files tree / inspector", "Saved widths in pixels.",preferences.paneSizes.filesTree+" px / "+preferences.paneSizes.filesInspector+" px")}
            {infoRow("Docker inspector / logs","Saved inspector width and log viewer height.",preferences.paneSizes.dockerInspector+" px / "+preferences.paneSizes.dockerLogs+" px")}
            <div className="settingsActions"><button type="button" onClick={()=>{onChange({...preferences,paneSizes:{...defaultPaneSizes}});setNotice("Panel sizes restored to defaults.");}}><RefreshCw size={14}/> Reset all panel sizes</button></div>
          </>)}
        </>}
        {section==="shortcuts"&&<>
          {sectionCard("Available keyboard shortcuts",<>
            {infoRow("Command palette","Search and switch between saved hosts.","Ctrl / Cmd + K")}
            {infoRow("Close quick switch","Dismiss the command palette or modal overlay.","Escape")}
            {infoRow("Terminal shortcuts","Other bindings belong to your selected remote CLI or terminal app.","Remote-dependent")}
            <p className="prefInfo">Editable keybindings are not implemented yet. Shortcuts shown here reflect current behavior, not planned functionality.</p>
          </>)}
        </>}
        {section==="diagnostics"&&<>
          {sectionCard("Build details",<>
            <dl className="diagnosticList"><dt>Version</dt><dd>{buildInfo?.version||"Unknown"}</dd><dt>Publisher</dt><dd>{buildInfo?.publisher||"PAS7 Studio"}</dd><dt>Target</dt><dd>{buildInfo?.target||"Unknown"}</dd><dt>Built at</dt><dd>{buildInfo?.builtAt||"Unknown"}</dd><dt>Commit</dt><dd>{buildInfo?.commit?.slice(0,16)||"Unknown"}</dd><dt>Build</dt><dd>{buildInfo?.runNumber||"Unknown"}</dd></dl>
            <button onClick={()=>void navigator.clipboard.writeText(JSON.stringify({build:buildInfo,preferences},null,2)).then(()=>setNotice("Non-secret diagnostics copied.")).catch(error=>setNotice(String(error)))}><Clipboard size={15}/> Copy diagnostics</button>
          </>)}
        </>}
      </div>
      <aside className="settingsHelp">
        <section className="settingsCard"><h3><Info size={18}/> About PaSSH7</h3>
          <dl className="diagnosticList"><dt>Version</dt><dd>{buildInfo?.version||"Unknown"}</dd><dt>Build</dt><dd>{buildInfo?.runNumber||"Local"}</dd><dt>Target</dt><dd>{buildInfo?.target||"Unknown"}</dd></dl>
          <p className="prefInfo">Experimental desktop application. This release is not independently security-audited.</p>
          <button onClick={()=>setSection("diagnostics")}>View diagnostics</button></section>
        <section className="settingsCard"><h3><FolderClosed size={18}/> Configuration</h3>
          <p className="prefInfo">Export, import or reset local UI preferences. Encrypted host credentials and Vault backups are separate.</p>
          <div className="settingsActions vertical"><button onClick={exportSettings}><Download size={14}/> Export UI preferences</button>
            <button onClick={()=>fileInput.current?.click()}><Upload size={14}/> Import UI preferences</button>
            <button className="settingsDanger" onClick={()=>{if(window.confirm("Reset all local UI preferences? Your encrypted Vault and remote backups are not affected.")){onChange({...defaultPreferences});setNotice("Preferences reset.");}}}><RefreshCw size={14}/> Reset all UI settings</button></div>
          <input hidden ref={fileInput} type="file" accept=".json,application/json" aria-label="Import UI preferences" onChange={e=>void importSettings(e.target.files?.[0])}/>
          {importError&&<p role="alert" className="workspaceError">{importError}</p>}</section>
        <section className="settingsCard"><h3><LockKeyhole size={18}/> Vault status</h3>
          <div className="prefRow"><span><strong>Status</strong></span><span className={vaultUnlocked?"textGood":"prefReadonly"}>{vaultUnlocked?"● Unlocked":"○ Locked"}</span></div>
          <button onClick={onLock} disabled={!vaultUnlocked}><LockKeyhole size={14}/> Lock Vault now</button>
          <button onClick={()=>setSection("security")}><ShieldCheck size={14}/> Vault settings</button></section>
        <section className="settingsCard"><h3><Info size={18}/> Tips</h3><p className="prefInfo">You can back up interface preferences here, but encrypted Vault copies must be created or restored separately. Never share Vault backups or master passwords in chat.</p></section>
      </aside>
    </div>
  </div>;
}
