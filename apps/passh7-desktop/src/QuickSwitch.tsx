import {useEffect,useMemo,useRef,useState} from "react";
import {ArrowRight,Check,Command,FolderClosed,Server,Search,ShieldCheck,TerminalSquare,X,Container,Network,Code2,Bot,Settings2} from "lucide-react";

export type WorkspaceRoute="connections"|"terminal"|"files"|"docker"|"agent"|"snippets"|"ports"|"settings";
type HostItem={id:string;label:string;address:string;user:string;group:string;fingerprint:boolean};
type Props={
  hosts:HostItem[];connectedAliases:string[];selected:string;
  onChooseHost:(id:string)=>void;onWorkspace:(route:WorkspaceRoute)=>void;onClose:()=>void;
};
const destinations=[
  {id:"connections",title:"Connections",description:"Saved hosts and SSH identities",icon:Server},
  {id:"terminal",title:"Terminal",description:"Interactive SSH sessions",icon:TerminalSquare},
  {id:"files",title:"Remote Files",description:"SFTP and transfers",icon:FolderClosed},
  {id:"docker",title:"Docker",description:"Containers, Compose and logs",icon:Container},
  {id:"ports",title:"Port Forwarding",description:"Local TCP tunnels",icon:Network},
  {id:"snippets",title:"Snippets",description:"Reviewed remote commands",icon:Code2},
  {id:"agent",title:"AI Agents",description:"Remote coding CLI tools",icon:Bot},
  {id:"settings",title:"Settings",description:"Application configuration",icon:Settings2}
] as const;
type Hit={key:string;label:string;hint:string;kind:"host"|"workspace";route?:WorkspaceRoute;host?:HostItem;connected?:boolean;icon:typeof Server};
export default function QuickSwitch(p:Props){
  const [query,setQuery]=useState("");
  const [index,setIndex]=useState(0);
  const listRef=useRef<HTMLDivElement>(null);
  const text=query.trim().toLocaleLowerCase();
  const results=useMemo<Hit[]>(()=>{
    const pages:Hit[]=destinations.map(x=>({key:"page:"+x.id,label:x.title,hint:x.description,
      kind:"workspace",route:x.id,icon:x.icon}));
    const hosts:Hit[]=p.hosts.map(x=>({key:"host:"+x.id,label:x.label,
      hint:x.user+"@"+x.address+" · "+x.group,
      kind:"host",host:x,connected:p.connectedAliases.includes(x.id),icon:Server}));
    const match=(v:Hit)=>(v.label+" "+v.hint+" "+(v.route||"")).toLocaleLowerCase().includes(text);
    const all=text?[...pages.filter(match),...hosts.filter(match)]:
      [...pages,...hosts.sort((a,b)=>Number(b.connected)-Number(a.connected))];
    return all.slice(0,100);
  },[p.hosts,p.connectedAliases,text]);
  useEffect(()=>{setIndex(0)},[query]);
  useEffect(()=>{
    const selected=listRef.current?.querySelector<HTMLElement>('[data-current="true"]');
    selected?.scrollIntoView({block:"nearest"});
  },[index,results.length]);
  const activate=(hit:Hit)=>{
    if(hit.kind==="host"&&hit.host){p.onChooseHost(hit.host.id);p.onClose()}
    if(hit.kind==="workspace"&&hit.route){p.onWorkspace(hit.route);p.onClose()}
  };
  return <div className="quickSwitchPanel">
    <label className="quickSwitchSearch"><Search size={18}/>
      <input autoFocus aria-label="Search hosts and workspaces" value={query}
        onChange={e=>setQuery(e.target.value)}
        onKeyDown={e=>{
          if(e.key==="ArrowDown"){e.preventDefault();setIndex(i=>Math.min(results.length-1,i+1))}
          else if(e.key==="ArrowUp"){e.preventDefault();setIndex(i=>Math.max(0,i-1))}
          else if(e.key==="Enter"&&results[index]){e.preventDefault();activate(results[index])}
        }}
        placeholder="Search a host, page or action…"/>
      <kbd>Ctrl K</kbd>
    </label>
    <div className="quickSwitchResults" ref={listRef} role="listbox" aria-label="Quick switch results">
      {results.map((hit,i)=>{
        const Icon=hit.icon;
        return <button type="button" key={hit.key} role="option"
          aria-selected={i===index} data-current={i===index}
          className={"quickSwitchOption "+(i===index?"selected":"")}
          onMouseEnter={()=>setIndex(i)}
          onClick={()=>activate(hit)}>
          <span className="quickSwitchOptionIcon"><Icon size={16}/></span>
          <span className="quickSwitchOptionText"><strong>{hit.label}</strong><small>{hit.hint}</small></span>
          {hit.kind==="host"&&<span className={"quickSwitchHostState "+(hit.connected?"online":"")}>
            {hit.connected?<Check size={14}/>:hit.host?.fingerprint?<ShieldCheck size={14}/>:null}
            {hit.connected?"Connected":hit.host?.fingerprint?"Verified":"Unverified"}</span>}
          {i===index&&<ArrowRight size={14} className="quickSwitchGo" aria-hidden="true"/>}
        </button>
      })}
      {results.length===0&&<div className="quickSwitchNoResults"><Search size={24}/><strong>No matches</strong>
        <span>Search by host alias, address, username or workspace name.</span></div>}
    </div>
    <footer className="quickSwitchFooter"><span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span>
      <span><kbd>↵</kbd> Open</span><span><kbd>Esc</kbd> Close</span></footer>
  </div>;
}
