import {useEffect,useRef,useState} from "react";
import {Activity,Clipboard,RefreshCw,ShieldCheck} from "lucide-react";
import {desktopAvailable,listDockerContainers,listSftpDirectory,probeRemoteAgent} from "./backend";

type ResultState="checking"|"pass"|"warn"|"fail";
type CheckKey="ssh"|"sftp"|"docker"|"codex"|"claude"|"opencode";
type Check={key:CheckKey;title:string;state:ResultState;detail:string};
type Props={host:string;session:string;connected:boolean;vaultUnlocked:boolean;
  version:string;target:string};
const agentNames:{key:"codex"|"claude"|"opencode";title:string}[]=[
  {key:"codex",title:"Codex CLI"},
  {key:"claude",title:"Claude Code CLI"},
  {key:"opencode",title:"OpenCode CLI"}
];
const checkNames:{key:CheckKey;title:string}[]=[
  {key:"ssh",title:"Authenticated SSH terminal"},
  {key:"sftp",title:"Remote files / SFTP"},
  {key:"docker",title:"Docker access"},
  ...agentNames
];

// Error messages may include remote commands and environment paths. Do not
// echo raw stdout/stderr, remote file names or container names in a diagnostic
// report. The full error remains in its dedicated workspace, if needed.
function guidance(key:CheckKey,error:unknown):string{
  const message=String(error).toLowerCase();
  if(/permission denied|access.denied|forbidden|unauthorized/.test(message))
    return "Permission denied for this SSH account. Verify remote permissions and reconnect after changing group membership.";
  if(/not recognized|command not found|executable file not found|not found/.test(message))
    return key==="docker"
      ?"Docker CLI was not found for this SSH account. Check docker --version in Terminal."
      :"The requested service/CLI was not found for this SSH account.";
  if(/docker daemon|docker.sock|docker_engine|dockerdesktop|error during connect/.test(message))
    return "Remote Docker daemon or socket is unavailable. Check Docker service status and SSH account permissions.";
  if(/timed out|timeout/.test(message))
    return "The SSH operation timed out. Check latency, firewall and service responsiveness, then retry.";
  if(/ssh|connection closed|channel|disconnect/.test(message))
    return "SSH channel unavailable. Reconnect the host and retry.";
  if(key==="sftp")return "Cannot access the remote SFTP subsystem. Verify SSH server SFTP support and permissions.";
  if(key==="docker")return "Docker inventory command failed. Check docker ps -a using the same SSH account.";
  return "Probe failed; verify the remote SSH account environment and retry.";
}

