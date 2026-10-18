import {Fragment,useEffect,useMemo,useRef,useState} from "react";
import {ArrowRight,Check,FolderClosed,Server,Search,ShieldCheck,TerminalSquare,Container,Network,Code2,Bot,Settings2,Plus,LockKeyhole,CornerDownLeft,PlugZap} from "lucide-react";

export type WorkspaceRoute="connections"|"terminal"|"files"|"docker"|"agent"|"snippets"|"ports"|"settings";
type HostItem={id:string;label:string;address:string;user:string;group:string;fingerprint:boolean};
type SessionItem={id:string;alias:string};
type Props={
  hosts:HostItem[];sessions:SessionItem[];connectedAliases:string[];initialQuery?:string;
  selected:string;selectedSession:string;vaultUnlocked:boolean;
  onChooseHost:(id:string)=>void;onChooseSession:(id:string)=>void;
  onConnectHost:(id:string)=>void;onAddHost:()=>void;onUnlockVault:()=>void;
  onWorkspace:(route:WorkspaceRoute)=>void;onClose:()=>void;
};
const destinations=[
  {id:"connections",title:"Connections",description:"Saved hosts and SSH identities",icon:Server},
  {id:"terminal",title:"Terminal",description:"Interactive SSH sessions",icon:TerminalSquare},
  {id:"files",title:"Remote Files",description:"SFTP, downloads and uploads",icon:FolderClosed},
  {id:"docker",title:"Docker",description:"Containers, Compose and live logs",icon:Container},
  {id:"ports",title:"Port Forwarding",description:"Local tunnels, PostgreSQL, Redis and RDP",icon:Network},
  {id:"snippets",title:"Snippets",description:"Reviewed remote commands",icon:Code2},
  {id:"agent",title:"AI Agents",description:"Codex, Claude Code and OpenCode",icon:Bot},
  {id:"settings",title:"Settings",description:"App settings and diagnostics",icon:Settings2}
] as const;
type Category="sessions"|"hosts"|"workspaces"|"actions";
type Hit={key:string;label:string;hint:string;category:Category;
  keywords:string;icon:typeof Server;connected?:boolean;trusted?:boolean;
  selected?:boolean;route?:WorkspaceRoute;hostId?:string;sessionId?:string;
  action?:"add-host"|"unlock-vault"|"connect-selected"};
