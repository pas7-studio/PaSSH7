import {useMemo,useState} from "react";
import {Activity, Bot, ChevronDown, CircleHelp, Command, Container, FileText, FolderClosed, KeyRound, LockKeyhole, Monitor, Plus, Search, Server, Settings2, ShieldCheck, TerminalSquare, X} from "lucide-react";

type Panel = "files" | "docker" | "agent" | "ports";
type Host = {id:string; label:string; address:string; user:string; group:string; fingerprint:boolean};
const DEMO_HOSTS:Host[] = [
  {id:"dev",label:"Development",address:"dev.example.invalid",user:"ubuntu",group:"Development",fingerprint:true},
  {id:"staging",label:"Staging",address:"staging.example.invalid",user:"deploy",group:"Development",fingerprint:false},
  {id:"prod",label:"Production",address:"prod.example.invalid",user:"ops",group:"Production",fingerprint:true}
];
const tabs: {id:Panel;label:string; Icon:typeof Bot}[]=[
  {id:"files",label:"Files",Icon:FolderClosed},{id:"docker",label:"Docker",Icon:Container},
  {id:"ports",label:"Ports",Icon:Activity},{id:"agent",label:"AI Agent",Icon:Bot}
];
export default function App(){
  const [selected,setSelected]=useState("dev");
  const [query,setQuery]=useState("");
  const [panel,setPanel]=useState<Panel>("agent");
  const [sidebar,setSidebar]=useState(true);
  const [commandOpen,setCommandOpen]=useState(false);
  const [showSettings,setShowSettings]=useState(false);
  const [theme,setTheme]=useState<"dark"|"light">("dark");
  const active=DEMO_HOSTS.find(h=>h.id===selected)!;
  const filtered=useMemo(()=>DEMO_HOSTS.filter(h=>(h.label+" "+h.address+" "+h.group).toLowerCase().includes(query.toLowerCase())),[query]);
  const context="Host: "+active.label+"\nTarget: "+active.user+"@"+active.address+"\nConnection: disconnected\nVault: locked\nPermissions: none\nSelected resources: none";
  return <div className={"shell "+theme} onKeyDown={e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="k"){e.preventDefault();setCommandOpen(v=>!v)}if(e.key==="Escape"){setCommandOpen(false);setShowSettings(false)}}}>
    <header className="topbar"><div className="brand"><div className="brandicon"><TerminalSquare size={19}/></div><strong>PaSSH7</strong><span className="alpha">PREVIEW</span></div><div className="topactions"><span className="lock"><LockKeyhole size={14}/> Vault locked</span><button className="iconbtn" title="Command palette (Ctrl+K)" aria-label="Command palette" onClick={()=>setCommandOpen(true)}><Command size={17}/></button><button className="iconbtn" title="Settings" aria-label="Settings" onClick={()=>setShowSettings(true)}><Settings2 size={17}/></button></div></header>
    <div className="workspace">
      {sidebar&&<aside className="sidebar"><div className="sectionHeading"><span>YOUR HOSTS</span><button className="iconbtn" title="Add host (not available)" disabled><Plus size={16}/></button></div><label className="search"><Search size={15}/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search hosts" aria-label="Search hosts"/><span>⌘ K</span></label>
        {["Development","Production"].map(group=><section key={group}><div className="groupLabel"><ChevronDown size={13}/>{group}</div>{filtered.filter(h=>h.group===group).map(h=><button key={h.id} className={"host "+(selected===h.id?"selected":"")} onClick={()=>setSelected(h.id)}><Server size={16}/><span className="hostText"><strong>{h.label}</strong><small>{h.user}@{h.address}</small></span><span className={"hostDot "+(h.fingerprint?"trusted":"untrusted")} title={h.fingerprint?"Demo pin metadata":"Missing host key pin"}/></button>)}</section>)}
        {!filtered.length&&<p className="emptySearch">No matching hosts</p>}
        <div className="sidebottom"><span><ShieldCheck size={15}/> Local-first workspace</span><small>Example hosts only. No real credentials.</small></div></aside>}
      <main className="main"><div className="sessionTabs"><button className="iconbtn" aria-label={sidebar?"Hide host sidebar":"Show host sidebar"} onClick={()=>setSidebar(x=>!x)}><Monitor size={16}/></button><div className="sessionActive"><TerminalSquare size={15}/>{active.label}<span className="tabdot"/></div><div className="tabSpacer"/><span className="unavailable">Not connected</span></div>
        <div className="identity"><div><div className="eyebrow">WORKSPACE / {active.group.toUpperCase()}</div><h1>{active.label}</h1><div className="identityMeta"><span><Server size={14}/>{active.user}@{active.address}</span><span>Port 22</span><span className={active.fingerprint?"pin ok":"pin warn"}><ShieldCheck size={14}/>{active.fingerprint?"Pin metadata present":"Host key unpinned"}</span></div></div><button className="primary" disabled title="SSH transport is not implemented yet">Connect <span>↗</span></button></div>
        <div className="terminal"><div className="terminalbar"><span><TerminalSquare size={15}/> Terminal</span><small>NO ACTIVE SESSION</small></div><div className="terminalEmpty"><div className="terminalGlyph"><TerminalSquare size={28}/></div><h2>Your terminal starts here</h2><p>Choose a host and unlock your vault to open a secure SSH session. Connection support is still under development.</p><div className="statusline"><LockKeyhole size={14}/> Vault locked <span>·</span> SSH transport unavailable</div></div></div>
        <footer><span className="footerBrand"><span className="statusDot"/> Offline preview</span><span>{active.label} · No session</span><span>Local UI prototype</span></footer>
      </main>
      <aside className="context"><div className="contextHeader"><span>CONTEXT</span><CircleHelp size={16}/></div><div className="contextTabs">{tabs.map(({id,label,Icon})=><button key={id} className={panel===id?"active":""} title={label} aria-label={label} onClick={()=>setPanel(id)}><Icon size={17}/></button>)}</div><div className="contextBody">
        {panel==="agent"?<><div className="contextTitle"><Bot size={18}/><h3>AI Agent</h3></div><p className="muted">Use Codex, Claude Code or OpenCode with scoped access to the active SSH host.</p><label className="fieldLabel">Agent</label><select disabled aria-label="Select AI agent"><option>Choose an agent</option></select><label className="fieldLabel">Permissions</label><div className="permission"><ShieldCheck size={16}/><div><strong>Read-only by default</strong><small>No active grants</small></div></div><label className="fieldLabel">Context preview</label><pre className="preview">{context}</pre><button className="contextAction" disabled>Start agent session</button><p className="note">MCP integration is not installed. No SSH keys or secrets are sent.</p></>:
        panel==="files"?<><div className="contextTitle"><FolderClosed size={18}/><h3>Files</h3></div><p className="muted">Browse or edit remote files after a verified SSH connection.</p><div className="placeholder"><FileText size={23}/> SFTP unavailable</div></>:
        panel==="docker"?<><div className="contextTitle"><Container size={18}/><h3>Docker</h3></div><p className="muted">Docker tools appear only when the remote account has explicit access.</p><div className="placeholder"><Container size={23}/> Capability not detected</div></>:
        <><div className="contextTitle"><Activity size={18}/><h3>Port forwarding</h3></div><p className="muted">Create local, remote or dynamic SSH tunnels when connected.</p><div className="placeholder"><Activity size={23}/> No active tunnels</div></>}
      </div></aside>
    </div>
    {commandOpen&&<div className="overlay" onMouseDown={()=>setCommandOpen(false)}><div className="modal" role="dialog" aria-modal="true" aria-label="Command palette" onMouseDown={e=>e.stopPropagation()}><div className="modalTitle"><Search size={18}/> Quick switch <button onClick={()=>setCommandOpen(false)} aria-label="Close"><X size={17}/></button></div><p>Switch to a host</p>{DEMO_HOSTS.map(h=><button className="paletteHost" key={h.id} onClick={()=>{setSelected(h.id);setCommandOpen(false)}}><Server size={16}/>{h.label}<small>{h.address}</small></button>)}</div></div>}
    {showSettings&&<div className="overlay" onMouseDown={()=>setShowSettings(false)}><div className="modal" role="dialog" aria-modal="true" aria-label="Preferences" onMouseDown={e=>e.stopPropagation()}><div className="modalTitle"><Settings2 size={18}/> Preferences<button onClick={()=>setShowSettings(false)} aria-label="Close"><X size={17}/></button></div><p>Appearance</p><div className="switches"><button onClick={()=>setTheme("dark")} aria-pressed={theme==="dark"}>Dark</button><button onClick={()=>setTheme("light")} aria-pressed={theme==="light"}>Light</button></div><p className="note">Vault, SSH and agent settings will appear when the Rust backend is connected.</p></div></div>}
  </div>;
}
