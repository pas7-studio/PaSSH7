import {useCallback} from "react";
import TerminalView from "./TerminalView";
import {useEffect,useMemo,useState} from "react";
import {addHost,desktopAvailable,getHosts,initializeVault,unlockVault as unlockNativeVault,lockVault as lockNativeVault,vaultExists,vaultStatus,getIdentities,importIdentity,removeHost,removeIdentity,getBuildInfo,type BuildInfo,probeSshHost,type SshProbeResult,authenticateSshHost,openSshSession,closeSshSession,writeSshSession,generateEd25519,getPublicIdentity,type GeneratedPublicKey,saveHostCredentials,forgetHostCredentials,listDockerContainers,discoverSshHostKey,pinSshHostKey,listSftpDirectory,type SftpEntry,startLocalForward,stopLocalForward,readSftpText} from "./backend";
import {AGENTS,validateHostDraft,type AgentKind,type HostDraft} from "./integrations";
import {Activity, Bot, ChevronDown, CircleHelp, Command, Container, FileText, FolderClosed, KeyRound, LockKeyhole, Monitor, Plus, Search, Server, Settings2, ShieldCheck, TerminalSquare, Trash2, X} from "lucide-react";

type Panel = "files" | "docker" | "agent" | "ports";
type Host = {id:string; label:string; address:string; user:string; port:number; group:string; fingerprint:boolean;hasSavedCredentials?:boolean;savedAuthMode?:string|null};
const DEMO_HOSTS:Host[] = [
  {id:"dev",label:"Development",address:"dev.example.invalid",user:"ubuntu",port:22,group:"Development",fingerprint:true},
  {id:"staging",label:"Staging",address:"staging.example.invalid",user:"deploy",port:22,group:"Development",fingerprint:false},
  {id:"prod",label:"Production",address:"prod.example.invalid",user:"ops",port:22,group:"Production",fingerprint:true}
];
const tabs: {id:Panel;label:string; Icon:typeof Bot}[]=[
  {id:"files",label:"Files",Icon:FolderClosed},{id:"docker",label:"Docker",Icon:Container},
  {id:"ports",label:"Ports",Icon:Activity},{id:"agent",label:"AI Agent",Icon:Bot}
];
export default function App(){
  const [selected,setSelected]=useState("dev");
  const [sshTabs,setSshTabs]=useState<{id:string;alias:string}[]>([]);
  const [activeSsh,setActiveSsh]=useState("");
  const [sshBusy,setSshBusy]=useState(false);
  const [loginOpen,setLoginOpen]=useState(false);
  const [tofuCandidate,setTofuCandidate]=useState<{alias:string;fingerprint:string}|null>(null);
  const [tofuBusy,setTofuBusy]=useState(false);
  const [tofuError,setTofuError]=useState("");
  const [loginPassword,setLoginPassword]=useState("");
  const [rememberCredentials,setRememberCredentials]=useState(false);
  const [useSavedCredentials,setUseSavedCredentials]=useState(false);
  const [credentialWarning,setCredentialWarning]=useState("");
  const [accessOpen,setAccessOpen]=useState(false);
  const [accessPublicKey,setAccessPublicKey]=useState("");
  const [loginMode,setLoginMode]=useState<"key"|"password"|"key-password">("key-password");
  useEffect(()=>{if(sshTabs.length&&!sshTabs.some(t=>t.id===activeSsh)){setActiveSsh(sshTabs[0].id)}},[sshTabs,activeSsh]);
  const [tunnels,setTunnels]=useState<{session:string;localPort:number;targetHost:string;remotePort:number}[]>([]);
  const onSessionClosed=useCallback((id:string)=>{setSshTabs(t=>t.filter(x=>x.id!==id));setTunnels(t=>t.filter(x=>x.session!==id));setActiveSsh(current=>current===id?"":current)},[]);
  const [hosts,setHosts]=useState<Host[]>(desktopAvailable()?[]:DEMO_HOSTS);
  const [vaultUnlocked,setVaultUnlocked]=useState(false);
  useEffect(()=>{if(!vaultUnlocked){setSshTabs([]);setTunnels([]);setActiveSsh("")}},[vaultUnlocked]);

  const [probeResult,setProbeResult]=useState<{alias:string;data:SshProbeResult}|null>(null);
  const [probeError,setProbeError]=useState("");
  const [probeBusy,setProbeBusy]=useState(false);
  const [authBusy,setAuthBusy]=useState(false);
  const [authResult,setAuthResult]=useState("");
  const [deleteTarget,setDeleteTarget]=useState<{kind:"host"|"identity";alias:string}|null>(null);
  const [vaultPassword,setVaultPassword]=useState("");
  const [vaultDialog,setVaultDialog]=useState(false);
  const [vaultPresent,setVaultPresent]=useState(false);
  const [identities,setIdentities]=useState<string[]>([]);
  const [keyDialog,setKeyDialog]=useState(false);
  const [keyAlias,setKeyAlias]=useState("");
  const windowsAdminKeyScript=(publicKey:string)=>{
    if(!/^ssh-ed25519 [A-Za-z0-9+/=]+(?: [A-Za-z0-9_.-]+)?$/.test(publicKey))throw new Error("Unexpected SSH public key format");
    return [
      "# Run in elevated PowerShell on the Windows SSH server.",
      "$file = Join-Path $env:ProgramData 'ssh\\administrators_authorized_keys'",
      "$key = '"+publicKey+"'",
      "if (-not (Test-Path -LiteralPath $file)) { New-Item -ItemType File -Path $file -Force | Out-Null }",
      "$existing = @(Get-Content -LiteralPath $file -ErrorAction SilentlyContinue)",
      "if ($existing -notcontains $key) { Add-Content -LiteralPath $file -Value $key -Encoding ascii }",
      "& icacls.exe $file /inheritance:r /grant:r '*S-1-5-32-544:F' '*S-1-5-18:F'",
      "# Keep the existing password session open, verify key authentication in a NEW session first."
    ].join("\n");
  };
  const [generatedKey,setGeneratedKey]=useState<GeneratedPublicKey|null>(null);
  const [keyWorking,setKeyWorking]=useState(false);
  const [keyPem,setKeyPem]=useState("");
  const [importKeyPassphrase,setImportKeyPassphrase]=useState("");
  const [loginKeyPassphrase,setLoginKeyPassphrase]=useState("");
  useEffect(()=>{if(desktopAvailable()){void vaultExists().then(setVaultPresent).catch(()=>setVaultPresent(false))}},[]);
  const lockVault=async()=>{await lockNativeVault();setVaultPassword("");setVaultUnlocked(false);setHosts([]);setIdentities([])};
  const unlockVault=async()=>{try{if(!vaultPresent){await initializeVault(vaultPassword);setVaultPresent(true)}await unlockNativeVault(vaultPassword);setVaultPassword("");const saved=await getHosts();setIdentities(await getIdentities());setHosts(saved.map((h,i)=>({id:h.alias,label:h.alias,address:h.hostname,user:h.username,port:h.port,group:"My hosts",fingerprint:h.hostKeyPinned,hasSavedCredentials:h.hasSavedCredentials,savedAuthMode:h.savedAuthMode})));setSelected(saved[0]?.alias||"");setVaultUnlocked(true);setVaultDialog(false);setError("")}catch(e){setError(String(e))}};
  useEffect(()=>{if(!desktopAvailable()||!vaultUnlocked)return;const id=window.setInterval(()=>{void vaultStatus().then(ok=>{if(!ok){setVaultUnlocked(false);setHosts([]);setSelected("");}}).catch(()=>{})},30000);return ()=>window.clearInterval(id)},[vaultUnlocked]);
  const [addOpen,setAddOpen]=useState(false);
  const [step,setStep]=useState(0);
  const [draft,setDraft]=useState<HostDraft>({label:"",hostname:"",port:22,username:"",auth:"key",identity:"",fingerprint:""});
  const [sftpPath,setSftpPath]=useState(".");
  const [sftpEntries,setSftpEntries]=useState<{session:string;path:string;items:SftpEntry[]}|null>(null);
  const [sftpBusy,setSftpBusy]=useState(false);
  const [sftpError,setSftpError]=useState("");
  const [sftpPreview,setSftpPreview]=useState<{session:string;path:string;body:string}|null>(null);
  const [sftpPreviewBusy,setSftpPreviewBusy]=useState(false);
  const readSftpPreview=async(path:string)=>{
    const session=sshTabs.find(t=>t.id===activeSsh&&t.alias===selected);
    if(!session){setSftpError("Select an active SSH session first.");return}
    setSftpPreviewBusy(true);setSftpError("");
    try{setSftpPreview({session:session.id,path,body:await readSftpText(session.id,path)})}
    catch(e){setSftpError(String(e))}
    finally{setSftpPreviewBusy(false)}
  };

  const browseSftp=async(path:string)=>{
    const session=sshTabs.find(t=>t.id===activeSsh && t.alias===selected);
    if(!session){setSftpError("Connect to the selected host first.");return}
    setSftpBusy(true);setSftpError("");
    try{const items=await listSftpDirectory(session.id,path);setSftpEntries({session:session.id,path,items});setSftpPath(path)}
    catch(e){setSftpError(String(e))}
    finally{setSftpBusy(false)}
  };
  const [tunnelLocalPort,setTunnelLocalPort]=useState(18080);
  const [tunnelRemoteHost,setTunnelRemoteHost]=useState("127.0.0.1");
  const [tunnelRemotePort,setTunnelRemotePort]=useState(8080);
  const [tunnelBusy,setTunnelBusy]=useState(false);
  const [tunnelError,setTunnelError]=useState("");

  const addTunnel=async()=>{
    const session=sshTabs.find(t=>t.id===activeSsh&&t.alias===selected);
    if(!session){setTunnelError("Select an active SSH session for this host.");return}
    setTunnelBusy(true);setTunnelError("");
    try {
      await startLocalForward(session.id,tunnelLocalPort,tunnelRemoteHost,tunnelRemotePort);
      setTunnels(v=>[...v,{session:session.id,localPort:tunnelLocalPort,targetHost:tunnelRemoteHost,remotePort:tunnelRemotePort}]);
    }catch(e){setTunnelError(String(e))}
    finally{setTunnelBusy(false)}
  };
  const removeTunnel=async(session:string,localPort:number)=>{
    setTunnelBusy(true);setTunnelError("");
    try{await stopLocalForward(session,localPort);setTunnels(v=>v.filter(t=>!(t.session===session&&t.localPort===localPort)))}
    catch(e){setTunnelError(String(e))}
    finally{setTunnelBusy(false)}
  };
  const [agent,setAgent]=useState<AgentKind>("codex");
  const [agentStatus,setAgentStatus]=useState("");
  const launchRemoteAgent=async()=>{
    const session=sshTabs.find(t=>t.id===activeSsh&&t.alias===selected);
    if(!session){setAgentStatus("Connect to this host first.");return}
    const cli:Record<AgentKind,string>={codex:"codex",claude:"claude",opencode:"opencode"};
    const name=AGENTS.find(a=>a.kind===agent)?.name||agent;
    if(!window.confirm("Run "+name+" on "+session.alias+" in the existing SSH terminal? This CLI runs with your full SSH account privileges, NOT in a PaSSH7 sandbox. It must already be installed and configured on the remote host."))return;
    try{
      await writeSshSession(session.id,cli[agent]+"\r");
      setAgentStatus("Launch command sent to the SSH terminal. Check terminal output to confirm "+name+" started.");
    }catch(e){setAgentStatus("Could not launch agent: "+String(e))}
  };
  const [error,setError]=useState("");
  const [query,setQuery]=useState("");
  const [panel,setPanel]=useState<Panel>("agent");
  const [dockerInventory,setDockerInventory]=useState<{session:string;items:Array<{ID?:string;Names?:string;Image?:string;State?:string;Status?:string;Ports?:string}>}|null>(null);
  const [dockerBusy,setDockerBusy]=useState(false);
  const [dockerError,setDockerError]=useState("");
  const refreshDocker=async()=>{
    if(!activeSsh)return;
    const id=activeSsh;setDockerBusy(true);setDockerError("");
    try{
      const raw=await listDockerContainers(id);
      const items=raw.split(/\r?\n/).map(line=>line.trim()).filter(Boolean).map(line=>JSON.parse(line) as {ID?:string;Names?:string;Image?:string;State?:string;Status?:string;Ports?:string});
      setDockerInventory({session:id,items});
    }catch(e){setDockerError(String(e))}
    finally{setDockerBusy(false)}
  };
  const confirmRemove=async()=>{
    if(!deleteTarget || !desktopAvailable() || !vaultUnlocked)return;
    try{
      if(deleteTarget.kind==="host"){
        await removeHost(deleteTarget.alias);
        const saved=await getHosts();
        setHosts(saved.map(h=>({id:h.alias,label:h.alias,address:h.hostname,user:h.username,port:h.port,group:"My hosts",fingerprint:h.hostKeyPinned,hasSavedCredentials:h.hasSavedCredentials,savedAuthMode:h.savedAuthMode})));
        setSelected(current=>current===deleteTarget.alias?(saved[0]?.alias||""):current);
      } else {
        await removeIdentity(deleteTarget.alias);
        setIdentities(await getIdentities());
      }
      setDeleteTarget(null);setError("");
    }catch(e){setError(String(e))}
  };
  const [sidebar,setSidebar]=useState(true);
  const [commandOpen,setCommandOpen]=useState(false);
  const [showSettings,setShowSettings]=useState(false);
  const [theme,setTheme]=useState<"dark"|"light">("dark");
  const [buildInfo,setBuildInfo]=useState<BuildInfo|null>(null);
  useEffect(()=>{void getBuildInfo().then(setBuildInfo).catch(()=>setBuildInfo(null))},[]);
  useEffect(()=>{setProbeResult(null);setProbeError("");setAuthResult("");setTofuCandidate(null)},[selected,vaultUnlocked]);
  const probeActive=async()=>{if(!desktopAvailable()||!vaultUnlocked||!selected)return;setProbeBusy(true);setProbeError("");setProbeResult(null);try{const data=await probeSshHost(selected);setProbeResult({alias:selected,data})}catch(e){setProbeError(String(e))}finally{setProbeBusy(false)}};
  const authenticateActive=async()=>{if(!desktopAvailable()||!vaultUnlocked||!selected)return;setAuthBusy(true);setAuthResult("");setProbeError("");try{const result=await authenticateSshHost(selected);setAuthResult(`Verified SSH login: ${result.username} @ ${result.hostAlias}. Connection closed; PTY is not implemented yet.`)}catch(e){setProbeError(String(e))}finally{setAuthBusy(false)}};
  const connectionHelp=(message:string):{title:string;checks:string[]}=>{
    const raw=message.replace(/^Error:\s*/, "");
    const code=raw.match(/SSH_[A-Z_]+/)?.[0] || "";
    const known:Record<string,{title:string;checks:string[]}>={
      SSH_PUBLICKEY_REJECTED:{title:"Server rejected the offered SSH public key",checks:["Verify the selected vault identity and remote username.","On Windows, an administrator normally uses C:\\ProgramData\\ssh\\administrators_authorized_keys; other users normally use their own .ssh/authorized_keys.","Check the server's SSHD logs and file permissions. Only the server can explain the exact rejection."]},
      SSH_KEY_UNLOCK:{title:"PaSSH7 could not unlock the private key",checks:["Enter the private-key passphrase (different from your Windows password).","Confirm that the selected identity contains the intended private key."]},
      SSH_PARTIAL_AUTH:{title:"Key accepted — another sign-in factor is required",checks:["Choose SSH key + Windows password.","Enter the key passphrase, if encrypted, and the Windows account password in their separate fields."]},
      SSH_SECOND_FACTOR_REQUIRED:{title:"Key accepted — Windows password needed",checks:["Select SSH key + Windows password and enter the account password."]},
      SSH_SECOND_FACTOR_REJECTED:{title:"Key accepted — account password rejected",checks:["Verify the Windows account password for the selected username.","Check Windows account restrictions and SSHD authentication logs if the password is correct."]},
      SSH_SECOND_FACTOR_ERROR:{title:"Key accepted — password step failed",checks:["Check the account password and whether the SSH server disconnected during the second factor."]},
      SSH_PASSWORD_REJECTED:{title:"Password-only authentication was rejected",checks:["Verify the username and password.","If SSHD requires publickey,password, select SSH key + Windows password instead."]},
      SSH_PASSWORD_REQUIRED:{title:"Windows password is required",checks:["Fill in the Windows account password before connecting."]},
      SSH_PASSWORD_ERROR:{title:"Password authentication could not complete",checks:["Check whether password authentication is permitted on the server.","Inspect server logs for the exact cause."]},
      SSH_KEY_NEGOTIATION:{title:"SSH key authentication negotiation failed",checks:["Confirm the server supports the selected key algorithm.","Check SSHD algorithm policy and logs."]},
      SSH_AUTH_ERROR:{title:"SSH authentication was interrupted",checks:["Retry once and inspect SSHD logs if the problem repeats."]},
      SSH_PTY_DENIED:{title:"Login succeeded, but interactive terminal was denied",checks:["Check server PermitTTY and account policies."]},
      SSH_SHELL_DENIED:{title:"Login succeeded, but shell startup was denied",checks:["Check the server's default shell and account permissions."]},
      SSH_CHANNEL_ERROR:{title:"Login succeeded, but a session could not open",checks:["Check SSH server session limits and logs."]},
    };
    if(known[code])return known[code];
    if(/host key|fingerprint|pinned/i.test(raw))return {title:"Server identity verification failed",checks:["Verify the server fingerprint using a trusted source.","Do not override a changed or mismatched fingerprint without investigating."]};
    if(/connection refused/i.test(raw))return {title:"SSH port refused the connection",checks:["Check hostname, port, SSH service status and firewall rules."]};
    if(/timeout|timed out/i.test(raw))return {title:"SSH connection timed out",checks:["Check the host IP, SSH port, routing, firewall and VPN."]};
    if(/dns|resolve|name or service/i.test(raw))return {title:"Could not resolve SSH hostname",checks:["Check the hostname and DNS configuration."]};
    return {title:"Connection could not be completed",checks:["Read the technical error below; it may identify the failed stage.","If the server can be reached, inspect SSHD logs. A client cannot always determine a server-side rejection reason."]};
  };
  const connectInteractive=async(accountPassword?:string)=>{
    if(!desktopAvailable()||!vaultUnlocked||!selected||sshBusy)return;
    setSshBusy(true);setProbeError("");setCredentialWarning("");
    try{
      const opened=await openSshSession(selected,100,30,accountPassword,loginMode,loginKeyPassphrase,useSavedCredentials);
      setSshTabs(t=>[...t,opened]);setActiveSsh(opened.id);setLoginOpen(false);
      if(rememberCredentials&&(!useSavedCredentials||!!accountPassword||!!loginKeyPassphrase)){
        try{
          await saveHostCredentials(selected,loginMode,accountPassword||"",loginKeyPassphrase);
          const saved=await getHosts();
          setHosts(saved.map(h=>({id:h.alias,label:h.alias,address:h.hostname,user:h.username,port:h.port,group:"My hosts",fingerprint:h.hostKeyPinned,hasSavedCredentials:h.hasSavedCredentials,savedAuthMode:h.savedAuthMode})));
        }catch(e){setCredentialWarning("Connected, but could not save credentials: "+String(e))}
      }
    }catch(e){setProbeError(String(e))}
    finally{setLoginPassword("");setLoginKeyPassphrase("");setSshBusy(false)}
  };
  const runWindowsAdminScript=async(script:string)=>{
    const session=sshTabs.find(t=>t.id===activeSsh);
    if(!session)throw new Error("Open and select a Windows SSH session first");
    // Encode UTF-16LE as required by PowerShell -EncodedCommand. Avoid shell quoting.
    const bytes=new Uint8Array(script.length*2);
    for(let i=0;i<script.length;i++){const ch=script.charCodeAt(i);bytes[i*2]=ch&255;bytes[i*2+1]=ch>>8}
    let binary="";for(const b of bytes)binary+=String.fromCharCode(b);
    await writeSshSession(session.id,"powershell.exe -NoProfile -EncodedCommand "+btoa(binary)+"\\r");
  };
  const revokeWindowsKeyScript=(key:string)=>{
    if(!/^ssh-ed25519 [A-Za-z0-9+/=]+(?: [A-Za-z0-9_.-]+)?$/.test(key))throw new Error("Enter a complete ssh-ed25519 public key");
    return [
      "$file = Join-Path $env:ProgramData 'ssh\\administrators_authorized_keys'",
      "$key = '"+key+"'",
      "if (-not (Test-Path -LiteralPath $file)) { throw 'authorized_keys file not found' }",
      "$all = @(Get-Content -LiteralPath $file)",
      "$matches = @($all | Where-Object { $_.Trim() -eq $key })",
      "if ($matches.Count -eq 0) { throw 'Key not found. No change made.' }",
      "$remaining = @($all | Where-Object { $_.Trim() -ne $key })",
      "$active = @($remaining | Where-Object { $_ -match '^(ssh-ed25519|ssh-rsa|ecdsa-sha2-)' })",
      "if ($active.Count -eq 0) { throw 'Refusing to remove the last authorized key' }",
      "$backup = $file + '.passh7-' + (Get-Date -Format 'yyyyMMddHHmmss') + '.bak'",
      "Copy-Item -LiteralPath $file -Destination $backup -ErrorAction Stop",
      "Set-Content -LiteralPath $file -Value $remaining -Encoding ascii -ErrorAction Stop",
      "& icacls.exe $file /inheritance:r /grant:r '*S-1-5-32-544:F' '*S-1-5-18:F'",
      "Write-Output ('Removed specified key. Backup: ' + $backup)"
    ].join("\n");
  };
  const runWindowsAccessAction=async(kind:"users"|"keys"|"add"|"remove")=>{
    try {
      const session=sshTabs.find(t=>t.id===activeSsh);
      if(!session)throw new Error("Select an active Windows SSH session");
      let script="";
      if(kind==="users")script="Get-LocalUser | Select-Object Name,Enabled,LastLogon | Format-Table -AutoSize";
      if(kind==="keys")script="$f=Join-Path $env:ProgramData 'ssh\\administrators_authorized_keys'; if(Test-Path $f){Get-Content -LiteralPath $f}else{Write-Output 'No administrator keys file found'}";
      if(kind==="add"){
        if(!window.confirm("Append this PUBLIC key to administrators_authorized_keys on "+session.alias+"? Existing keys remain unchanged."))return;
        script=windowsAdminKeyScript(accessPublicKey.trim());
      }
      if(kind==="remove"){
        if(!window.confirm("REVOKE exactly this administrator public key from "+session.alias+"? An authorized_keys backup will be created, but you can still lose SSH access. Ensure another administrator connection exists."))return;
        script=revokeWindowsKeyScript(accessPublicKey.trim());
      }
      await runWindowsAdminScript(script);
      setAccessOpen(false);setError("");
    }catch(e){setError(String(e))}
  };
  const changeWindowsPassword=async()=>{
    const session=sshTabs.find(t=>t.id===activeSsh);
    const profile=hosts.find(h=>h.id===session?.alias);
    if(!session||!profile){setProbeError("Select an active SSH session first");return}
    if(!/^[A-Za-z0-9_.-]{1,32}$/.test(profile.user)){
      setProbeError("Password tool requires a simple local Windows username");return
    }
    if(!window.confirm("Start Windows password change for "+profile.user+"? The server will prompt in the SSH terminal. Never type your new password into a chat."))return;
    try{await writeSshSession(session.id,'net user "'+profile.user+'" *\r')}
    catch(e){setProbeError(String(e))}
  };
  const closeInteractive=async(id:string)=>{try{await closeSshSession(id)}catch(e){setProbeError(String(e))}onSessionClosed(id)};
  const active=hosts.find(h=>h.id===selected) || {id:"",label:"No host selected",address:"",user:"",port:22,group:"Workspace",fingerprint:false};
  const filtered=useMemo(()=>hosts.filter(h=>(h.label+" "+h.address+" "+h.group).toLowerCase().includes(query.trim().toLowerCase())),[hosts,query]);
  const activeConnections=sshTabs.filter(t=>t.alias===active.id).length;
  const connected=activeConnections>0;
  const context="Host: "+active.label+"\nTarget: "+active.user+"@"+active.address+"\nConnection: "+(connected?`connected (${activeConnections} SSH session${activeConnections===1?"":"s"})`:"disconnected")+"\nVault: "+(vaultUnlocked?"unlocked":"locked")+"\nPermissions: none\nSelected resources: none";
  return <div className={"shell "+theme} onKeyDown={e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="k"){e.preventDefault();setCommandOpen(v=>!v)}if(e.key==="Escape"){setCommandOpen(false);setShowSettings(false)}}}>
    <header className="topbar"><div className="brand"><div className="brandicon"><TerminalSquare size={19}/></div><strong>PaSSH7</strong><span className="alpha">v{buildInfo?.version ?? "0.1.0"} · PREVIEW</span></div><div className="topactions"><button className="lock" onClick={()=>{if(desktopAvailable()){if(vaultUnlocked){void lockVault()}else{setVaultDialog(true)}}}}><LockKeyhole size={14}/> {vaultUnlocked?"Lock vault":desktopAvailable()?"Unlock vault":"Vault unavailable"}</button><button className="iconbtn" title="Command palette (Ctrl+K)" aria-label="Command palette" onClick={()=>setCommandOpen(true)}><Command size={17}/></button><button className="iconbtn" title="Settings" aria-label="Settings" onClick={()=>setShowSettings(true)}><Settings2 size={17}/></button></div></header>
    <div className="workspace">
      {sidebar&&<aside className="sidebar"><div className="sectionHeading"><span>YOUR HOSTS</span><button className="iconbtn" title="Add host" aria-label="Add host" onClick={()=>{if(desktopAvailable()&&!vaultUnlocked){setVaultDialog(true);return}setAddOpen(true);setStep(0);setError("")}}><Plus size={16}/></button></div><label className="search"><Search size={15}/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search hosts" aria-label="Search hosts"/><span>⌘ K</span></label>
        {[...new Set(hosts.map(h=>h.group))].map(group=><section key={group}><div className="groupLabel"><ChevronDown size={13}/>{group}</div>{filtered.filter(h=>h.group===group).map(h=><button key={h.id} className={"host "+(selected===h.id?"selected":"")} onClick={()=>setSelected(h.id)}><Server size={16}/><span className="hostText"><strong>{h.label}</strong><small>{h.user}@{h.address}</small></span><span className={"hostDot "+(sshTabs.some(t=>t.alias===h.id)?"trusted":"untrusted")} title={sshTabs.some(t=>t.alias===h.id)?"SSH session active":h.fingerprint?"Trusted host key; disconnected":"Disconnected; host key unpinned"}/></button>)}</section>)}
        {!filtered.length&&<p className="emptySearch">{hosts.length===0?"No saved hosts yet":query.trim()?"No matching hosts":""}</p>}
        {desktopAvailable()&&vaultUnlocked&&<section className="identityManage"><div className="groupLabel">SSH IDENTITIES</div>{identities.map(name=><div className="identityManageRow" key={name}><KeyRound size={14}/><span title={name}>{name}</span><button className="iconbtn" title={"Show public key "+name} aria-label={"Show public key "+name} onClick={async()=>{try{const pub=await getPublicIdentity(name);setGeneratedKey(pub);setKeyDialog(true);setError("")}catch(e){setError(String(e))}}}><KeyRound size={14}/></button><button className="iconbtn" title={"Remove identity "+name} aria-label={"Remove identity "+name} onClick={()=>{setError("");setDeleteTarget({kind:"identity",alias:name})}}><Trash2 size={14}/></button></div>)}{!identities.length&&<p className="emptySearch">No keys imported</p>}</section>}
        <div className="sidebottom"><span><ShieldCheck size={15}/> Local-first workspace</span><small>{desktopAvailable()?(vaultUnlocked?`${hosts.length} saved host${hosts.length===1?"":"s"} in encrypted vault`:"Unlock vault to view saved hosts"):"Example hosts only. No real credentials."}</small></div></aside>}
      <main className="main"><div className="sessionTabs"><button className="iconbtn" aria-label={sidebar?"Hide host sidebar":"Show host sidebar"} onClick={()=>setSidebar(x=>!x)}><Monitor size={16}/></button><div className="sessionActive"><TerminalSquare size={15}/>{active.label}<span className="tabdot" style={{background:connected?"#22c55e":undefined}}/></div><div className="tabSpacer"/><span className="unavailable" style={{color:connected?"#22c55e":undefined}}>{connected?`Connected · ${activeConnections} session${activeConnections===1?"":"s"}`:"Not connected"}</span></div>
        <div className="identity"><div><div className="eyebrow">WORKSPACE / {active.group.toUpperCase()}</div><h1>{active.label}</h1><div className="identityMeta"><span><Server size={14}/>{active.user}@{active.address}</span><span>Port {active.port ?? 22}</span><span className={active.fingerprint?"pin ok":"pin warn"}><ShieldCheck size={14}/>{active.fingerprint?"Pin metadata present":"Host key unpinned"}</span></div></div><div className="identityActions">{desktopAvailable()&&vaultUnlocked&&active.id&&<button className="iconbtn" title="Remove selected host" aria-label="Remove selected host" onClick={()=>{setError("");setDeleteTarget({kind:"host",alias:active.id})}}><Trash2 size={16}/></button>}<button className="primary" disabled={!desktopAvailable()||!vaultUnlocked||!active.id||sshBusy||tofuBusy} onClick={async()=>{
  setProbeError("");setTofuError("");
  if(!active.fingerprint){
    setTofuBusy(true);
    try{const key=await discoverSshHostKey(active.id);setTofuCandidate({alias:active.id,fingerprint:key.fingerprint})}
    catch(e){setProbeError(String(e))}
    finally{setTofuBusy(false)}
    return;
  }
  setLoginPassword("");setLoginKeyPassphrase("");setLoginMode((active.savedAuthMode as "key"|"password"|"key-password")||"key-password");setUseSavedCredentials(!!active.hasSavedCredentials);setRememberCredentials(!!active.hasSavedCredentials);setLoginOpen(true)
}}>Connect <span>↗</span></button>{desktopAvailable()&&vaultUnlocked&&active.id&&active.fingerprint&&<button className="iconbtn" style={{width:"auto",padding:"0 12px"}} onClick={()=>void authenticateActive()} disabled={authBusy} title="Verify pinned SSH host key and authenticate using encrypted vault key">{authBusy?"Authenticating…":"Test SSH login"}</button>}{desktopAvailable()&&vaultUnlocked&&active.id&&<button className="iconbtn" style={{width:"auto",padding:"0 12px"}} onClick={()=>void probeActive()} disabled={probeBusy} title="Check SSH banner; not an authenticated connection">{probeBusy?"Checking…":"Test SSH port"}</button>}</div></div>
        {credentialWarning&&<p className="wizardError" role="alert">{credentialWarning}</p>}<div className="terminal"><div className="terminalbar"><span><TerminalSquare size={15}/> Terminal</span><small>{sshTabs.length?`${sshTabs.length} SSH session(s)`:"NO ACTIVE SESSION"}</small>{activeSsh&&<button onClick={()=>{setAccessOpen(true);setAccessPublicKey("");setError("")}}>Windows Access Manager</button>}{activeSsh&&<button title="Windows local account: interactive password change. Requires appropriate account permissions." onClick={()=>void changeWindowsPassword()}>Change Windows password</button>}</div>{sshTabs.length>0&&<div className="sshTabBar">{sshTabs.map(t=><button key={t.id} className={activeSsh===t.id?"sshTab active":"sshTab"} onClick={()=>setActiveSsh(t.id)}>{t.alias} <span role="button" title="Disconnect" onClick={e=>{e.stopPropagation();void closeInteractive(t.id)}}>×</span></button>)}</div>}{sshTabs.map(t=><TerminalView key={t.id} id={t.id} active={t.id===activeSsh} onClosed={onSessionClosed}/>)}{sshTabs.length===0&&<div className="terminalEmpty"><div className="terminalGlyph"><TerminalSquare size={28}/></div><h2>Your terminal starts here</h2><p>Choose a host and unlock your vault to open a secure SSH session. Connect to your saved host to open an interactive SSH terminal.</p><div className="statusline"><LockKeyhole size={14}/> {vaultUnlocked?"Vault unlocked":"Vault locked"} <span>·</span> SSH requires a pinned host key</div>{authResult&&<p role="status" className="note">{authResult}</p>}{probeResult?.alias===selected&&<p className="note" role="status">SSH service responded in {probeResult.data.elapsedMs} ms: {probeResult.data.banner}. Identity and host key have NOT been verified.</p>}{probeError&&<p className="wizardError" role="alert">{probeError}</p>}</div>}</div>
        <footer><span className="footerBrand"><span className="statusDot" style={{background:connected?"#22c55e":undefined}}/> {connected?"SSH connected":desktopAvailable()?"No active SSH session":"Offline preview"}</span><span>{active.label} · {sshTabs.length} session(s)</span><span>{buildInfo?.publisher ?? "PAS7 Studio"} · {buildInfo?.target ?? "Loading build info"}</span></footer>
      </main>
      <aside className="context"><div className="contextHeader"><span>CONTEXT</span><CircleHelp size={16}/></div><div className="contextTabs">{tabs.map(({id,label,Icon})=><button key={id} className={panel===id?"active":""} title={label} aria-label={label} onClick={()=>setPanel(id)}><Icon size={17}/></button>)}</div><div className="contextBody">
        {panel==="agent"?<><div className="contextTitle"><Bot size={18}/><h3>AI Agent</h3></div><p className="muted">Use Codex, Claude Code or OpenCode with scoped access to the active SSH host.</p><label className="fieldLabel">Agent</label><select value={agent} onChange={e=>setAgent(e.target.value as AgentKind)} aria-label="Select AI agent">{AGENTS.map(a=><option key={a.kind} value={a.kind}>{a.name}</option>)}</select><label className="fieldLabel">Permissions</label><div className="permission"><ShieldCheck size={16}/><div><strong>Remote CLI privileges</strong><small>Runs with connected SSH user permissions; no PaSSH7 sandbox or MCP scoping yet</small></div></div><label className="fieldLabel">Context preview</label><pre className="preview">{context}</pre><button className="contextAction" disabled={!connected||!activeSsh} onClick={()=>void launchRemoteAgent()}>Launch {AGENTS.find(a=>a.kind===agent)?.name} in SSH terminal</button>{agentStatus&&<p role="status" className="note">{agentStatus}</p>}<p className="note">Launches an installed CLI in your SSH shell, not a scoped MCP integration. PaSSH7 does not send private SSH keys or vault secrets to the agent. Configure provider authentication on the remote host yourself.</p></>:
        panel==="files"?<><div className="contextTitle"><FolderClosed size={18}/><h3>Remote files (SFTP)</h3></div><p className="muted">Read-only directory browsing over the authenticated SSH connection.</p><label className="fieldLabel">Remote directory</label><input aria-label="SFTP directory" value={sftpPath} onChange={e=>setSftpPath(e.target.value)} placeholder="." style={{width:"100%"}}/><button className="contextAction" disabled={!connected||!activeSsh||sftpBusy} onClick={()=>void browseSftp(sftpPath)}>{sftpBusy?"Reading directory…":"Browse directory"}</button>{sftpEntries?.session===activeSsh&&<div className="dockerInventory"><p className="muted">{sftpEntries.path} · {sftpEntries.items.length} entries</p><button type="button" onClick={()=>void browseSftp(sftpEntries.path+"/..")} disabled={sftpBusy}>↑ Parent directory</button>{sftpEntries.items.map((item,index)=><div className="dockerItem" key={item.name+"-"+index}>{item.isDir?<button type="button" onClick={()=>void browseSftp(sftpEntries.path+"/"+item.name)} disabled={sftpBusy}>📁 {item.name}</button>:<button type="button" disabled={sftpBusy||sftpPreviewBusy} onClick={()=>void readSftpPreview(sftpEntries.path+"/"+item.name)}>📄 {item.name}</button>}</div>)}</div>}{sftpPreview?.session===activeSsh&&<div><p className="muted" style={{overflowWrap:"anywhere"}}>Read-only preview: {sftpPreview.path}</p><textarea aria-label="Remote file preview" readOnly value={sftpPreview.body} rows={12} style={{width:"100%",fontFamily:"monospace",fontSize:"12px"}}/><button type="button" onClick={()=>setSftpPreview(null)}>Close preview</button></div>}{sftpPreviewBusy&&<p className="note">Loading file preview…</p>}{sftpError&&<p className="wizardError" role="alert">{sftpError}</p>}{!connected&&<div className="placeholder">Connect to the selected host before browsing.</div>}</>:
        panel==="docker"?<><div className="contextTitle"><Container size={18}/><h3>Docker containers</h3></div><p className="muted">Runs <code>docker ps -a</code> on the connected host using your SSH account. Read-only inventory.</p><button className="contextAction" disabled={!activeSsh||dockerBusy} onClick={()=>void refreshDocker()}>{dockerBusy?"Loading containers…":"Refresh containers"}</button>{dockerError&&<p className="wizardError" role="alert">{dockerError}</p>}{dockerInventory?.session===activeSsh?<div className="dockerInventory"><p className="muted">{dockerInventory.items.length} container(s)</p>{dockerInventory.items.map((item,index)=><div key={item.ID||index} className="dockerItem"><strong>{item.Names||item.ID||"Unnamed"}</strong><small>{item.Image||"Unknown image"}</small><span>{item.Status||item.State||"Unknown status"}</span>{item.Ports&&<small>{item.Ports}</small>}</div>)}</div>:<div className="placeholder"><Container size={23}/>{connected?"Click Refresh containers to fetch the real inventory.":"Connect to the server to inspect Docker."}</div>}</>:
        <><div className="contextTitle"><Activity size={18}/><h3>Local SSH tunnels</h3></div><p className="muted">Bind to localhost only. Route connections through this verified SSH session to a remote destination. Stops on disconnect or vault lock.</p><label className="fieldLabel">Local TCP port<input type="number" min={1} max={65535} value={tunnelLocalPort} onChange={e=>setTunnelLocalPort(Number(e.target.value))}/></label><label className="fieldLabel">Remote destination hostname<input value={tunnelRemoteHost} onChange={e=>setTunnelRemoteHost(e.target.value)} placeholder="127.0.0.1"/></label><label className="fieldLabel">Remote destination TCP port<input type="number" min={1} max={65535} value={tunnelRemotePort} onChange={e=>setTunnelRemotePort(Number(e.target.value))}/></label><button className="contextAction" disabled={!connected||!activeSsh||tunnelBusy||tunnelLocalPort<1||tunnelLocalPort>65535||tunnelRemotePort<1||tunnelRemotePort>65535||!tunnelRemoteHost.trim()} onClick={()=>void addTunnel()}>{tunnelBusy?"Working…":"Start local forwarding"}</button>{tunnelError&&<p role="alert" className="wizardError">{tunnelError}</p>}<div className="dockerInventory">{tunnels.filter(t=>sshTabs.some(s=>s.id===t.session&&s.alias===selected)).map(t=><div className="dockerItem" key={t.session+":"+t.localPort}><strong>127.0.0.1:{t.localPort}</strong><small>→ {t.targetHost}:{t.remotePort} via SSH</small><button disabled={tunnelBusy} onClick={()=>void removeTunnel(t.session,t.localPort)}>Stop tunnel</button></div>)}</div></>}
      </div></aside>
    </div>
    {deleteTarget&&<div className="overlay" onMouseDown={()=>{setDeleteTarget(null);setError("")}}><div className="modal" role="dialog" aria-modal="true" aria-label="Confirm vault removal" onMouseDown={e=>e.stopPropagation()}><div className="modalTitle"><Trash2 size={18}/> Remove {deleteTarget.kind}<button aria-label="Close" onClick={()=>{setDeleteTarget(null);setError("")}}><X size={17}/></button></div><p>Remove <strong>{deleteTarget.alias}</strong> from the encrypted vault? This cannot be undone. Removing a host keeps its SSH key; removing a key used by a host is blocked.</p>{error&&<p role="alert" className="wizardError">{error}</p>}<div className="wizardActions"><button onClick={()=>{setDeleteTarget(null);setError("")}}>Cancel</button><button className="primary" onClick={()=>void confirmRemove()}>Confirm removal</button></div></div></div>}
    {vaultDialog&&<div className="overlay" onMouseDown={()=>setVaultDialog(false)}><div className="modal" role="dialog" aria-modal="true" aria-label="Unlock encrypted vault" onMouseDown={e=>e.stopPropagation()}><div className="modalTitle"><LockKeyhole size={18}/> {vaultPresent?"Unlock vault":"Create vault"}<button aria-label="Close" onClick={()=>setVaultDialog(false)}><X size={17}/></button></div><p>Master password stays in this application session only. Lock the vault when finished.</p><form onSubmit={async e=>{e.preventDefault();await unlockVault()}} className="wizardFields"><label>Master password<input autoFocus type="password" autoComplete="off" value={vaultPassword} onChange={e=>setVaultPassword(e.target.value)} minLength={12} required/></label>{error&&<p role="alert" className="wizardError">{error}</p>}<button className="primary" type="submit">{vaultPresent?"Unlock":"Create encrypted vault"}</button></form></div></div>}
    {accessOpen&&<div className="overlay" onMouseDown={()=>setAccessOpen(false)}><div className="modal wizard" role="dialog" aria-modal="true" aria-label="Windows SSH Access Manager" onMouseDown={e=>e.stopPropagation()}><div className="modalTitle"><ShieldCheck size={18}/> Windows Access Manager<button aria-label="Close" onClick={()=>setAccessOpen(false)}><X size={17}/></button></div><div className="wizardFields"><p className="note">Commands run under the connected Windows account. Administrator operations require the appropriate Windows permissions. Output appears in the SSH terminal.</p><button onClick={()=>void runWindowsAccessAction("users")}>List Windows local users</button><button onClick={()=>void runWindowsAccessAction("keys")}>Show administrator authorized SSH keys</button><label>Public SSH key (for add / revoke)<textarea rows={4} value={accessPublicKey} onChange={e=>setAccessPublicKey(e.target.value)} placeholder="ssh-ed25519 AAAA… colleague-device"/></label><button onClick={()=>void runWindowsAccessAction("add")}>Add public key to administrator access</button><button onClick={()=>void runWindowsAccessAction("remove")}>Revoke exact public key (with backup)</button><p className="note">Before removing a key, verify an alternative login. This tool never changes sshd_config or grants Windows administrator membership.</p>{error&&<p className="wizardError" role="alert">{error}</p>}</div></div></div>}
    {tofuCandidate&&<div className="overlay" onMouseDown={()=>{if(!tofuBusy)setTofuCandidate(null)}}><div className="modal wizard" role="dialog" aria-modal="true" aria-label="Trust SSH server key" onMouseDown={e=>e.stopPropagation()}><div className="modalTitle"><ShieldCheck size={18}/> Verify first SSH connection<button type="button" aria-label="Cancel" disabled={tofuBusy} onClick={()=>setTofuCandidate(null)}><X size={17}/></button></div><p>The server at <strong>{active.address}:{active.port}</strong> presented this host-key fingerprint. Verify it independently with the server administrator before trusting it.</p><pre className="preview" style={{userSelect:"text",overflowWrap:"anywhere"}}>{tofuCandidate.fingerprint}</pre><p className="note">No password or private key has been sent. If the key differs from the trusted fingerprint, cancel. Once saved, a changed fingerprint blocks future connections.</p>{tofuError&&<p role="alert" className="wizardError">{tofuError}</p>}<div className="wizardActions"><button type="button" disabled={tofuBusy} onClick={()=>setTofuCandidate(null)}>Cancel</button><button type="button" className="primary" disabled={tofuBusy} onClick={async()=>{setTofuBusy(true);setTofuError("");try{await pinSshHostKey(tofuCandidate.alias,tofuCandidate.fingerprint);const saved=await getHosts();setHosts(saved.map(h=>({id:h.alias,label:h.alias,address:h.hostname,user:h.username,port:h.port,group:"My hosts",fingerprint:h.hostKeyPinned,hasSavedCredentials:h.hasSavedCredentials,savedAuthMode:h.savedAuthMode})));setTofuCandidate(null);setLoginPassword("");setLoginKeyPassphrase("");setLoginMode("key-password");setUseSavedCredentials(false);setRememberCredentials(false);setLoginOpen(true)}catch(e){setTofuError(String(e))}finally{setTofuBusy(false)}}}>Trust &amp; Continue</button></div></div></div>}
    {loginOpen&&<div className="overlay" onMouseDown={()=>{if(!sshBusy){setLoginOpen(false);setLoginPassword("")}}}><form className="modal wizard" role="dialog" aria-modal="true" aria-label="Connect via SSH" onMouseDown={e=>e.stopPropagation()} onSubmit={e=>{e.preventDefault();void connectInteractive(loginPassword)}}><div className="modalTitle"><KeyRound size={18}/> Connect to {active.label}<button type="button" aria-label="Close" disabled={sshBusy} onClick={()=>{setLoginOpen(false);setLoginPassword("")}}><X size={17}/></button></div><div className="wizardFields"><p className="note">PaSSH7 verifies the pinned host key before authentication. Your SSH private key remains in the encrypted vault.</p><label>Authentication mode<select value={loginMode} onChange={e=>setLoginMode(e.target.value as "key"|"password"|"key-password")}><option value="password">Password only (first login / install key)</option><option value="key">SSH key only</option><option value="key-password">SSH key + Windows password</option></select></label>{loginMode!=="password"&&<label>SSH private-key passphrase (if encrypted)<input type="password" autoComplete="off" value={loginKeyPassphrase} onChange={e=>setLoginKeyPassphrase(e.target.value)} placeholder="Leave blank for unencrypted keys"/></label>}<label>Windows account password (only if required by server)<input type="password" autoComplete="off" value={loginPassword} onChange={e=>setLoginPassword(e.target.value)} placeholder="Optional for key-only login"/></label><label style={{display:"flex",gap:9,alignItems:"center",flexDirection:"row"}}><input type="checkbox" checked={rememberCredentials} onChange={e=>{setRememberCredentials(e.target.checked);setUseSavedCredentials(e.target.checked&&!!active.hasSavedCredentials)}}/> Remember authentication for this host in encrypted vault</label>{useSavedCredentials&&<p className="note">Saved credentials will be used after vault unlock. Leave password fields empty to use saved values.</p>}{active.hasSavedCredentials&&<button type="button" onClick={async()=>{if(!window.confirm("Forget saved SSH passwords for this host?"))return;try{await forgetHostCredentials(selected);setUseSavedCredentials(false);setRememberCredentials(false);setHosts(v=>v.map(h=>h.id===selected?{...h,hasSavedCredentials:false,savedAuthMode:null}:h))}catch(e){setProbeError(String(e))}}}>Forget saved passwords</button>}<p className="note">For initial onboarding use Password only. After the public key is installed, select SSH key + Windows password if the server enforces AuthenticationMethods publickey,password. The password is not stored.</p>{probeError&&<div role="alert" className="wizardError" style={{textAlign:"left"}}><strong>{connectionHelp(probeError).title}</strong><ul>{connectionHelp(probeError).checks.map((check,i)=><li key={i}>{check}</li>)}</ul><details><summary>Technical error (copy for support)</summary><code style={{display:"block",whiteSpace:"pre-wrap",overflowWrap:"anywhere"}}>{probeError}</code><button type="button" onClick={()=>void navigator.clipboard.writeText(probeError)}>Copy error</button></details></div>}<button type="submit" className="primary" disabled={sshBusy}>{sshBusy?"Authenticating…":"Connect securely"}</button></div></form></div>}
    {keyDialog&&<div className="overlay" onMouseDown={()=>{setKeyDialog(false);setKeyPem("");setError("")}}><div className="modal wizard" role="dialog" aria-modal="true" aria-label="SSH identity manager" onMouseDown={e=>e.stopPropagation()}><div className="modalTitle"><KeyRound size={18}/> SSH identity manager<button aria-label="Close" onClick={()=>setKeyDialog(false)}><X size={17}/></button></div><div className="wizardFields"><label>Identity name<input value={keyAlias} onChange={e=>setKeyAlias(e.target.value)} placeholder="my-ed25519"/></label><button className="primary" disabled={keyWorking||!vaultUnlocked||!keyAlias.trim()} onClick={async()=>{setKeyWorking(true);setError("");try{const key=await generateEd25519(keyAlias,"passh7-main");setGeneratedKey(key);setIdentities(await getIdentities());setDraft(v=>({...v,identity:key.alias}));setKeyAlias("")}catch(e){setError(String(e))}finally{setKeyWorking(false)}}}>{keyWorking?"Generating…":"Generate new Ed25519 key"}</button>{generatedKey&&<div className="permission" style={{display:"block",overflowWrap:"anywhere"}}><strong>Public key generated — safe to share</strong><p className="note">{generatedKey.fingerprint}</p><textarea readOnly value={generatedKey.publicKey} rows={4} aria-label="Generated public SSH key"/><button onClick={()=>void navigator.clipboard.writeText(generatedKey.publicKey).catch(e=>setError(String(e)))}>Copy PUBLIC key</button><button onClick={()=>{try{void navigator.clipboard.writeText(windowsAdminKeyScript(generatedKey.publicKey)).catch(e=>setError(String(e)))}catch(e){setError(String(e))}}}>Copy Windows Admin setup (PowerShell)</button><button disabled={!activeSsh||sshBusy} onClick={async()=>{
  const target=sshTabs.find(t=>t.id===activeSsh);
  if(!target){setError("Open a Windows SSH session before installing a key");return}
  if(!window.confirm("Append this public key to Windows administrators_authorized_keys on "+target.alias+"? This requires an elevated administrator SSH session. Existing keys are preserved."))return;
  try{
    const script=windowsAdminKeyScript(generatedKey.publicKey);
    const bytes=new Uint8Array(script.length*2);
    for(let i=0;i<script.length;i++){const char=script.charCodeAt(i);bytes[i*2]=char&255;bytes[i*2+1]=char>>>8}
    let binary="";for(const byte of bytes)binary+=String.fromCharCode(byte);
    await writeSshSession(target.id,"powershell.exe -NoProfile -EncodedCommand "+btoa(binary)+"\\r");
    setError("Install command sent to "+target.alias+". Check terminal output and verify a second key-based login before changing SSH policy.")
  }catch(e){setError(String(e))}
}}>Install PUBLIC key into active Windows SSH session</button><p className="note">Your private key stays in the encrypted local vault. Add this public key to Windows OpenSSH administrators_authorized_keys if the login belongs to the Administrators group.</p><p className="note">Run the copied commands in an elevated PowerShell session on the Windows server. They add the public key without removing existing keys. Never enable AuthenticationMethods publickey,password until you have confirmed key-only login from another terminal.</p></div>}<hr/><label>Private key (PEM/OpenSSH)<textarea value={keyPem} onChange={e=>setKeyPem(e.target.value)} rows={5} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;...&#10;-----END OPENSSH PRIVATE KEY-----"/></label><label>Private key passphrase (optional)<input type="password" autoComplete="off" value={importKeyPassphrase} onChange={e=>setImportKeyPassphrase(e.target.value)} placeholder="Only needed for encrypted SSH keys"/></label><p className="note">This input is sent to local Rust for encrypted storage. Paste the full PRIVATE key, not a .pub line. For new hosts, use Generate new Ed25519 key instead. Encrypted and unencrypted private keys are supported. If encrypted, enter the key passphrase below; it is not saved.</p>{error&&<p role="alert" className="wizardError">{error}</p>}<button className="primary" onClick={async()=>{setError("");if(!keyAlias.trim()){setError("Enter an identity name");return}if(keyPem.trim().startsWith("ssh-")){setError("This is a PUBLIC key (.pub). Paste your PRIVATE key or use Generate new Ed25519 key.");return}try{await importIdentity(keyAlias,keyPem,importKeyPassphrase);setIdentities(await getIdentities());setDraft(v=>({...v,identity:keyAlias}));setKeyPem("");setImportKeyPassphrase("");setKeyAlias("");setKeyDialog(false);setError("")}catch(e){setError(String(e))}}}>Import to vault</button></div></div></div>}
    {addOpen&&!keyDialog&&<div className="overlay" onMouseDown={()=>setAddOpen(false)}><div className="modal wizard" role="dialog" aria-modal="true" aria-label="Add a new SSH host" onMouseDown={e=>e.stopPropagation()}>
      <div className="modalTitle"><Server size={18}/> Add a host <button aria-label="Close" onClick={()=>setAddOpen(false)}><X size={17}/></button></div>
      <div className="steps">{["Connection","Authentication","Trust","Review"].map((t,i)=><span className={i===step?"active":""} key={t}>{i+1}. {t}</span>)}</div>
      {step===0&&<div className="wizardFields"><label>Name<input value={draft.label} onChange={e=>setDraft({...draft,label:e.target.value})} placeholder="My Ubuntu server"/></label><label>Hostname / IP<input value={draft.hostname} onChange={e=>setDraft({...draft,hostname:e.target.value})} placeholder="192.168.1.10"/></label><div className="twoFields"><label>User<input value={draft.username} onChange={e=>setDraft({...draft,username:e.target.value})} placeholder="ubuntu"/></label><label>Port<input type="number" min={1} max={65535} value={draft.port} onChange={e=>setDraft({...draft,port:Number(e.target.value)})}/></label></div></div>}
      {step===1&&<div className="wizardFields"><label>Authentication<select value={draft.auth} onChange={e=>setDraft({...draft,auth:e.target.value as "key"|"agent"})}><option value="key">Vault SSH key</option><option value="agent" disabled>Windows OpenSSH agent (future)</option></select></label>{draft.auth==="key"&&<label>SSH identity<select value={draft.identity} onChange={e=>setDraft({...draft,identity:e.target.value})}><option value="">Choose an imported key</option>{identities.map(name=><option key={name} value={name}>{name}</option>)}</select></label>}{desktopAvailable()&&<button className="iconbtn" style={{width:"auto",justifyContent:"start"}} onClick={()=>{setKeyDialog(true);setGeneratedKey(null);setError("")}}><Plus size={14}/> Manage / Generate key</button>}<p className="note">The selected SSH key remains in the encrypted local vault. Windows account password is requested when connecting, if required.</p></div>}
      {step===2&&<div className="wizardFields"><label>Verified server fingerprint<input value={draft.fingerprint} onChange={e=>setDraft({...draft,fingerprint:e.target.value})} placeholder="SHA256:..."/></label><p className="note">Obtain this fingerprint independently from a trusted administrator. You may leave this empty. On first connection PaSSH7 will show the discovered SHA256 fingerprint and require your explicit approval before any authentication.</p></div>}
      {step===3&&<div className="wizardFields"><div className="permission"><ShieldCheck size={16}/><div><strong>{draft.label || "Unnamed host"}</strong><small>{draft.username}@{draft.hostname}:{draft.port}</small></div></div><p className="note">{desktopAvailable()?"The host will be saved in your encrypted local vault. If no fingerprint is supplied, you will verify it when you first connect.":"Web preview only: this host is temporary and disappears after refresh."}</p></div>}
      {error&&<p role="alert" className="wizardError">{error}</p>}
      <div className="wizardActions"><button onClick={()=>step===0?setAddOpen(false):setStep(step-1)}>{step===0?"Cancel":"Back"}</button><button className="primary" onClick={async()=>{const issue=validateHostDraft({...draft,fingerprint:step<2?"":draft.fingerprint,identity:step===0?"placeholder":draft.identity});if(step===0&&(!draft.label.trim()||!draft.hostname.trim()||!draft.username.trim()||draft.port<1||draft.port>65535)){setError("Complete the connection details");return}if(step>=1&&issue){setError(issue);return}setError("");if(step<3){setStep(step+1);return}if(desktopAvailable()){try{await addHost({alias:draft.label,hostname:draft.hostname,port:draft.port,username:draft.username,identityAlias:draft.identity,pinnedHostKey:draft.fingerprint||null});const saved=await getHosts();setHosts(saved.map(h=>({id:h.alias,label:h.alias,address:h.hostname,user:h.username,port:h.port,group:"My hosts",fingerprint:h.hostKeyPinned})));setSelected(draft.label);setAddOpen(false)}catch(err){setError(String(err))}return}const id="preview-"+Date.now();setHosts(v=>[...v,{id,label:draft.label,address:draft.hostname,user:draft.username,port:draft.port,group:"My hosts",fingerprint:!!draft.fingerprint}]);setSelected(id);setAddOpen(false);}}> {step===3?(desktopAvailable()?"Save host":"Add to preview"):"Continue"} </button></div>
    </div></div>}
    {commandOpen&&<div className="overlay" onMouseDown={()=>setCommandOpen(false)}><div className="modal" role="dialog" aria-modal="true" aria-label="Command palette" onMouseDown={e=>e.stopPropagation()}><div className="modalTitle"><Search size={18}/> Quick switch <button onClick={()=>setCommandOpen(false)} aria-label="Close"><X size={17}/></button></div><p>Switch to a host</p>{hosts.map(h=><button className="paletteHost" key={h.id} onClick={()=>{setSelected(h.id);setCommandOpen(false)}}><Server size={16}/>{h.label}<small>{h.address}</small></button>)}</div></div>}
    {showSettings&&<div className="overlay" onMouseDown={()=>setShowSettings(false)}><div className="modal" role="dialog" aria-modal="true" aria-label="Preferences" onMouseDown={e=>e.stopPropagation()}><div className="modalTitle"><Settings2 size={18}/> Preferences<button onClick={()=>setShowSettings(false)} aria-label="Close"><X size={17}/></button></div><p>Appearance</p><div className="switches"><button onClick={()=>setTheme("dark")} aria-pressed={theme==="dark"}>Dark</button><button onClick={()=>setTheme("light")} aria-pressed={theme==="light"}>Light</button></div><div className="buildAbout"><h3>About PaSSH7</h3><dl><dt>Version</dt><dd>{buildInfo?.version ?? "Loading..."}</dd><dt>Publisher</dt><dd>{buildInfo?.publisher ?? "PAS7 Studio"}</dd><dt>Platform</dt><dd>{buildInfo?.target ?? "Loading..."}</dd><dt>Built at (UTC)</dt><dd>{buildInfo?.builtAt ?? "Loading..."}</dd><dt>Build number</dt><dd>{buildInfo?.runNumber ?? "Loading..."}</dd><dt>Commit</dt><dd title={buildInfo?.commit}>{buildInfo?.commit?.slice(0,12) ?? "Loading..."}</dd><dt>Repository</dt><dd>{buildInfo?.repository ?? "pas7-studio/PaSSH7"}</dd></dl><p className="note">Copyright © 2026 PAS7 Studio. Preview release; SSH sessions are not yet implemented.</p></div></div></div>}
  </div>;
}
