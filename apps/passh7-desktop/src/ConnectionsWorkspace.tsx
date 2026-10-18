import {useEffect,useMemo,useRef,useState} from "react";
import {CheckCircle2,KeyRound,LockKeyhole,Pencil,Plus,RefreshCw,Search,Server,Trash2,ShieldAlert,ShieldCheck,TerminalSquare,Upload,WifiOff} from "lucide-react";
import {WorkspaceHeader,WorkspaceEmpty,WorkspaceMetric,WorkspaceStatus} from "./WorkspaceChrome";
import type {SshProbeResult} from "./backend";

export type ConnectionHost={
  id:string;label:string;address:string;user:string;port:number;fingerprint:boolean;
  jumpAlias?:string|null;hasSavedCredentials?:boolean;group?:string;identityAlias?:string|null
};
type Props={
  hosts:ConnectionHost[];selected:string;connectedAliases:string[];vaultUnlocked:boolean;
  onSelect:(alias:string)=>void;onConnect:(alias:string)=>void;onTerminal:(alias:string)=>void;
  onAdd:()=>void;onImport:()=>void;onProbe:(alias:string)=>Promise<SshProbeResult>;
  onEdit:(alias:string)=>void;onDelete:(alias:string)=>void;
};
export default function ConnectionsWorkspace(p:Props){
  const [search,setSearch]=useState("");
  const [view,setView]=useState<"all"|"connected"|"trusted">("all");
  const connected=new Set(p.connectedAliases);
  const [testing,setTesting]=useState("");
  const [testResult,setTestResult]=useState<{alias:string;result:SshProbeResult|null;error:string}|null>(null);
  const testGeneration=useRef(0);
  const testHost=async(alias:string)=>{
    if(!p.vaultUnlocked||testing)return;
    const generation=++testGeneration.current;
    setTesting(alias);setTestResult(null);
    try{
      const result=await p.onProbe(alias);
      if(generation===testGeneration.current)setTestResult({alias,result,error:""});
    }catch(error){
      if(generation===testGeneration.current)setTestResult({alias,result:null,error:String(error)});
    }finally{
      if(generation===testGeneration.current)setTesting("");
    }
  };
  const filtered=useMemo(()=>p.hosts.filter(host=>{
    if(view==="connected"&&!connected.has(host.id))return false;
    if(view==="trusted"&&!host.fingerprint)return false;
    return (host.label+" "+host.address+" "+host.user+" "+(host.group||"")).toLocaleLowerCase()
      .includes(search.trim().toLocaleLowerCase());
  }).sort((a,b)=>Number(connected.has(b.id))-Number(connected.has(a.id))||a.label.localeCompare(b.label)),
  [p.hosts,p.connectedAliases,search,view]);
  const selected=filtered.find(host=>host.id===p.selected)||filtered[0];
  // A successful TCP banner is a point-in-time observation, never a lasting
  // server health/identity claim. Clear it when the user switches hosts.
  useEffect(()=>{
    testGeneration.current++;
    setTesting("");
    setTestResult(null);
  },[selected?.id]);
  return <div className="widePage connectionsPage">
    <WorkspaceHeader icon={Server} title="Connections" description="Your SSH hosts, fingerprints and live sessions in one place."
      trailing={<span className="workspaceHeaderCount">{p.hosts.length} saved hosts</span>}/>
    <div className="connectionsMetrics workspaceMetrics">
      <WorkspaceMetric icon={Server} label="Saved hosts" value={p.hosts.length} detail="Encrypted Vault entries"/>
      <WorkspaceMetric icon={CheckCircle2} label="Connected hosts" value={connected.size} intent="good" detail={p.connectedAliases.length+" authenticated session(s) across these hosts"}/>
      <WorkspaceMetric icon={ShieldCheck} label="Trusted keys" value={p.hosts.filter(host=>host.fingerprint).length} detail="Pinned host fingerprints"/>
    </div>
    <div className="connectionsBody">
      <section className="connectionsList">
        <div className="connectionsToolbar"><label className="filesSearch"><Search size={16}/><input aria-label="Search saved SSH hosts" placeholder="Search hosts, usernames or addresses…" value={search} onChange={e=>setSearch(e.target.value)}/></label>
          <button onClick={p.onImport}><Upload size={15}/> Import SSH config</button>
          <button className="workspacePrimary" onClick={p.onAdd}><Plus size={15}/> Add host</button></div>
        <div className="workspaceFilterBar" role="group" aria-label="Filter saved hosts">
          {(["all","connected","trusted"] as const).map(kind=><button type="button" key={kind} aria-pressed={view===kind}
            className={view===kind?"active":""} onClick={()=>setView(kind)}>
            {kind==="all"?"All hosts":kind==="connected"?"Connected":"Trusted"} <span>{kind==="all"?p.hosts.length:kind==="connected"?connected.size:p.hosts.filter(h=>h.fingerprint).length}</span>
          </button>)}
        </div>
        <div className="connectionsTableWrap"><table className="workspaceTable"><thead><tr><th>Host</th><th>Target</th><th>Trust</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>{filtered.map(host=><tr key={host.id} tabIndex={0} aria-selected={host.id===p.selected}
            className={host.id===p.selected?"selected":""} onClick={()=>p.onSelect(host.id)}
            onKeyDown={e=>{if(e.target!==e.currentTarget)return;if(e.key==="Enter"||e.key===" "){e.preventDefault();p.onSelect(host.id)}}}>
            <td><button className="connectionsHostName" onClick={event=>{event.stopPropagation();p.onSelect(host.id)}}><Server size={16}/><strong>{host.label}</strong></button></td>
            <td><div className="connectionsTarget">{host.user}@{host.address}:{host.port}{host.jumpAlias&&<small>Via {host.jumpAlias}</small>}</div></td>
            <td><WorkspaceStatus kind={host.fingerprint?"trusted":"warning"}>{host.fingerprint?"Pinned":"Verify key"}</WorkspaceStatus></td>
            <td><WorkspaceStatus kind={connected.has(host.id)?"connected":"offline"}>{connected.has(host.id)?p.connectedAliases.filter(alias=>alias===host.id).length+" session(s)":"Not connected"}</WorkspaceStatus></td>
            <td><div className="connectionRowActions">
              <button title={"Edit "+host.label+" SSH connection"} aria-label={"Edit "+host.label}
                disabled={!p.vaultUnlocked} onClick={event=>{event.stopPropagation();p.onEdit(host.id)}}><Pencil size={14}/> Edit</button>
              <button title={"Remove "+host.label+" from Vault"} aria-label={"Remove "+host.label}
                className="dangerButton" disabled={!p.vaultUnlocked}
                onClick={event=>{event.stopPropagation();p.onDelete(host.id)}}><Trash2 size={14}/></button>
              <button onClick={event=>{event.stopPropagation();p.onTerminal(host.id)}}><TerminalSquare size={14}/> Terminal</button>
              <button className="workspacePrimary" onClick={event=>{event.stopPropagation();p.onConnect(host.id)}}>{connected.has(host.id)?"New session":host.hasSavedCredentials?"Quick connect":"Connect"}</button></div></td>
          </tr>)}</tbody></table>
          {filtered.length===0&&<WorkspaceEmpty icon={p.hosts.length===0?Server:Search}
            title={p.hosts.length===0?"No saved hosts":"No matching hosts"}
            description={p.hosts.length===0?"Add an SSH host or import your OpenSSH config to begin.":"Change the search or status filter to find another host."}
            action={p.hosts.length===0?<button className="workspacePrimary" onClick={p.onAdd}><Plus size={14}/> Add host</button>:<button onClick={()=>{setSearch("");setView("all")}}>Clear filters</button>}/>}</div>
      </section>
      <aside className="connectionsInspector">
        <h2><Server size={17}/> Host details</h2>
        {selected?<><div className="connectionPreview"><Server size={27}/><strong>{selected.label}</strong><span>{selected.user}@{selected.address}:{selected.port}</span></div>
          <dl className="diagnosticList"><dt>Connection</dt><dd>{connected.has(selected.id)?p.connectedAliases.filter(alias=>alias===selected.id).length+" active SSH session(s)":"Not connected"}</dd>
            <dt>Server identity</dt><dd>{selected.fingerprint?"Pinned SHA-256":"Verification required"}</dd>
            <dt>Route</dt><dd>{selected.jumpAlias?"Via "+selected.jumpAlias:"Direct SSH"}</dd>
            <dt>SSH key</dt><dd>{selected.identityAlias||"None (password login)"}</dd>
            <dt>Saved login</dt><dd>{selected.hasSavedCredentials?"In encrypted Vault":"Manual login"}</dd></dl>
          <div className="connectionInspectorActions">
            <button onClick={()=>p.onEdit(selected.id)} disabled={!p.vaultUnlocked}><Pencil size={14}/> Edit connection</button>
            <button className="dangerButton" onClick={()=>p.onDelete(selected.id)} disabled={!p.vaultUnlocked}><Trash2 size={14}/> Remove</button>
          </div>
          <button className="workspacePrimary" onClick={()=>p.onConnect(selected.id)}><TerminalSquare size={15}/> {connected.has(selected.id)?"Open another session":"Connect securely"}</button>
          <button onClick={()=>p.onTerminal(selected.id)}>Open in Terminal</button>
          <div className="connectionProbePanel">
            <div><strong>SSH service check</strong><p>Read the SSH identification banner without using a password or logging in. A successful response does not verify the host key or authenticate you.</p></div>
            {selected.jumpAlias?<p className="prefInfo">This host uses a jump route via {selected.jumpAlias}. A direct TCP probe from your computer would bypass that route, so it is disabled here. Open an authenticated session through the gateway instead.</p>:
              <button type="button" disabled={!p.vaultUnlocked||testing===selected.id}
                onClick={()=>void testHost(selected.id)}><RefreshCw size={14}/>{testing===selected.id?"Checking SSH…":"Test SSH service"}</button>}
            {testResult?.alias===selected.id&&testResult.result&&<div className="workspaceNotice" role="status">
              <strong>SSH port responded in {testResult.result.elapsedMs} ms</strong>
              <code>{testResult.result.banner}</code>
              <small>TCP/banner only · host key and account not verified</small>
            </div>}
            {testResult?.alias===selected.id&&testResult.error&&<div className="workspaceError" role="alert">
              <strong>SSH service test failed</strong><span>{testResult.error}</span>
              <small>{/resolve|DNS/i.test(testResult.error)?"Check the hostname or local DNS/VPN connection.":/reach|timed out|timeout/i.test(testResult.error)?"Check routing, firewall, SSH port and whether the server is powered on.":/identification|protocol|banner|closed/i.test(testResult.error)?"The endpoint responded but did not provide a valid SSH banner; check the target port and sshd service.":"Check this host's address, SSH service and network access."}</small>
            </div>}
          </div>
          <p className="prefInfo"><KeyRound size={14}/> A trusted host fingerprint is required before sending any SSH credentials.</p>
        </>:<WorkspaceEmpty icon={WifiOff} title="No selected host" description="Choose a saved host to inspect its connection and launch options."/>}
        {!p.vaultUnlocked&&<div className="workspaceError"><LockKeyhole size={14}/> Unlock your Vault before connecting.</div>}
      </aside>
    </div>
  </div>;
}
