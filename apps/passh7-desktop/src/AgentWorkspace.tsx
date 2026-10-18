import {useCallback,useRef,useState,type ReactNode} from "react";
import {Activity, Bot, CheckCircle2, Clipboard, ExternalLink, LockKeyhole, Maximize2, Minimize2, Play, RefreshCw, Server, ShieldAlert, TerminalSquare} from "lucide-react";
import {AGENTS,type AgentKind} from "./integrations";
import type {RemoteAgentAvailability,LocalAgentAvailability,LocalAgentConnection} from "./backend";
import {WorkspaceHeader,WorkspaceStatus} from "./WorkspaceChrome";

export type AgentProbeState=RemoteAgentAvailability&{session:string};
type Props={
  host:string;address:string;username:string;port:number;route:string;
  sessionId:string;sessions:{id:string;alias:string}[];vaultUnlocked:boolean;
  agent:AgentKind;onAgent:(kind:AgentKind)=>void;
  availability:Partial<Record<AgentKind,AgentProbeState>>;
  checking:boolean;error:string;status:string;context:string;
  mode:"auto"|"remote"|"local";onMode:(mode:"auto"|"remote"|"local")=>void;
  localAvailability:Partial<Record<AgentKind,LocalAgentAvailability>>;localChecking:boolean;
  localConnections:LocalAgentConnection[];localRevoking:string;onRevokeLocal:(id:string)=>void;
  onCheck:()=>void;onLaunch:()=>void;onTerminal:()=>void;onSession:(id:string)=>void;
  onPrepareRdp:()=>void;
  liveTerminal?:boolean;onTerminalDock?:(node:HTMLDivElement|null)=>void;
  terminalPreview?:ReactNode;
};
export default function AgentWorkspace(p:Props){
  const [copyFeedback,setCopyFeedback]=useState("");
  const [expandedConsole,setExpandedConsole]=useState(false);
  const terminalPane=useRef<HTMLDivElement>(null);
  const setDock=useCallback((node:HTMLDivElement|null)=>{
    terminalPane.current=node;
    p.onTerminalDock?.(node);
  },[p.onTerminalDock]);
  const focusTerminal=()=>{
    const input=terminalPane.current?.querySelector(".xterm-helper-textarea");
    if(input instanceof HTMLTextAreaElement)input.focus();
  };
  const connected=Boolean(p.sessionId&&p.vaultUnlocked);
  const selected=AGENTS.find(a=>a.kind===p.agent)!;
  const [installFeedback,setInstallFeedback]=useState("");
  const probe=p.availability[p.agent]?.session===p.sessionId?p.availability[p.agent]:null;
  const installation:Record<AgentKind,{command:string;url:string;label:string}>={
    codex:{command:"npm install -g @openai/codex",url:"https://github.com/openai/codex",label:"Codex CLI installation"},
    claude:{command:"npm install -g @anthropic-ai/claude-code",url:"https://docs.anthropic.com/en/docs/claude-code/getting-started",label:"Claude Code setup"},
    opencode:{command:"npm install -g opencode-ai",url:"https://opencode.ai/docs/",label:"OpenCode CLI installation"}
  };
  const cliStatus=(state:AgentProbeState|null|undefined)=>{
    if(!state)return "Not checked";
    if(state.installed)return "CLI detected";
    if(state.location)return "CLI needs repair";
    if(state.desktopApp)return "Desktop app only";
    return "CLI missing";
  };
  const copyInstall=async()=>{
    try{await navigator.clipboard.writeText(installation[p.agent].command);setInstallFeedback("Install command copied. Review it before running on the remote host.")}
    catch(error){setInstallFeedback("Clipboard unavailable: "+String(error))}
  };
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
          <div className="agentSectionHead"><div><h2>Execution location</h2>
            <p>Use an existing signed-in CLI. No provider API keys and no remote service installation.</p>
          </div></div>
          <div className="agentModeGrid" role="group" aria-label="Agent execution mode">
            {([
              ["auto","Auto · remote first","Remote CLI if installed; otherwise local CLI with our SSH tools."],
              ["remote","Remote CLI","Run directly in the authenticated SSH terminal."],
              ["local","Local CLI + SSH","Run your local CLI and give it scoped remote command/file tools."]
            ] as const).map(([value,label,description])=>
              <button key={value} type="button" aria-pressed={p.mode===value}
                className={"agentModeOption"+(p.mode===value?" active":"")}
                onClick={()=>p.onMode(value)}><strong>{label}</strong><small>{description}</small></button>
            )}
          </div>
          {p.mode==="local"&&<p className="agentHint">The CLI runs on this computer in a separate console. Its normal built-in shell/files remain local; use passh7 remote_exec, remote_list, remote_read, remote_write for server operations. Each SSH grant is specific to the selected session.</p>}
        </section>
        <section className="agentSection">
          <div className="agentSectionHead"><div><h2>Choose your assistant</h2><p>PaSSH7 checks whether terminal CLIs are installed and runnable on either machine. Sign-in is verified by the CLI when launched.</p></div>
            <button type="button" onClick={p.onCheck} disabled={!connected||p.checking||p.localChecking}><RefreshCw size={15}/>{p.checking||p.localChecking?"Checking…":"Check both machines"}</button>
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
                  Remote: {cliStatus(detected)}
                </WorkspaceStatus></span>
                <span className="agentDetection"><WorkspaceStatus kind={p.localAvailability[a.kind]?.installed?"connected":p.localAvailability[a.kind]?"warning":"offline"}>
                  Local: {p.localAvailability[a.kind]?.installed?"CLI verified":p.localAvailability[a.kind]?"CLI unavailable":"Not checked"}
                </WorkspaceStatus></span>
                {detected?.installed&&detected.version&&<span className="agentVersion" title={detected.version}>{detected.version}</span>}
              </button>;
            })}
          </div>
          {p.error&&<div className="workspaceError" role="alert">{p.error}</div>}
        </section>
        <section className="agentSection agentLaunch">
          <div className="agentSectionHead"><div><h2>Launch {selected.name}</h2>
              <p>{p.mode==="local"?"Launch your installed local CLI in a separate console, connected to the selected SSH session. Your CLI may ask you to sign in.":p.mode==="auto"?"Prefer remote CLI; automatically fall back to a local signed-in CLI through SSH.":"Run the signed-in remote CLI in the SSH console below."}</p>
            </div></div>
          <div className="agentLaunchRow"><div className="agentLaunchCommand">
              <span>{p.mode==="local"?"LOCAL CLI · PaSSH7 SSH tools":p.mode==="auto"?"AUTO · REMOTE THEN LOCAL":probe?.platform==="windows"?"WINDOWS REMOTE CLI":"REMOTE SHELL"}</span>
              <code>{p.agent}</code>
            </div>
            <button type="button" className="workspacePrimary"
              disabled={!connected||(p.mode==="remote"&&probe?.platform==="windows"&&!probe.installed)}
              onClick={p.onLaunch}><Play size={16}/> {p.mode==="local"?"Launch local CLI":p.mode==="auto"?"Launch automatically":"Launch remote CLI"}</button></div>
          <p className="agentHint">{p.mode==="local"?"The local CLI retains its existing login. PaSSH7 does not pass Vault credentials or tokens to a remote agent.":probe?.installed?"A CLI was detected for this SSH account; actual login is handled by that CLI.":"Detection distinguishes real terminal commands from GUI apps. Auto can use a local CLI when the remote one is absent."} {p.mode!=="local"?"Ensure the SSH terminal is at a shell prompt before launching a remote CLI.":""}</p>
          {probe&&<div className="agentDiscovery" aria-label="Remote CLI discovery">
            <div><strong>Detected platform</strong><span>{probe.platform==="windows"?"Windows SSH":probe.platform==="unix"?"Unix SSH":"Unknown"}</span></div>
            <div><strong>CLI availability</strong><span>{cliStatus(probe)}</span></div>
            {probe.source&&<div><strong>Discovery source</strong><span>{probe.source}</span></div>}
            {probe.location&&<div><strong>CLI executable</strong><code title={probe.location}>{probe.location}</code></div>}
            {probe.desktopApp&&<div><strong>GUI application</strong><span>{probe.desktopApp} · Windows desktop / RDP only</span></div>}
            {probe.diagnostic&&<p>{probe.diagnostic}</p>}
          </div>}
          {p.mode==="remote"&&probe?.platform==="windows"&&!probe.installed&&<div className="agentInstallHelp">
            <strong>{probe.location?"CLI launcher needs repair":probe.desktopApp?"Desktop ≠ terminal CLI":"CLI not found in this SSH account"}</strong>
            <p>{probe.location?"The executable exists, but its version check failed. Verify Node.js and this SSH account's environment before reinstalling.":"Graphical apps run in the Windows desktop session. SSH provides a text terminal, not the app's window. Use Remote Desktop (RDP) for the GUI, or install the separate CLI below."}</p>
            <div><code>{installation[p.agent].command}</code><button type="button" onClick={()=>void copyInstall()}><Clipboard size={14}/> Copy install command</button></div>
            <a href={installation[p.agent].url} target="_blank" rel="noreferrer">{installation[p.agent].label} <ExternalLink size={12}/></a>
            {probe.desktopApp&&<div className="agentRdpHelp">
              <strong>Use the installed desktop app through RDP</strong>
              <p>Open an RDP tunnel via your SSH connection, then use the Windows Remote Desktop client. Remote Desktop must be enabled on the target Windows machine.</p>
              <button type="button" onClick={p.onPrepareRdp}><ExternalLink size={14}/> Prepare RDP tunnel in Port Forwarding</button>
              <code>mstsc /v:127.0.0.1:13389</code>
              <small>Start the tunnel first. PaSSH7 does not auto-enable Windows Remote Desktop, open desktop sessions or run GUI apps inside SSH.</small>
            </div>}
            <p>The install command is never executed automatically. Reconnect SSH or re-check CLI detection after installation.</p>
          </div>}
          {installFeedback&&<p className="workspaceNotice" role="status">{installFeedback}</p>}
          {p.status&&<p role="status" className="workspaceNotice">{p.status}</p>}
        </section>
        <section className="agentSection" aria-label="Local CLI SSH grants">
          <div className="agentSectionHead"><div><h2>Active local CLI access</h2>
            <p>These are live SSH tool grants, not provider logins. Each grant is bound to one SSH session. Revoking access leaves the local CLI window open.</p></div></div>
          {!p.localConnections.length?<p className="agentHint">No local CLI has active SSH access. Launch a local assistant above to issue a temporary grant.</p>:
            p.localConnections.map(item=><div className="agentLaunchRow" key={item.id}>
              <div className="agentLaunchCommand">
                <span>{item.host} · {item.sessionId===p.sessionId?"CURRENT SSH SESSION":"OTHER SSH SESSION"}</span>
                <code>{AGENTS.find(a=>a.kind===item.agent)?.name??item.agent}</code>
                <small>Access granted {item.ageSeconds<60?"less than a minute":Math.floor(item.ageSeconds/60)+" min"} ago</small>
              </div>
              <button type="button" disabled={p.localRevoking===item.id} onClick={()=>p.onRevokeLocal(item.id)}>
                <LockKeyhole size={15}/>{p.localRevoking===item.id?"Revoking…":"Revoke SSH access"}
              </button>
            </div>)}
          {p.localConnections.length>0&&<p className="agentHint">Revocation rejects new remote commands and file operations. It cannot undo or guarantee cancellation of work already running on the SSH host.</p>}
        </section>
        {(p.liveTerminal||p.terminalPreview)&&connected&&<section className="agentSection agentEmbeddedTerminal" aria-label="Live agent SSH terminal">
          <div className="agentSectionHead"><div><h2><TerminalSquare size={17}/> Interactive SSH terminal</h2>
            <p>Connected to {p.host}. Commands and agent output use your existing authenticated PTY session.</p></div>
            <div className="agentTerminalActions">
              <button type="button" onClick={focusTerminal}><TerminalSquare size={14}/> Focus console</button>
              <button type="button" aria-pressed={expandedConsole} onClick={()=>setExpandedConsole(open=>!open)}>
                {expandedConsole?<Minimize2 size={14}/>:<Maximize2 size={14}/>}
                {expandedConsole?"Compact console":"Expand console"}
              </button>
              <button type="button" onClick={p.onTerminal}><ExternalLink size={14}/> Full Terminal workspace</button>
            </div>
          </div>
          <div className={"agentTerminalFrame"+(expandedConsole?" expanded":"")} ref={setDock}>{p.terminalPreview}</div>
          <p className="agentHint">Type directly in this terminal. Select another SSH session above to change the active console. Nothing is executed without your action.</p>
        </section>}
        <section className="agentSection">
          <div className="agentSectionHead"><div><h2>SSH context</h2><p>Review the non-secret information PaSSH7 displays. This preview is not automatically sent to any agent.</p></div>
            <button type="button" onClick={()=>void copyContext()}><Clipboard size={14}/> Copy context</button></div>
          <pre className="agentContextPreview">{p.context}</pre>
          {copyFeedback&&<p role="status" className="agentHint">{copyFeedback}</p>}
        </section>
      </div>
      <aside className="agentWorkspaceSide">
        <section className="agentSection agentSafetyPanel"><h2><ShieldAlert size={18}/> Permissions & safety</h2>
          <p>Remote CLI runs as <strong>{p.username||"your SSH account"}</strong>. Local CLI retains its local login but gains remote command and SFTP access through the selected authenticated SSH session. Neither mode is a sandbox.</p>
          <div className="agentSafetyRows"><div><CheckCircle2 size={16}/><span>SSH uses the host's verified fingerprint and native session.</span></div>
            <div><CheckCircle2 size={16}/><span>Your private SSH keys remain in the local encrypted Vault.</span></div>
            <div><ShieldAlert size={16}/><span>Local CLI SSH tools use an explicit session-bound temporary grant. The agent's built-in local tools remain local; review its actions and approvals.</span></div></div>
        </section>
        <section className="agentSection"><h2>How it works</h2>
          <ol className="agentSteps"><li>Connect to a saved host in Terminal and choose Remote, Local or Auto.</li><li>Check CLI availability on both machines (normal CLI login is reused).</li><li>Launch the remote PTY or the local CLI with temporary SSH tools. No daemon is installed on the host.</li></ol>
          <button type="button" onClick={p.onTerminal}><TerminalSquare size={15}/> View SSH sessions</button>
        </section>
      </aside>
    </div>
  </div>;
}
