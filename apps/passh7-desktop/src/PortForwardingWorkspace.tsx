import {useState} from "react";
import {Activity,Clipboard,ExternalLink,LockKeyhole,Network,Plus,RefreshCw,ShieldCheck,Square,TerminalSquare} from "lucide-react";

export type Forward={session:string;localPort:number;targetHost:string;remotePort:number};
type Props={
  host:string;connected:boolean;session:string;forwards:Forward[];busy:boolean;error:string;
  localPort:number;remoteHost:string;remotePort:number;
  onLocalPort:(port:number)=>void;onRemoteHost:(host:string)=>void;onRemotePort:(port:number)=>void;
  onStart:()=>void;onRefresh:()=>void;onStop:(session:string,localPort:number)=>void;onTerminal:()=>void;
};
export default function PortForwardingWorkspace(p:Props){
  const [selected,setSelected]=useState<number|null>(null);
  const valid=p.localPort>=1&&p.localPort<=65535&&p.remotePort>=1&&p.remotePort<=65535&&p.remoteHost.trim().length>0;
  const current=p.forwards.filter(t=>t.session===p.session);
  const chosen=current.find(t=>t.localPort===selected)||current[0];
  return <div className="widePage forwardingPage">
    <div className="widePageTitle"><Network size={34}/><div><h1>Port Forwarding</h1><p>Expose selected remote TCP services safely on your local machine through SSH.</p></div>
      <span className={p.connected?"workspaceConnected":"workspaceOffline"}>{p.connected?"● "+p.host:"○ No SSH connection"}</span></div>
    <div className="forwardMetrics"><div><Activity size={19}/><span>Active local forwards</span><strong>{current.length}</strong></div>
      <div><ShieldCheck size={19}/><span>Local bind policy</span><strong>Loopback only</strong></div></div>
    <div className="forwardGrid">
      <section className="forwardForm"><h2><Plus size={17}/> New local forward</h2>
        <p>Creates a listener on this PC and tunnels its traffic to the target through the selected authenticated SSH session.</p>
        <label>Local TCP port<input type="number" min={1} max={65535} value={p.localPort} onChange={e=>p.onLocalPort(Number(e.target.value))}/></label>
        <div className="forwardFormHint">Binding address: <code>127.0.0.1</code> (fixed for safety)</div>
        <label>Remote destination host<input value={p.remoteHost} onChange={e=>p.onRemoteHost(e.target.value)} placeholder="127.0.0.1"/></label>
        <label>Remote destination port<input type="number" min={1} max={65535} value={p.remotePort} onChange={e=>p.onRemotePort(Number(e.target.value))}/></label>
        <button className="workspacePrimary" disabled={!p.connected||p.busy||!valid} onClick={p.onStart}><Plus size={15}/>{p.busy?"Working…":"Start forwarding"}</button>
        {!p.connected&&<div className="forwardNotice"><LockKeyhole size={17}/><span>Connect to a saved SSH host before creating a forward.</span><button onClick={p.onTerminal}>Go to Terminal</button></div>}
        {p.error&&<div role="alert" className="workspaceError">{p.error}</div>}
      </section>
      <section className="forwardList"><div className="forwardListHeading"><h2><Network size={17}/> Active forwards</h2>
        <button onClick={p.onRefresh} disabled={!p.connected||p.busy}><RefreshCw size={14}/> Refresh</button></div>
        <div className="forwardTableWrap"><table className="workspaceTable"><thead><tr><th>Local address</th><th>Remote destination</th><th>Transport</th><th>Actions</th></tr></thead><tbody>
          {current.map(t=><tr key={t.localPort} className={chosen?.localPort===t.localPort?"selected":""} onClick={()=>setSelected(t.localPort)}>
            <td><code>127.0.0.1:{t.localPort}</code></td><td>{t.targetHost}:{t.remotePort}</td><td><span className="forwardSecure"><ShieldCheck size={13}/> SSH</span></td>
            <td><div className="forwardRowActions"><button title="Copy local address" onClick={()=>void navigator.clipboard.writeText("127.0.0.1:"+t.localPort)}><Clipboard size={14}/></button>
              <button title="Stop local forward" className="dangerButton" disabled={p.busy} onClick={()=>p.onStop(t.session,t.localPort)}><Square size={14}/> Stop</button></div></td>
          </tr>)}</tbody></table>
          {current.length===0&&<div className="workspaceEmpty">{p.connected?"No active forwards on this SSH session. Create one using the form.":"Connect to a host to list its active forwards."}</div>}
        </div>
        <div className="forwardTips"><h3><ShieldCheck size={17}/> Connection safety</h3>
          <p>Only local loopback listeners are supported. Each forward is tied to a native SSH session and closes when that session ends or the Vault locks. DNS and destinations are resolved from the remote side, so review them before starting.</p>
          <button onClick={p.onTerminal}><TerminalSquare size={14}/> Open SSH terminal <ExternalLink size={12}/></button></div>
      </section>
    </div>
  </div>;
}
