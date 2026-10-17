import {useState} from "react";
import {Activity,Clipboard,ExternalLink,LockKeyhole,Network,Plus,RefreshCw,ShieldCheck,Square,TerminalSquare,WifiOff} from "lucide-react";
import {WorkspaceEmpty,WorkspaceHeader,WorkspaceMetric} from "./WorkspaceChrome";

export type Forward={session:string;localPort:number;targetHost:string;remotePort:number};
type Props={
  host:string;connected:boolean;session:string;sessions:string[];
  forwards:Forward[];busy:boolean;busySessions:string[];error:string;
  localPort:number;remoteHost:string;remotePort:number;
  onLocalPort:(port:number)=>void;onRemoteHost:(host:string)=>void;onRemotePort:(port:number)=>void;
  onStart:()=>void;onRefresh:()=>void;onStop:(session:string,localPort:number)=>void;onTerminal:()=>void;
};
export default function PortForwardingWorkspace(p:Props){
  const [selected,setSelected]=useState<string|null>(null);
  const [notice,setNotice]=useState("");
  const valid=p.localPort>=1&&p.localPort<=65535&&p.remotePort>=1&&p.remotePort<=65535
    &&p.remoteHost.trim().length>0&&p.remoteHost.length<=253&&!/[\r\n\s"';&|$<>]/.test(p.remoteHost);
  const current=p.forwards.filter(t=>p.sessions.includes(t.session));
  const chosen=current.find(t=>t.session+":"+t.localPort===selected)||current[0];
  const copy=async(text:string)=>{
    try{await navigator.clipboard.writeText(text);setNotice("Local address copied.")}
    catch{setNotice("Clipboard unavailable; select and copy the address manually.")}
  };
  return <div className="widePage forwardingPage">
    <WorkspaceHeader icon={Network} title="Port Forwarding"
      description="Local SSH tunnels for remote TCP services, always bound to loopback."
      status={p.connected?"connected":"offline"} statusText={p.connected?p.host+" connected":"No SSH connection"}/>
    <div className="forwardMetrics workspaceMetrics">
      <WorkspaceMetric icon={Activity} label="Active forwards" value={current.length} detail={"Across "+p.sessions.length+" SSH session(s) of this host"} intent="good"/>
      <WorkspaceMetric icon={ShieldCheck} label="Binding policy" value="127.0.0.1" detail="Accessible only from this computer"/>
    </div>
    <div className="forwardGrid">
      <section className="forwardForm">
        <h2><Plus size={17}/> New local forward</h2>
        <p>PaSSH7 listens on your computer and sends connections through the selected authenticated SSH session.</p>
        <div className="forwardBindAddress"><ShieldCheck size={15}/><span>Local interface</span><strong>127.0.0.1</strong><small>Fixed · loopback only</small></div>
        <label>Local TCP port<input type="number" min={1} max={65535} value={p.localPort} onChange={e=>p.onLocalPort(Number(e.target.value))}/></label>
        <label>Remote destination host<input value={p.remoteHost} maxLength={253} onChange={e=>p.onRemoteHost(e.target.value)}
          placeholder="127.0.0.1" spellCheck={false}/></label>
        <label>Remote destination port<input type="number" min={1} max={65535} value={p.remotePort} onChange={e=>p.onRemotePort(Number(e.target.value))}/></label>
        <div className="forwardRoutePreview"><span>FORWARD ROUTE</span><code>127.0.0.1:{p.localPort||"—"}</code>
          <span aria-hidden="true">→ SSH →</span><code>{p.remoteHost.trim()||"remote host"}:{p.remotePort||"—"}</code></div>
        <button className="workspacePrimary" disabled={!p.connected||p.busy||!valid} onClick={p.onStart}>
          <Plus size={15}/>{p.busy?"Working…":"Start forwarding"}
        </button>
        {!p.connected&&<div className="forwardNotice"><LockKeyhole size={17}/>
          <span>Connect to a saved SSH host before creating a forward.</span>
          <button onClick={p.onTerminal}>Go to Terminal</button></div>}
        {p.error&&<div role="alert" className="workspaceError">{p.error}</div>}
      </section>
      <section className="forwardList">
        <div className="forwardListHeading"><h2><Network size={17}/> Active forwards</h2>
          <button onClick={p.onRefresh} disabled={!p.connected||p.busy}><RefreshCw size={14}/> Refresh</button>
        </div>
        <div className="forwardTableWrap"><table className="workspaceTable">
          <thead><tr><th>Local endpoint</th><th>Remote destination</th><th>SSH session</th><th>Actions</th></tr></thead>
          <tbody>{current.map(t=><tr key={t.session+":"+t.localPort} tabIndex={0}
            className={chosen?.session===t.session&&chosen.localPort===t.localPort?"selected":""}
            onClick={()=>setSelected(t.session+":"+t.localPort)}
            onKeyDown={e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();setSelected(t.session+":"+t.localPort)}}}>
            <td><code>127.0.0.1:{t.localPort}</code></td><td>{t.targetHost}:{t.remotePort}</td>
            <td title={t.session}><span className="forwardSecure"><ShieldCheck size={13}/> {t.session===p.session?"Selected PTY":"Other PTY"}</span></td>
            <td><div className="forwardRowActions">
              <button aria-label={"Copy local address for port "+t.localPort} title="Copy local address"
                onClick={()=>void copy("127.0.0.1:"+t.localPort)}><Clipboard size={14}/></button>
              <button aria-label={"Stop forward on port "+t.localPort} title="Stop local forward"
                className="dangerButton" disabled={p.busySessions.includes(t.session)} onClick={()=>p.onStop(t.session,t.localPort)}>
                <Square size={14}/> Stop</button>
            </div></td>
          </tr>)}</tbody></table>
          {current.length===0&&<WorkspaceEmpty icon={p.connected?Network:WifiOff}
            title={p.connected?"No active forwards":"SSH session required"}
            description={p.connected?"Create a local forward using the form. This view includes tunnels from every live SSH session on the selected host.":"Connect in Terminal to view or create local port forwards."}
            action={!p.connected?<button onClick={p.onTerminal}><TerminalSquare size={14}/> Open terminal</button>:undefined}/>}
        </div>
        {chosen&&<section className="forwardDetail" aria-label="Selected forward details">
          <div><small>SELECTED TUNNEL</small><strong>127.0.0.1:{chosen.localPort}</strong></div>
          <div><small>REMOTE ENDPOINT</small><strong>{chosen.targetHost}:{chosen.remotePort}</strong></div>
          <div><small>SSH SESSION</small><strong>{chosen.session===p.session?"Selected terminal":"Another connected terminal"}</strong></div>
          <button title="Copy local endpoint" onClick={()=>void copy("127.0.0.1:"+chosen.localPort)}>
            <Clipboard size={14}/> Copy address</button>
        </section>}
        {notice&&<p className="workspaceNotice" role="status">{notice}</p>}
        <div className="forwardTips"><h3><ShieldCheck size={17}/> Connection safety</h3>
          <p>Only loopback listeners are supported. Forwards are tied to an SSH session and stop on disconnect or Vault lock. Review remote destinations before starting a tunnel.</p>
          <button onClick={p.onTerminal}><TerminalSquare size={14}/> View SSH sessions <ExternalLink size={12}/></button>
        </div>
      </section>
    </div>
  </div>;
}
