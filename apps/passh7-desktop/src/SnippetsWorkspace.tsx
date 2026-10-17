import {useState} from "react";
import {Activity,Clipboard,Code2,Play,Search,ShieldAlert,TerminalSquare} from "lucide-react";

const snippets=[
 {title:"Working directory",category:"Shell",command:"pwd",description:"Print the working directory in the active SSH shell."},
 {title:"Current user",category:"Shell",command:"whoami",description:"Show the account executing commands on the remote host."},
 {title:"Host information",category:"System",command:"uname -a",description:"Display the remote Linux kernel and architecture."},
 {title:"Disk space",category:"System",command:"df -h",description:"Summarize mounted filesystem capacity."},
 {title:"System uptime",category:"System",command:"uptime",description:"Show system uptime and load averages."},
 {title:"Docker containers",category:"Docker",command:"docker ps -a",description:"List containers visible to the connected SSH account."}
] as const;
type Props={host:string;connected:boolean;onTerminal:()=>void;onExecute:(command:string)=>void};
export default function SnippetsWorkspace(p:Props){
  const [query,setQuery]=useState("");
  const [command,setCommand]=useState("");
  const [selected,setSelected]=useState<string>("pwd");
  const visible=snippets.filter(s=>(s.title+" "+s.description+" "+s.category+" "+s.command).toLowerCase().includes(query.toLowerCase()));
  const execute=(raw:string)=>{
    if(!p.connected||!raw.trim()||raw.length>512||/[\r\n]/.test(raw))return;
    p.onExecute(raw.trim());
  };
  return <div className="widePage snippetsPage">
    <div className="widePageTitle"><Code2 size={32}/><div><h1>Snippets</h1><p>Run frequently used commands in your existing authenticated SSH terminal.</p></div>
      <span className={p.connected?"workspaceConnected":"workspaceOffline"}>{p.connected?"● "+p.host:"○ No SSH connection"}</span></div>
    <div className="snippetsBody">
      <section className="snippetsCatalog">
        <div className="snippetsToolbar"><label className="filesSearch"><Search size={15}/><input aria-label="Find snippets" placeholder="Find a command…" value={query} onChange={e=>setQuery(e.target.value)}/></label><span>POSIX / Linux built-ins</span></div>
        <div className="snippetsGrid">{visible.map(snippet=><button type="button" key={snippet.command} className={"snippetCard "+(selected===snippet.command?"selected":"")} onClick={()=>{setSelected(snippet.command);setCommand(snippet.command)}}>
          <span>{snippet.category}</span><strong>{snippet.title}</strong><code>{snippet.command}</code><small>{snippet.description}</small></button>)}</div>
        {visible.length===0&&<div className="workspaceEmpty">No matching snippets.</div>}
      </section>
      <aside className="snippetsRunner">
        <h2><TerminalSquare size={17}/> Run command</h2><p>Commands are written into the current SSH PTY, exactly like typing in Terminal. They execute with your remote account privileges.</p>
        <label>Shell command<textarea aria-label="SSH command" value={command} onChange={e=>setCommand(e.target.value)} rows={4} placeholder="Choose a snippet or enter one shell command"/></label>
        {(/[\r\n]/.test(command)||command.length>512)&&<p role="alert" className="workspaceError">Use one command line with at most 512 characters. Multiline scripts must be reviewed and run in Terminal.</p>}
        <button className="workspacePrimary" disabled={!p.connected||!command.trim()||command.length>512||/[\r\n]/.test(command)} onClick={()=>execute(command)}><Play size={15}/> Run in SSH terminal</button>
        <button disabled={!command.trim()} onClick={()=>void navigator.clipboard.writeText(command)}><Clipboard size={14}/> Copy command</button>
        <button onClick={p.onTerminal}><TerminalSquare size={14}/> Open terminal</button>
        <div className="snippetWarning"><ShieldAlert size={17}/><p>Every run requires explicit confirmation. PaSSH7 does not sandbox shell commands or automatically forward secrets.</p></div>
      </aside>
    </div>
  </div>;
}
