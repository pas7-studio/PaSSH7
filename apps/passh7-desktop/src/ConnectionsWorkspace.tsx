import {useMemo,useState} from "react";
import {Activity,CheckCircle2,FolderClosed,KeyRound,LockKeyhole,Plus,Search,Server,ShieldAlert,ShieldCheck,TerminalSquare,Upload} from "lucide-react";

export type ConnectionHost={
  id:string;label:string;address:string;user:string;port:number;fingerprint:boolean;
  jumpAlias?:string|null;hasSavedCredentials?:boolean
};
type Props={
  hosts:ConnectionHost[];selected:string;connectedAliases:string[];vaultUnlocked:boolean;
  onSelect:(alias:string)=>void;onConnect:(alias:string)=>void;onTerminal:(alias:string)=>void;
  onAdd:()=>void;onImport:()=>void;
};
export default function ConnectionsWorkspace(p:Props){
  const [search,setSearch]=useState("");
  const filtered=useMemo(()=>p.hosts.filter(host=>
    (host.label+" "+host.address+" "+host.user).toLocaleLowerCase().includes(search.toLocaleLowerCase())
  ),[p.hosts,search]);
  const connected=new Set(p.connectedAliases);
  const selected=p.hosts.find(host=>host.id===p.selected)||filtered[0];
  return <div className="widePage connectionsPage">
    <div className="widePageTitle"><Server size={34}/><div><h1>Connections</h1><p>Manage your saved SSH hosts and open a verified connection in seconds.</p></div>
      <span className="connectionsCount">{p.hosts.length} saved host{p.hosts.length===1?"":"s"}</span></div>
    <div className="connectionsMetrics">
      <div><Server size={19}/><span>Saved hosts</span><strong>{p.hosts.length}</strong></div>
      <div><CheckCircle2 size={19}/><span>Connected hosts</span><strong>{new Set(p.connectedAliases).size}</strong></div>
      <div><ShieldCheck size={19}/><span>Trusted fingerprints</span><strong>{p.hosts.filter(host=>host.fingerprint).length}</strong></div>
    </div>
    <div className="connectionsBody">
      <section className="connectionsList">
        <div className="connectionsToolbar"><label className="filesSearch"><Search size={16}/><input aria-label="Search saved SSH hosts" placeholder="Search hosts, usernames or addresses…" value={search} onChange={e=>setSearch(e.target.value)}/></label>
          <button onClick={p.onImport}><Upload size={15}/> Import SSH config</button>
          <button className="workspacePrimary" onClick={p.onAdd}><Plus size={15}/> Add host</button></div>
        <div className="connectionsTableWrap"><table className="workspaceTable"><thead><tr><th>Host</th><th>Target</th><th>Trust</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>{filtered.map(host=><tr key={host.id} className={host.id===p.selected?"selected":""}>
            <td><button className="connectionsHostName" onClick={()=>p.onSelect(host.id)}><Server size={16}/><strong>{host.label}</strong></button></td>
            <td><div className="connectionsTarget">{host.user}@{host.address}:{host.port}{host.jumpAlias&&<small>Via {host.jumpAlias}</small>}</div></td>
            <td><span className={host.fingerprint?"connectionTrust good":"connectionTrust pending"}>{host.fingerprint?<ShieldCheck size={13}/>:<ShieldAlert size={13}/>} {host.fingerprint?"Pinned":"Verify key"}</span></td>
            <td><span className={connected.has(host.id)?"connectionState online":"connectionState"}>● {connected.has(host.id)?"Connected":"Offline"}</span></td>
            <td><div className="connectionRowActions"><button onClick={()=>p.onTerminal(host.id)}><TerminalSquare size={14}/> Terminal</button>
              <button className="workspacePrimary" onClick={()=>p.onConnect(host.id)}>{connected.has(host.id)?"New session":host.hasSavedCredentials?"Quick connect":"Connect"}</button></div></td>
          </tr>)}</tbody></table>
          {filtered.length===0&&<div className="workspaceEmpty">{p.hosts.length===0?"No SSH hosts saved. Add your first connection or import a local OpenSSH config.":"No hosts match this search."}</div>}</div>
      </section>
      <aside className="connectionsInspector">
        <h2><Activity size={17}/> Selected host</h2>
        {selected?<><div className="connectionPreview"><Server size={27}/><strong>{selected.label}</strong><span>{selected.user}@{selected.address}:{selected.port}</span></div>
          <dl className="diagnosticList"><dt>Connection</dt><dd>{connected.has(selected.id)?"Connected":"Offline"}</dd>
            <dt>Server identity</dt><dd>{selected.fingerprint?"Pinned SHA-256":"Verification required"}</dd>
            <dt>Route</dt><dd>{selected.jumpAlias?"Via "+selected.jumpAlias:"Direct SSH"}</dd>
            <dt>Saved login</dt><dd>{selected.hasSavedCredentials?"In encrypted Vault":"Manual login"}</dd></dl>
          <button className="workspacePrimary" onClick={()=>p.onConnect(selected.id)}><TerminalSquare size={15}/> {connected.has(selected.id)?"Open another session":"Connect securely"}</button>
          <button onClick={()=>p.onTerminal(selected.id)}>Open in Terminal</button>
          <p className="prefInfo"><KeyRound size={14}/> A trusted host fingerprint is required before sending any SSH credentials.</p>
        </>:<div className="workspaceEmpty">Select a saved host to see its connection details.</div>}
        {!p.vaultUnlocked&&<div className="workspaceError"><LockKeyhole size={14}/> Unlock your Vault before connecting.</div>}
      </aside>
    </div>
  </div>;
}
