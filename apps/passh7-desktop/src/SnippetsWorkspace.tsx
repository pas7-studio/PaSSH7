import {useMemo,useState} from "react";
import {Clipboard,Code2,Play,Search,ShieldAlert,TerminalSquare} from "lucide-react";
import {WorkspaceEmpty,WorkspaceHeader} from "./WorkspaceChrome";

const snippets=[
  {title:"Working directory",category:"Shell",command:"pwd",description:"Print the current remote directory."},
  {title:"Current user",category:"Shell",command:"whoami",description:"Identify the account in the SSH shell."},
  {title:"Host information",category:"System",command:"uname -a",description:"Kernel, architecture and host information."},
  {title:"Disk space",category:"System",command:"df -h",description:"Mounted filesystem capacity."},
  {title:"System uptime",category:"System",command:"uptime",description:"Uptime and load averages."},
  {title:"Recent processes",category:"System",command:"ps aux",description:"List visible Linux processes."},
  {title:"Docker containers",category:"Docker",command:"docker ps -a",description:"List containers available to your SSH account."},
  {title:"Docker images",category:"Docker",command:"docker image ls",description:"List image names, tags and sizes."},
  {title:"Docker networks",category:"Docker",command:"docker network ls",description:"List networks without mutating them."}
] as const;
type Category="All"|"Shell"|"System"|"Docker";
type Props={host:string;connected:boolean;onTerminal:()=>void;onExecute:(command:string)=>void};

export default function SnippetsWorkspace(p:Props){
  const [query,setQuery]=useState("");
  const [category,setCategory]=useState<Category>("All");
  const [command,setCommand]=useState("pwd");
  const [selected,setSelected]=useState("pwd");
  const [notice,setNotice]=useState("");
  const visible=useMemo(()=>snippets.filter(item=>
    (category==="All"||item.category===category)&&
    (item.title+" "+item.description+" "+item.category+" "+item.command).toLowerCase()
      .includes(query.trim().toLowerCase())
  ),[category,query]);
  const invalid=command.trim().length===0||command.length>512||/[\r\n]/.test(command);
  const execute=()=>{
    if(!p.connected||invalid)return;
    // App owns the explicit confirmation and the selected authenticated PTY.
    p.onExecute(command.trim());
  };
  const copy=async()=>{
    try{await navigator.clipboard.writeText(command);setNotice("Command copied.")}
    catch{setNotice("Clipboard unavailable. Select the command and copy manually.")}
  };
  return <div className="widePage snippetsPage">
    <WorkspaceHeader icon={Code2} title="Snippets" description="Select a safe command template, review it, and run it in your SSH terminal."
      status={p.connected?"connected":"offline"} statusText={p.connected?p.host+" connected":"No SSH connection"}/>
    <div className="snippetsBody">
      <section className="snippetsCatalog">
        <div className="snippetsToolbar">
          <label className="filesSearch"><Search size={15}/><input aria-label="Find snippets"
            placeholder="Find a command…" value={query} onChange={e=>setQuery(e.target.value)}/></label>
          <span>{visible.length} templates</span>
        </div>
        <div className="workspaceFilterBar" role="group" aria-label="Snippet category">
          {(["All","Shell","System","Docker"] as const).map(item=>
            <button type="button" key={item} aria-pressed={category===item} className={category===item?"active":""}
              onClick={()=>setCategory(item)}>{item} <span>{item==="All"?snippets.length:snippets.filter(s=>s.category===item).length}</span></button>)}
        </div>
        <div className="snippetsGrid">
          {visible.map(item=><button type="button" key={item.command}
            className={"snippetCard "+(selected===item.command?"selected":"")}
            aria-pressed={selected===item.command} onClick={()=>{setSelected(item.command);setCommand(item.command);setNotice("")}}>
            <span>{item.category}</span><strong>{item.title}</strong><code>{item.command}</code><small>{item.description}</small>
          </button>)}
        </div>
        {visible.length===0&&<WorkspaceEmpty icon={Search} title="No matching snippets"
          description="Try another keyword or command category."
          action={<button onClick={()=>{setQuery("");setCategory("All")}}>Reset filters</button>}/>}
      </section>
      <aside className="snippetsRunner">
        <h2><TerminalSquare size={17}/> Command preview</h2>
        <p>The command runs with the full privileges of your remote SSH account. Confirm your terminal is at a shell prompt.</p>
        <label>Shell command
          <textarea aria-label="SSH command" value={command} onChange={e=>{setCommand(e.target.value);setSelected("");setNotice("")}}
            rows={4} spellCheck={false} placeholder="Select a template or enter one shell command"
            onKeyDown={e=>{if((e.ctrlKey||e.metaKey)&&e.key==="Enter"){e.preventDefault();execute()}}}/>
        </label>
        <small className="snippetCounter">{command.length}/512 characters · Ctrl+Enter to review & run</small>
        {(/[\r\n]/.test(command)||command.length>512)&&<p role="alert" className="workspaceError">
          Use one command line with at most 512 characters. Multiline scripts must be reviewed and run in Terminal.
        </p>}
        <button className="workspacePrimary" disabled={!p.connected||invalid} onClick={execute}>
          <Play size={15}/> Review and run in SSH
        </button>
        <div className="workspaceInlineActions">
          <button disabled={!command.trim()} onClick={()=>void copy()}><Clipboard size={14}/> Copy command</button>
          <button onClick={p.onTerminal}><TerminalSquare size={14}/> Open terminal</button>
        </div>
        {notice&&<p className="workspaceNotice" role="status">{notice}</p>}
        {!p.connected&&<p className="workspaceOfflineHint" role="status">
          An authenticated SSH session is required before a command can run.
        </p>}
        <div className="snippetWarning"><ShieldAlert size={17}/><p>
          PaSSH7 does not sandbox or automatically approve shell commands. Every run is confirmed before writing to the current PTY.
        </p></div>
      </aside>
    </div>
  </div>;
}
