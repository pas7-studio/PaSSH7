import {useCallback,useRef,useState,type ReactNode} from "react";
import {Activity, Bot, CheckCircle2, Clipboard, ChevronDown, ExternalLink, LockKeyhole, Monitor, Maximize2, Minimize2, Play, RefreshCw, Server, ShieldAlert, TerminalSquare} from "lucide-react";
import {AGENTS,type AgentKind} from "./integrations";
import type {RemoteAgentAvailability,LocalAgentAvailability,LocalAgentConnection} from "./backend";
import {WorkspaceHeader,WorkspaceStatus} from "./WorkspaceChrome";

export type AgentProbeState=RemoteAgentAvailability&{session:string};
type Props={
  host:string;address:string;username:string;port:number;route:string;
  sessionId:string;sessions:{id:string;alias:string}[];allSessions:{id:string;alias:string}[];vaultUnlocked:boolean;
  agent:AgentKind;onAgent:(kind:AgentKind)=>void;
  availability:Partial<Record<AgentKind,AgentProbeState>>;
  checking:boolean;error:string;status:string;context:string;launching:boolean;
  mode:"auto"|"remote"|"local";onMode:(mode:"auto"|"remote"|"local")=>void;
  localAvailability:Partial<Record<AgentKind,LocalAgentAvailability>>;localChecking:boolean;
  localConnections:LocalAgentConnection[];localRevoking:string;onRevokeLocal:(id:string)=>void;
  onRestoreLocal:(id:string)=>void;
  onCheck:()=>void;onLaunch:()=>void;onTerminal:()=>void;onSession:(id:string)=>void;
  onPrepareRdp:()=>void;
  liveTerminal?:boolean;onTerminalDock?:(node:HTMLDivElement|null)=>void;
  terminalPreview?:ReactNode;
};
export default function AgentWorkspace(p:Props){
  const [copyFeedback,setCopyFeedback]=useState("");
  const [expandedConsole,setExpandedConsole]=useState(false);
  const [showTools,setShowTools]=useState(false);
  const [showContext,setShowContext]=useState(false);
  const [briefFeedback,setBriefFeedback]=useState("");
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
  const copyRemoteInstructions=async()=>{
    const instructions=[
      "I am working on the SSH server selected in PaSSH7: "+p.host+".",
      "Use ONLY the passh7 MCP tools remote_exec, remote_list, remote_read and remote_write for operations on this server.",
      "Your built-in shell and file tools run on my LOCAL computer, not on that SSH host.",
      "Do not start another ssh client or request SSH credentials; the PaSSH7 MCP connection already uses my authenticated session.",
      "Confirm destructive operations first. If the MCP bridge is unavailable, report the problem rather than silently acting locally."
    ].join("\n");
    try{
      await navigator.clipboard.writeText(instructions);
      setBriefFeedback("Agent instructions copied");
    }catch(error){setBriefFeedback("Clipboard unavailable: "+String(error))}
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
        <div><small>SSH TARGET</small><h2>{p.host}</h2>
          <p>{connected?`${p.username}@${p.address}:${p.port}`:"No authenticated SSH session selected"}</p>
        </div>
      </div>
      <div className="agentHeroMeta">
        <WorkspaceStatus kind={connected?"connected":"offline"}>{connected?"SSH connected":"Disconnected"}</WorkspaceStatus>
        <span><Activity size={14}/>{p.route}</span>
      </div>
      <div className="agentHeroActions">
        <label>Connected SSH session
          <select aria-label="SSH target for AI assistant" value={p.sessionId}
            disabled={!p.allSessions.length}
            onChange={event=>p.onSession(event.target.value)}>
            {!p.sessionId&&<option value="">Choose a session</option>}
            {p.allSessions.map((session,index)=><option key={session.id} value={session.id}>{session.alias} · {index+1}</option>)}
          </select>
        </label>
        <button type="button" onClick={p.onTerminal}><TerminalSquare size={15}/> Terminal</button>
      </div>
    </section>
    {!connected&&<div className="agentConnectNotice" role="status">
      <LockKeyhole size={20}/><div><strong>{!p.vaultUnlocked?"Unlock the Vault to continue":"An SSH connection is required"}</strong>
        <p>{!p.vaultUnlocked?"Unlock your encrypted Vault, then connect to a saved host.":"Open Terminal and connect to a host. Your selected CLI will use that existing SSH connection."}</p>
      </div><button type="button" onClick={p.onTerminal}>Open Terminal</button>
    </div>}
    <section className="agentQuickLaunch" aria-label="Agent launcher">
      <div className="agentQuickLaunchHead">
        <div><span className="agentEyebrow">ASSISTANT WORKSPACE</span>
          <h2>Run an agent on <strong>{p.host}</strong></h2>
          <p>{p.mode==="local"?"The CLI opens in a separate local console; remote tools use PaSSH7 SSH.":p.mode==="remote"?"The CLI runs in the embedded SSH terminal with the remote account's permissions.":"Remote CLI first; if unavailable, launch the installed local CLI with SSH tools."}</p>
        </div>
        <div className="agentQuickMeta"><span>REMOTE · {cliStatus(probe)}</span>
          <span>LOCAL · {p.localAvailability[p.agent]?.installed?"CLI detected":p.localAvailability[p.agent]?"Unavailable":"Not checked"}</span>
        </div>
      </div>
      <div className="agentQuickControls">
        <label className="agentQuickSelect">Coding assistant
          <select value={p.agent} onChange={event=>p.onAgent(event.target.value as AgentKind)} aria-label="Coding assistant">
            {AGENTS.map(entry=><option key={entry.kind} value={entry.kind}>{entry.name}</option>)}
          </select>
        </label>
        <div className="agentQuickMode" role="group" aria-label="Run location">
          {([
            ["auto","Auto"],["remote","Remote SSH"],["local","Local + SSH"]
          ] as const).map(([value,label])=><button key={value} type="button" aria-pressed={p.mode===value}
            className={p.mode===value?"active":""} onClick={()=>p.onMode(value)}>{label}</button>)}
        </div>
        <button type="button" className="workspacePrimary agentRunButton"
          disabled={!connected||p.launching||(p.mode==="remote"&&probe?.platform==="windows"&&!probe.installed)}
          onClick={p.onLaunch}><Play size={16}/>
          {p.launching?"Launching…":p.mode==="local"?"Open local "+selected.name:p.mode==="remote"?"Run "+selected.name+" over SSH":"Launch "+selected.name}
        </button>
        <button type="button" className="agentCheckButton" disabled={!connected||p.checking||p.localChecking}
          onClick={p.onCheck}><RefreshCw size={15} className={p.checking||p.localChecking?"agentSpin":""}/>{p.checking||p.localChecking?"Checking…":"Check CLIs"}</button>
      </div>
      <div className="agentQuickFooter">
        <span><ShieldAlert size={14}/> Existing CLI login only. Remote commands use your SSH account permissions, not a sandbox.</span>
        <button type="button" aria-expanded={showTools} onClick={()=>setShowTools(open=>!open)}>
          {showTools?"Hide setup & diagnostics":"Setup & diagnostics"} <ChevronDown size={14}/>
        </button>
      </div>
      {p.status&&<p role="status" className="workspaceNotice">{p.status}</p>}
      {p.error&&<div className="workspaceError" role="alert">{p.error}</div>}
    </section>
        {showTools&&<section className="agentSection agentDiagnosticSection" aria-label="CLI setup and diagnostics">
          <div className="agentSectionHead"><div><h2>CLI availability & setup</h2>
            <p>A successful version check means the executable works; the agent confirms sign-in when launched.</p></div>
            <button type="button" disabled={!connected||p.checking||p.localChecking} onClick={p.onCheck}><RefreshCw size={15}/> Check both machines</button>
          </div>
          <div className="agentCards">
            {AGENTS.map(entry=>{
              const remote=p.availability[entry.kind]?.session===p.sessionId?p.availability[entry.kind]:null;
              const local=p.localAvailability[entry.kind];
              return <button key={entry.kind} type="button" className={"agentCard "+entry.kind+(p.agent===entry.kind?" active":"")} aria-pressed={p.agent===entry.kind} onClick={()=>p.onAgent(entry.kind)}>
                <span className={"agentMark "+entry.kind}><Bot size={21}/></span>
                <strong>{entry.name}</strong>
                <span className="agentDetection"><WorkspaceStatus kind={remote?.installed?"connected":remote?"warning":"offline"}>Remote: {cliStatus(remote)}</WorkspaceStatus></span>
                <span className="agentDetection"><WorkspaceStatus kind={local?.installed?"connected":local?"warning":"offline"}>Local: {local?.installed?"Detected":local?"Unavailable":"Not checked"}</WorkspaceStatus></span>
              </button>
            })}
          </div>
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
        </section>}
    {connected&&p.mode==="local"&&<div className="agentLocalBanner">
      <div><Monitor size={20}/><div><strong>Local assistant runs in a separate window</strong>
        <p>The SSH console below stays available for direct work. Give the assistant remote tasks through its own CLI and the four PaSSH7 MCP tools.</p></div></div>
      <button type="button" onClick={()=>void copyRemoteInstructions()}><Clipboard size={14}/>{briefFeedback||"Copy instructions"}</button>
    </div>}
    <div className="agentWorkspaceGrid">
      <div className="agentWorkspaceMain">
        {(p.liveTerminal||p.terminalPreview)&&connected&&<section className="agentSection agentEmbeddedTerminal" aria-label="Live agent SSH terminal">
          <div className="agentSectionHead"><div><h2><TerminalSquare size={17}/> Live SSH console</h2>
            <p>{p.mode==="local"?"This is the SSH console, not the local agent window. Your local assistant opens in its own Windows console.":"This is your authenticated SSH PTY. Remote agents render and accept input right here."}</p></div>
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
          <p className="agentHint">{p.mode==="local"?"Use the separate local CLI window for the assistant. The SSH terminal remains available for direct commands.":"Click Focus console to type in the live SSH session; you can switch targets from the toolbar above."}</p>
        </section>}

        <section className="agentSection agentContextSection">
          <div className="agentSectionHead"><div><h2>SSH context</h2><p>Review the non-secret information PaSSH7 displays. This preview is not automatically sent to any agent.</p></div>
            <button type="button" onClick={()=>setShowContext(open=>!open)} aria-expanded={showContext}>{showContext?"Hide":"Show"} context <ChevronDown size={14}/></button></div>
          {showContext&&<><pre className="agentContextPreview">{p.context}</pre><button type="button" onClick={()=>void copyContext()}><Clipboard size={14}/> Copy context</button></>}
          {copyFeedback&&<p role="status" className="agentHint">{copyFeedback}</p>}
        </section>

      </div>
      <aside className="agentWorkspaceSide">
        <section className="agentSection" aria-label="Local CLI SSH grants">
          <div className="agentSectionHead"><div><h2>Local CLI SSH access</h2>
            <p>Grants belong to a saved SSH host, not a provider login. Expired or disconnected grants can be explicitly restored in the same running CLI window.</p></div></div>
          {!p.localConnections.length?<p className="agentHint">No recoverable local CLI grant. Launch a local assistant above to issue a temporary SSH grant. If access was explicitly revoked or PaSSH7 restarted, a new CLI launch is required.</p>:
            <div className="agentGrantRows">{p.localConnections.map(item=><div className="agentLaunchRow" key={item.id}>
              <div className="agentLaunchCommand">
                <span>{item.host} · {item.status==="active"?"SSH TOOLS ACTIVE":item.status==="expired"?"GRANT EXPIRED":"SSH DISCONNECTED"}</span>
                <code>{AGENTS.find(a=>a.kind===item.agent)?.name??item.agent}</code>
                <small>Authorized {item.ageSeconds<60?"less than a minute":Math.floor(item.ageSeconds/60)+" min"} ago.
                  {item.status==="active"?" Original SSH host only.":" Remote operations are blocked."}
                </small>
              </div>
              {p.sessionId&&p.allSessions.some(session=>session.id===p.sessionId&&session.alias===item.host)?
                <button type="button" disabled={Boolean(p.localRevoking)} onClick={()=>p.onRestoreLocal(item.id)}>
                  <RefreshCw size={15}/>{p.localRevoking===item.id?"Updating…":item.status==="active"?"Extend access":"Restore SSH access"}
                </button>:
                p.allSessions.some(session=>session.alias===item.host)?
                  <button type="button" disabled={Boolean(p.localRevoking)} onClick={()=>{
                    const target=p.allSessions.find(session=>session.alias===item.host);
                    if(target)p.onSession(target.id);
                  }}><Server size={15}/> Select {item.host} SSH</button>:
                  <small className="agentGrantNoSession">Reconnect {item.host} in Terminal to restore access.</small>}
              <button type="button" disabled={Boolean(p.localRevoking)} onClick={()=>p.onRevokeLocal(item.id)}>
                <LockKeyhole size={15}/>{p.localRevoking===item.id?"Updating…":"Revoke SSH access"}
              </button>
            </div>)}</div>}
          {p.localConnections.length>0&&<p className="agentHint">Restore requires confirmation and a live SSH session on the original host; explicit Revoke permanently invalidates the token. Closing a launcher does not revoke a grant. Remote commands already running cannot be undone.</p>}
        </section>
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