export default function ConnectionDiagnostics({host,session,connected,vaultUnlocked,version,target}:Props){
  const [checks,setChecks]=useState<Check[]>([]);
  const [running,setRunning]=useState(false);
  const [notice,setNotice]=useState("");
  const requestRef=useRef(0);
  const context=useRef({host,session,connected,vaultUnlocked});
  context.current={host,session,connected,vaultUnlocked};
  useEffect(()=>{
    requestRef.current++;
    setChecks([]);
    setRunning(false);
    setNotice("");
  },[host,session,connected,vaultUnlocked]);

  const start=async()=>{
    if(!desktopAvailable()||!session||!connected||!vaultUnlocked||running)return;
    const ticket=++requestRef.current;
    const origin={host,session};
    const current=()=>requestRef.current===ticket&&
      context.current.host===origin.host&&context.current.session===origin.session&&
      context.current.connected&&context.current.vaultUnlocked;
    setNotice("");
    setRunning(true);
    setChecks(checkNames.map(check=>({
      ...check,state:check.key==="ssh"?"pass":"checking",
      detail:check.key==="ssh"?"Authenticated SSH session is active.":"Checking read-only remote capability…"
    })));
    const finish=(key:CheckKey,state:ResultState,detail:string)=>{
      if(current())setChecks(previous=>previous.map(item=>
        item.key===key?{...item,state,detail}:item));
    };
    const actions:Promise<void>[]=[
      (async()=>{
        try{
          const entries=await listSftpDirectory(origin.session,".");
          finish("sftp","pass","SFTP directory access works ("+entries.length+" entries). No file contents read.");
        }catch(error){finish("sftp","fail",guidance("sftp",error))}
      })(),
      (async()=>{
        try{
          const raw=await listDockerContainers(origin.session);
          const count=raw.split(/\r?\n/).filter(Boolean).length;
          finish("docker","pass","Docker inventory works ("+count+" containers). No containers were modified.");
        }catch(error){finish("docker","fail",guidance("docker",error))}
      })(),
      ...agentNames.map(({key})=>(async()=>{
        try{
          const result=await probeRemoteAgent(origin.session,key);
          if(result.installed){
            const versionLabel=result.version?.trim().slice(0,100)||"Version unavailable";
            finish(key,"pass","Remote terminal CLI available · "+versionLabel);
          }else if(result.desktopApp){
            finish(key,"warn","Windows desktop application detected, but no usable terminal CLI was found. Use RDP for the GUI, or install the CLI for SSH.");
          }else{
            finish(key,"warn","No usable CLI found for this SSH account. Verify its CLI installation and SSH PATH.");
          }
        }catch(error){finish(key,"fail",guidance(key,error))}
      })())
    ];
    await Promise.allSettled(actions);
    if(current())setRunning(false);
  };

  const copyReport=async()=>{
    const report={
      format:"passh7-remote-health",version:1,appVersion:version,target,
      // No hostname/IP, usernames, container identifiers, remote paths,
      // credentials or probe stdout are included in exported diagnostics.
      checks:checks.map(({key,state,detail})=>({component:key,status:state,
        summary:detail.startsWith("Remote terminal CLI available")?"Remote terminal CLI available":detail}))
    };
    try{
      await navigator.clipboard.writeText(JSON.stringify(report,null,2));
      setNotice("Sanitized diagnostic summary copied. No host address, file names, container names or credentials included.");
    }catch{setNotice("Could not copy diagnostics. Check clipboard permissions.")}
  };
  const available=desktopAvailable()&&connected&&!!session&&vaultUnlocked;
  return <div className="remoteHealth" aria-label="Remote host health check">
    <div className="remoteHealthHeader">
      <div><strong><Activity size={16}/> Remote host readiness</strong>
        <p className="prefInfo">Checks the selected authenticated SSH account without changing files, containers or services. Probes do not launch coding agents.</p></div>
      <button type="button" disabled={!available||running} onClick={()=>void start()}>
        <RefreshCw size={15} className={running?"treeLoading":""}/>
        {running?"Checking…":"Run host checks"}
      </button>
    </div>
    <p className="prefInfo">Selected host: <strong>{host||"None"}</strong> · SSH: {connected?"Connected":"Disconnected"} · Vault: {vaultUnlocked?"Unlocked":"Locked"}</p>
    {!available&&<p className="workspaceNotice" role="status">Unlock Vault and connect to this host to run read-only SSH, Docker, SFTP and agent checks.</p>}
    <div className="remoteHealthChecks">
      {(checks.length?checks:checkNames.map(check=>({...check,state:"warn" as const,detail:"Not checked yet"}))).map(check=>
        <div key={check.key} className="remoteHealthRow">
          <span className={"remoteHealthStatus "+check.state} aria-hidden="true">
            {check.state==="pass"?"✓":check.state==="checking"?"…":check.state==="fail"?"!":"–"}
          </span>
          <span><strong>{check.title}</strong><small>{check.detail}</small></span>
        </div>
      )}
    </div>
    <div className="settingsActions">
      <button type="button" disabled={!checks.length||running} onClick={()=>void copyReport()}><Clipboard size={14}/> Copy safe health summary</button>
    </div>
    {notice&&<p role="status" className="workspaceNotice">{notice}</p>}
    {checks.some(check=>check.state==="fail")&&!running&&<p className="prefInfo"><ShieldCheck size={13}/> These are account-specific diagnostics. Failed checks do not imply another server or local Docker instance was tested.</p>}
  </div>;
}
