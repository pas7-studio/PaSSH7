import {useState} from "react";
import {Activity, Bot, CheckCircle2, Clipboard, ExternalLink, LockKeyhole, Play, RefreshCw, Server, ShieldAlert, TerminalSquare} from "lucide-react";
import {AGENTS,type AgentKind} from "./integrations";
import {WorkspaceHeader,WorkspaceStatus} from "./WorkspaceChrome";

export type AgentProbeState={session:string;installed:boolean;version:string|null};
type Props={
  host:string;address:string;username:string;port:number;route:string;
  sessionId:string;sessions:{id:string;alias:string}[];vaultUnlocked:boolean;
  agent:AgentKind;onAgent:(kind:AgentKind)=>void;
  availability:Partial<Record<AgentKind,AgentProbeState>>;
  checking:boolean;error:string;status:string;context:string;
  onCheck:()=>void;onLaunch:()=>void;onTerminal:()=>void;onSession:(id:string)=>void;
};
export default function AgentWorkspace(p:Props){
  const [copyFeedback,setCopyFeedback]=useState("");
  const connected=Boolean(p.sessionId&&p.vaultUnlocked);
  const selected=AGENTS.find(a=>a.kind===p.agent)!;
  const probe=p.availability[p.agent]?.session===p.sessionId?p.availability[p.agent]:null;
  const copyContext=async()=>{
    try{await navigator.clipboard.writeText(p.context);setCopyFeedback("Context copied (no secrets included).")}
    catch(error){setCopyFeedback("Could not copy context: "+String(error))}
  };
  return <div className="widePage agentPage">
    <WorkspaceHeader icon={Bot} title="AI Agents" description="Choose, verify and launch a coding assistant on your authenticated SSH server."
      status={connected?"connected":"offline"} statusText={connected?"SSH connected · "+p.host:"No active SSH session"}/>
    <section className="agentHero" aria-label="Agent SSH connection">
      <div className="agentHeroIdentity"><span className="agentHeroIcon"><Server size={22}/></span>
        <div><small>ACTIVE TARGET</small><h2>{p.host}</h2><p>{p.username}@{p.address}:{p.port}</p></div></div>
      <div className="agentHeroMeta"><span><Activity size={15}/>{p.route}</span><span>{p.sessions.length} authenticated session{p.sessions.length===1?"":"s"}</span>
        <WorkspaceStatus kind={connected?"connected":"offline"}>{connected?"Ready for agent launch":"Connect to continue"}</WorkspaceStatus></div>
      <div className="agentHeroActions">
        {p.sessions.length>1&&<label>SSH terminal
          <select aria-label="Choose SSH terminal for agent" value={p.sessionId} onChange={e=>p.onSession(e.target.value)}>
            {!p.sessionId&&<option value="">Select a session</option>}
            {p.sessions.map((s,index)=><option key={s.id} value={s.id}>{s.alias} · session {index+1}</option>)}
          </select>
        </label>}
        <button type="button" onClick={p.onTerminal}><TerminalSquare size={15}/> Open terminal <ExternalLink size={13}/></button>
      </div>
    </section>
    {!connected&&<div className="agentConnectNotice" role="status"><LockKeyhole size={20}/><div><strong>Connect to a host to use its agents</strong><p>{!p.vaultUnlocked?"Unlock your encrypted Vault, select a host, then connect in Terminal.":"Open Terminal and connect to this host. Remote CLI checks and launches require an authenticated session."}</p></div><button type="button" onClick={p.onTerminal}>Go to Terminal</button></div>}
    <div className="agentWorkspaceGrid">
      <div className="agentWorkspaceMain">
        <section className="agentSection">
          <div className="agentSectionHead"><div><h2>Choose your assistant</h2><p>Each assistant starts in the remote terminal using that server account.</p></div>
            <button type="button" onClick={p.onCheck} disabled={!connected||p.checking}><RefreshCw size={15}/>{p.checking?"Checking…":"Check installed tools"}</button>
          </div>
          <div className="agentCards">
            {AGENTS.map(a=>{
              const detected=p.availability[a.kind]?.session===p.sessionId?p.availability[a.kind]:null;
              return <button type="button" key={a.kind} className={"agentCard "+a.kind+(p.agent===a.kind?" active":"")}
                aria-pressed={p.agent===a.kind} onClick={()=>p.onAgent(a.kind)}>
                <span className={"agentMark "+a.kind}><Bot size={23}/></span>
                <strong>{a.name}</strong>
                <small>{a.description}</small>
                <span className="agentDetection"><WorkspaceStatus kind={detected?.installed?"connected":detected?"warning":"offline"}>
                  {detected?.installed?"Installed":detected?"Not found":"Not checked"}
                </WorkspaceStatus></span>
                {detected?.installed&&detected.version&&<span className="agentVersion" title={detected.version}>{detected.version}</span>}
              </button>;
            })}
          </div>
          {p.error&&<div className="workspaceError" role="alert">{p.error}</div>}
        </section>
        <section className="agentSection agentLaunch">
          <div className="agentSectionHead"><div><h2>Launch {selected.name}</h2><p>Launch directly in your existing SSH terminal, with no extra installation or connection step.</p></div></div>
          <div className="agentLaunchRow"><div className="agentLaunchCommand"><span>REMOTE SHELL</span><code>{p.agent}</code></div>
            <button type="button" className="workspacePrimary" disabled={!connected} onClick={p.onLaunch}><Play size={16}/> Launch {selected.name} in Terminal</button></div>
          <p className="agentHint">{probe?.installed?"This CLI was detected in the remote shell.":"If the CLI uses a custom interactive shell PATH, detection can miss it. You can still launch it manually."} The current terminal must be at a shell prompt; running commands within another interactive program may have a different effect.</p>
          {p.status&&<p role="status" className="workspaceNotice">{p.status}</p>}
        </section>
        <section className="agentSection">
          <div className="agentSectionHead"><div><h2>SSH context</h2><p>Review the non-secret information PaSSH7 displays. This preview is not automatically sent to any agent.</p></div>
            <button type="button" onClick={()=>void copyContext()}><Clipboard size={14}/> Copy context</button></div>
          <pre className="agentContextPreview">{p.context}</pre>
          {copyFeedback&&<p role="status" className="agentHint">{copyFeedback}</p>}
        </section>
      </div>
      <aside className="agentWorkspaceSide">
        <section className="agentSection agentSafetyPanel"><h2><ShieldAlert size={18}/> Permissions & safety</h2>
          <p>Remote CLIs execute with the full permissions of <strong>{p.username||"your SSH account"}</strong> on the selected host. They are not sandboxed by PaSSH7.</p>
          <div className="agentSafetyRows"><div><CheckCircle2 size={16}/><span>SSH uses the host's verified fingerprint and native session.</span></div>
            <div><CheckCircle2 size={16}/><span>Your private SSH keys remain in the local encrypted Vault.</span></div>
            <div><ShieldAlert size={16}/><span>No scoped MCP broker, command approvals or resource grants are active yet.</span></div></div>
        </section>
        <section className="agentSection"><h2>How it works</h2>
          <ol className="agentSteps"><li>Connect to the remote host in Terminal.</li><li>Choose an agent and optionally check installation.</li><li>Launch; PaSSH7 switches back to that SSH terminal.</li></ol>
          <button type="button" onClick={p.onTerminal}><TerminalSquare size={15}/> View SSH sessions</button>
        </section>
      </aside>
    </div>
  </div>;
}
