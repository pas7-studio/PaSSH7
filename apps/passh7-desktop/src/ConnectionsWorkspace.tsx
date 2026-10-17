import {useMemo,useState} from "react";
import {CheckCircle2,KeyRound,LockKeyhole,Plus,Search,Server,ShieldAlert,ShieldCheck,TerminalSquare,Upload,WifiOff} from "lucide-react";
import {WorkspaceHeader,WorkspaceEmpty,WorkspaceMetric,WorkspaceStatus} from "./WorkspaceChrome";

export type ConnectionHost={
  id:string;label:string;address:string;user:string;port:number;fingerprint:boolean;
  jumpAlias?:string|null;hasSavedCredentials?:boolean;group?:string
};
type Props={
  hosts:ConnectionHost[];selected:string;connectedAliases:string[];vaultUnlocked:boolean;
  onSelect:(alias:string)=>void;onConnect:(alias:string)=>void;onTerminal:(alias:string)=>void;
  onAdd:()=>void;onImport:()=>void;
};
export default function ConnectionsWorkspace(p:Props){
  const [search,setSearch]=useState("");
  const [view,setView]=useState<"all"|"connected"|"trusted">("all");
  const connected=new Set(p.connectedAliases);
  const filtered=useMemo(()=>p.hosts.filter(host=>{
    if(view==="connected"&&!connected.has(host.id))return false;
    if(view==="trusted"&&!host.fingerprint)return false;
    return (host.label+" "+host.address+" "+host.user+" "+(host.group||"")).toLocaleLowerCase()
      .includes(search.trim().toLocaleLowerCase());
  }).sort((a,b)=>Number(connected.has(b.id))-Number(connected.has(a.id))||a.label.localeCompare(b.label)),
  [p.hosts,p.connectedAliases,search,view]);
  const selected=filtered.find(host=>host.id===p.selected)||filtered[0];
  return <div className="widePage connectionsPage">
    <WorkspaceHeader icon={Server} title="Connections" description="Your SSH hosts, fingerprints and live sessions in one place."
      trailing={<span className="workspaceHeaderCount">{p.hosts.length} saved hosts</span>}/>
    <div className="connectionsMetrics workspaceMetrics">
      <WorkspaceMetric icon={Server} label="Saved hosts" value={p.hosts.length} detail="Encrypted Vault entries"/>
      <WorkspaceMetric icon={CheckCircle2} label="Connected hosts" value={connected.size} intent="good" detail="Authenticated sessions"/>
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
            onKeyDown={e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();p.onSelect(host.id)}}}>
            <td><button className="connectionsHostName" onClick={()=>p.onSelect(host.id)}><Server size={16}/><strong>{host.label}</strong></button></td>
            <td><div className="connectionsTarget">{host.user}@{host.address}:{host.port}{host.jumpAlias&&<small>Via {host.jumpAlias}</small>}</div></td>
            <td><WorkspaceStatus kind={host.fingerprint?"trusted":"warning"}>{host.fingerprint?"Pinned":"Verify key"}</WorkspaceStatus></td>
            <td><WorkspaceStatus kind={connected.has(host.id)?"connected":"offline"}>{connected.has(host.id)?"Connected":"Offline"}</WorkspaceStatus></td>
            <td><div className="connectionRowActions"><button onClick={()=>p.onTerminal(host.id)}><TerminalSquare size={14}/> Terminal</button>
              <button className="workspacePrimary" onClick={()=>p.onConnect(host.id)}>{connected.has(host.id)?"New session":host.hasSavedCredentials?"Quick connect":"Connect"}</button></div></td>
          </tr>)}</tbody></table>
          {filtered.length===0&&<WorkspaceEmpty icon={p.hosts.length===0?Server:Search}
            title={p.hosts.length===0?"No saved hosts":"No matching hosts"}
            description={p.hosts.length===0?"Add an SSH host or import your OpenSSH config to begin.":"Change the search or status filter to find another host."}
            action={p.hosts.length===0?<button className="workspacePrimary" onClick={p.onAdd}><Plus size={14}/> Add host</button>:<button onClick={()=>{setSearch("");setView("all")}}>Clear filters</button>}/>}</div>
      </section>
      <aside className="connectionsInspector">
        <h2><Server size={17}/> Host details</h2>
        {selected?<><div className="connectionPreview"><Server size={27}/><strong>{selected.label}</strong><span>{selected.user}@{selected.address}:{selected.port}</span></div>
          <dl className="diagnosticList"><dt>Connection</dt><dd>{connected.has(selected.id)?"Connected":"Offline"}</dd>
            <dt>Server identity</dt><dd>{selected.fingerprint?"Pinned SHA-256":"Verification required"}</dd>
            <dt>Route</dt><dd>{selected.jumpAlias?"Via "+selected.jumpAlias:"Direct SSH"}</dd>
            <dt>Saved login</dt><dd>{selected.hasSavedCredentials?"In encrypted Vault":"Manual login"}</dd></dl>
          <button className="workspacePrimary" onClick={()=>p.onConnect(selected.id)}><TerminalSquare size={15}/> {connected.has(selected.id)?"Open another session":"Connect securely"}</button>
          <button onClick={()=>p.onTerminal(selected.id)}>Open in Terminal</button>
          <p className="prefInfo"><KeyRound size={14}/> A trusted host fingerprint is required before sending any SSH credentials.</p>
        </>:<WorkspaceEmpty icon={WifiOff} title="No selected host" description="Choose a saved host to inspect its connection and launch options."/>}
        {!p.vaultUnlocked&&<div className="workspaceError"><LockKeyhole size={14}/> Unlock your Vault before connecting.</div>}
      </aside>
    </div>
  </div>;
}