const categoryLabels:Record<Category,string>={
  sessions:"OPEN SSH SESSIONS",hosts:"SAVED HOSTS",workspaces:"WORKSPACES",actions:"QUICK ACTIONS"
};
function matchScore(hit:Hit,terms:string[]):number{
  const name=hit.label.toLocaleLowerCase();
  const haystack=(hit.label+" "+hit.hint+" "+hit.keywords).toLocaleLowerCase();
  if(!terms.every(term=>haystack.includes(term)))return -1;
  let score=0;
  for(const term of terms){
    if(name===term)score+=120;
    else if(name.startsWith(term))score+=65;
    else if(name.split(/\s+/).some(word=>word.startsWith(term)))score+=35;
    else score+=10;
  }
  return score+(hit.selected?18:0)+(hit.connected?12:0);
}
export default function QuickSwitch(p:Props){
  const [query,setQuery]=useState(p.initialQuery||"");
  const [index,setIndex]=useState(0);
  const listRef=useRef<HTMLDivElement>(null);
  const searchRef=useRef<HTMLInputElement>(null);
  const normalized=query.trim().toLocaleLowerCase();
  const commandOnly=normalized.startsWith(">");
  const targetOnly=normalized.startsWith("@");
  const terms=(commandOnly||targetOnly?normalized.slice(1):normalized).trim().split(/\s+/).filter(Boolean);
  const results=useMemo(()=>{
    const candidates:Hit[]=[];
    for(const [i,session] of p.sessions.entries()){
      const host=p.hosts.find(item=>item.id===session.alias);
      const hostSessions=p.sessions.filter(item=>item.alias===session.alias);
      const number=hostSessions.findIndex(item=>item.id===session.id)+1;
      candidates.push({
        key:"session:"+session.id,label:(host?.label||session.alias)+" · Terminal "+number,
        hint:"Connected SSH session"+(session.id===p.selectedSession?" · current terminal":""),
        keywords:"ssh shell console active terminal "+(host?.user||"")+" "+(host?.address||""),
        category:"sessions",icon:TerminalSquare,connected:true,
        selected:session.id===p.selectedSession,sessionId:session.id
      });
    }
    for(const host of p.hosts){
      const count=p.sessions.filter(session=>session.alias===host.id).length;
      candidates.push({
        key:"host:"+host.id,label:host.label,
        hint:host.user+"@"+host.address+" · "+(count?count+" open SSH session"+(count===1?"":"s"):"No active SSH session"),
        keywords:host.group+" "+host.id+" server connect login ssh",
        category:"hosts",icon:Server,hostId:host.id,
        trusted:host.fingerprint,connected:count>0,selected:host.id===p.selected
      });
    }
    for(const page of destinations)candidates.push({
      key:"page:"+page.id,label:page.title,hint:page.description,
      keywords:page.id+" workspace page open navigate",
      category:"workspaces",icon:page.icon,route:page.id
    });
    if(p.vaultUnlocked){
      candidates.push({key:"action:add-host",label:"Add SSH host",
        hint:"Save a connection profile in encrypted Vault",
        keywords:"new create server machine connection",category:"actions",icon:Plus,action:"add-host"});
      if(p.selected&&p.hosts.some(h=>h.id===p.selected)){
        const host=p.hosts.find(h=>h.id===p.selected)!;
        candidates.push({key:"action:connect-selected",label:"Connect to "+host.label,
          hint:"Open a new SSH session · follows regular host-key and login checks",
          keywords:"ssh connect new session quick login selected host",
          category:"actions",icon:PlugZap,action:"connect-selected"});
      }
    }else candidates.push({key:"action:unlock-vault",label:"Unlock Vault",
      hint:"Access your saved SSH connections and credentials",
      keywords:"password vault security locked login",category:"actions",icon:LockKeyhole,action:"unlock-vault"});

    const allowed=candidates.filter(hit=>targetOnly?(
        hit.category==="hosts"||hit.category==="sessions"||
        hit.action==="unlock-vault"||
        (hit.action==="add-host"&&p.hosts.length===0)
      ):commandOnly?hit.category==="actions"||hit.category==="workspaces":true);
    const ranked=allowed.map(hit=>({hit,score:matchScore(hit,terms)}))
      .filter(row=>row.score>=0);
    const sections:Category[]=commandOnly?["actions","workspaces"]:targetOnly?["sessions","hosts","actions"]:
      ["sessions","hosts","workspaces","actions"];
    const hits:Hit[]=[];
    for(const section of sections){
      const within=ranked.filter(row=>row.hit.category===section)
        .sort((a,b)=>b.score-a.score||a.hit.label.localeCompare(b.hit.label))
        .slice(0,section==="hosts"?20:section==="sessions"?20:12);
      hits.push(...within.map(row=>row.hit));
    }
    return hits.slice(0,60);
  },[p.hosts,p.sessions,p.selected,p.selectedSession,p.vaultUnlocked,normalized,commandOnly,targetOnly,terms.join(" ")]);
  useEffect(()=>{setIndex(0)},[query]);
  useEffect(()=>{setIndex(i=>Math.max(0,Math.min(i,results.length-1)))},[results.length]);
  useEffect(()=>{
    listRef.current?.querySelector<HTMLElement>('[data-current="true"]')
      ?.scrollIntoView({block:"nearest"});
  },[index,results.length]);
  const activate=(hit:Hit,connect=false)=>{
    if(hit.sessionId)p.onChooseSession(hit.sessionId);
    else if(hit.hostId){
      if(connect)p.onConnectHost(hit.hostId);
      else p.onChooseHost(hit.hostId);
    }else if(hit.route)p.onWorkspace(hit.route);
    else if(hit.action==="add-host")p.onAddHost();
    else if(hit.action==="unlock-vault")p.onUnlockVault();
    else if(hit.action==="connect-selected")p.onConnectHost(p.selected);
    p.onClose();
  };
  return <div className="quickSwitchPanel quickCommandPalette">
    <label className="quickSwitchSearch"><Search size={18}/>
      <input ref={searchRef} autoFocus aria-label="Search SSH sessions, hosts, workspaces and commands"
        role="combobox" aria-expanded="true" aria-autocomplete="list"
        aria-controls="passh7-command-results"
        aria-activedescendant={results[index]?"passh7-command-option-"+index:undefined}
        value={query} onChange={e=>setQuery(e.target.value)}
        onKeyDown={e=>{
          if(e.key==="ArrowDown"){e.preventDefault();setIndex(i=>Math.min(Math.max(0,results.length-1),i+1))}
          else if(e.key==="ArrowUp"){e.preventDefault();setIndex(i=>Math.max(0,i-1))}
          else if(e.key==="Enter"&&results[index]){
            e.preventDefault();activate(results[index],e.ctrlKey||e.metaKey)
          }
        }}
        placeholder="Search servers, sessions, pages or actions…"/>
      {query?<button type="button" className="quickClearQuery" title="Clear search" onClick={()=>{setQuery("");searchRef.current?.focus()}}>Clear</button>:
        <kbd>Ctrl K</kbd>}
    </label>
    <div className="quickPaletteHelp"><span>Use <kbd>@</kbd> for SSH targets</span><span><kbd>&gt;</kbd> for commands</span><span>{p.sessions.length} live terminal{p.sessions.length===1?"":"s"}</span></div>
    <div className="quickSwitchResults" id="passh7-command-results" ref={listRef} role="listbox" aria-label="Command palette results">
      {results.map((hit,i)=>{
        const Icon=hit.icon;
        const first=i===0||results[i-1].category!==hit.category;
        return <Fragment key={hit.key}>
          {first&&<div className="quickPaletteSection" role="presentation">{categoryLabels[hit.category]}</div>}
          <button type="button" id={"passh7-command-option-"+i} role="option"
            aria-selected={i===index} data-current={i===index}
            className={"quickSwitchOption "+(i===index?"selected":"")}
            onMouseEnter={()=>setIndex(i)} onClick={()=>activate(hit)}>
            <span className="quickSwitchOptionIcon"><Icon size={16}/></span>
            <span className="quickSwitchOptionText"><strong>{hit.label}</strong><small>{hit.hint}</small></span>
            {hit.category==="sessions"&&<span className="quickSwitchHostState online"><Check size={13}/> SSH</span>}
            {hit.category==="hosts"&&<span className={"quickSwitchHostState "+(hit.connected?"online":"")}>
              {hit.connected?<Check size={14}/>:hit.trusted?<ShieldCheck size={14}/>:null}
              {hit.connected?"Connected":hit.trusted?"Key pinned":"Verify key"}</span>}
            {i===index&&<ArrowRight size={14} className="quickSwitchGo" aria-hidden="true"/>}
          </button>
        </Fragment>;
      })}
      {!results.length&&<div className="quickSwitchNoResults"><Search size={23}/>
        <strong>No matching commands</strong><span>Try a host name, Docker, Files or &gt; for app commands.</span>
        <button type="button" onClick={()=>{setQuery("");searchRef.current?.focus()}}>Show all</button>
      </div>}
    </div>
    <footer className="quickSwitchFooter">
      <span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span>
      <span><CornerDownLeft size={13}/> Select</span>
      <span><kbd>Ctrl ↵</kbd> Connect host</span>
      <span><kbd>Esc</kbd> Close</span>
    </footer>
  </div>;
}
