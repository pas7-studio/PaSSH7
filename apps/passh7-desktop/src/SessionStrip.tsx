import {useEffect,useRef} from "react";
import {Activity,ArrowRight,Command,LockKeyhole,Plus,TerminalSquare,X} from "lucide-react";

type Session={id:string;alias:string};
type Host={id:string;label:string};
type TransferActivity={active:number;queued:number;failed:number;paused:boolean;progress:number|null};
type Props={
  sessions:Session[];hosts:Host[];closingSessions:string[];
  activeSession:string;selectedHost:string;vaultUnlocked:boolean;
  onSelect:(id:string)=>void;onDisconnect:(id:string)=>void;onConnect:()=>void;
  onUnlock:()=>void;onAddHost:()=>void;onCommandPalette:()=>void;
  transfers:TransferActivity;onTransfers:()=>void;
};
/** Visible across Files, Docker, Ports, Settings and AI Agents.
 * A click only changes the active native PTY; it never creates an SSH session,
 * grants a CLI capability or sends a command to a remote machine. */
export default function SessionStrip(p:Props){
  const itemsRef=useRef<HTMLDivElement>(null);
  // When the active PTY changes through Ctrl+K or another workspace, bring
  // its session chip into view even with dozens of horizontally scrollable tabs.
  useEffect(()=>{
    itemsRef.current?.querySelector<HTMLElement>('.sessionStripItem[aria-pressed="true"]')
      ?.scrollIntoView({inline:"nearest",block:"nearest"});
  },[p.activeSession,p.selectedHost]);
  const selected=p.hosts.find(host=>host.id===p.selectedHost);
  const seen=new Map<string,number>();
  const numbered=p.sessions.map(session=>{
    const number=(seen.get(session.alias)||0)+1;
    seen.set(session.alias,number);
    return {...session,number};
  });
  const transferCount=p.transfers.active+p.transfers.queued+p.transfers.failed;
  const transferButton=transferCount>0?<button type="button" className="sessionStripTransfers"
    title="Open SFTP transfer queue in Remote Files"
    aria-label={"Open SFTP transfer queue: "+p.transfers.active+" active, "+
      p.transfers.queued+" pending, "+p.transfers.failed+" failed"}
    onClick={p.onTransfers}>
    <Activity size={14}/>
    <span>{p.transfers.active?""+p.transfers.active+" transferring":
      p.transfers.queued?""+p.transfers.queued+(p.transfers.paused?" paused":" queued"):
      ""+p.transfers.failed+" failed"}</span>
    {p.transfers.progress!==null&&p.transfers.active>0&&
      <small>{p.transfers.progress}%</small>}
    {p.transfers.failed>0&&<small className="sessionStripTransferErrors">{p.transfers.failed} failed</small>}
  </button>:null;
  if(!p.sessions.length){
    return <div className="sessionStrip sessionStripEmpty" aria-label="SSH session status">
      <div className="sessionStripCaption"><Activity size={15}/>
        <span>No SSH sessions open</span>
        <small>{p.vaultUnlocked?"Connect to a saved host to use its tools":"Vault is locked"}</small>
      </div>
      {p.vaultUnlocked&&selected?
        <button type="button" onClick={p.onConnect}><Plus size={14}/> Connect {selected.label}</button>:
        p.vaultUnlocked?<button type="button" onClick={p.onAddHost}><Plus size={14}/> Add SSH host</button>:
        <button type="button" onClick={p.onUnlock}><LockKeyhole size={14}/> Unlock Vault</button>}
      {transferButton}
      <button type="button" aria-label="Search sessions and commands" onClick={p.onCommandPalette}><Command size={15}/></button>
    </div>;
  }
  return <div className="sessionStrip" aria-label="Live SSH sessions">
    <div className="sessionStripCaption"><Activity size={15}/>
      <span>SSH SESSIONS</span><small>{p.sessions.length} connected</small>
    </div>
    <div ref={itemsRef} className="sessionStripItems" role="group" aria-label="Choose native SSH session">
      {numbered.map(session=>{
        const host=p.hosts.find(item=>item.id===session.alias);
        const number=session.number;
        const active=session.id===p.activeSession&&session.alias===p.selectedHost;
        return <div className={active?"sessionStripGroup active":"sessionStripGroup"} key={session.id}>
          <button type="button" aria-pressed={active} className={active?"sessionStripItem active":"sessionStripItem"}
            title={"Switch to "+(host?.label||session.alias)+" SSH session "+number}
            onClick={()=>p.onSelect(session.id)}>
            <span className="sessionStripDot" aria-hidden="true"/>
            <span>{host?.label||session.alias}</span>
            <small>#{number}</small>
            {active&&<TerminalSquare size={13} aria-hidden="true"/>}
          </button>
          <button type="button" className="sessionStripClose"
            disabled={p.closingSessions.includes(session.id)}
            title={"Disconnect "+(host?.label||session.alias)+" SSH session "+number}
            aria-label={"Disconnect "+(host?.label||session.alias)+" SSH session "+number}
            onClick={()=>p.onDisconnect(session.id)}>{p.closingSessions.includes(session.id)?"…":<X size={13}/>}</button>
        </div>;
      })}
    </div>
    {selected&&!p.sessions.some(session=>session.alias===selected.id)&&p.vaultUnlocked&&
      <button type="button" className="sessionStripConnect" onClick={p.onConnect}>
        <Plus size={14}/> Connect {selected.label}
      </button>}
    {transferButton}
    <button type="button" className="sessionStripSearch" aria-label="Search all SSH sessions"
      title="Find sessions, hosts and commands (Ctrl+Shift+P; Ctrl+K outside terminal)" onClick={p.onCommandPalette}>
      <Command size={15}/><span>Switch</span><ArrowRight size={13}/>
    </button>
  </div>;
}
