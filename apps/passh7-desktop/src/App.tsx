import {useCallback,useRef} from "react";
import TerminalView from "./TerminalView";
import RemoteFilesWorkspace from "./RemoteFilesWorkspace";
import useSftpTransferQueue from "./useSftpTransferQueue";
import DockerWorkspace from "./DockerWorkspace";
import SettingsWorkspace from "./SettingsWorkspace";
import AgentWorkspace from "./AgentWorkspace";
import ConnectionsWorkspace from "./ConnectionsWorkspace";
import SnippetsWorkspace from "./SnippetsWorkspace";
import PortForwardingWorkspace from "./PortForwardingWorkspace";
import {loadPreferences,savePreferences,type AppPreferences,type PaneSizes} from "./preferences";
import {useEffect,useMemo,useState} from "react";
import {listen} from "@tauri-apps/api/event";
import {addHost,desktopAvailable,getHosts,initializeVault,unlockVault as unlockNativeVault,lockVault as lockNativeVault,vaultExists,vaultStatus,getIdentities,importIdentity,setHostIdentity,setHostJumpRoute,setHostBackupDirectory,discoverLocalSshConfigHosts,type LocalSshConfigHost,removeHost,removeIdentity,getBuildInfo,type BuildInfo,probeSshHost,type SshProbeResult,authenticateSshHost,openSshSession,closeSshSession,writeSshSession,generateEd25519,getPublicIdentity,type GeneratedPublicKey,saveHostCredentials,forgetHostCredentials,listDockerContainers,listDockerStats,type DockerRuntimeStats,inspectDockerContainer,type DockerDetails,readDockerLogs,startDockerLogStream,stopDockerLogStream,type DockerLogEvent,controlDockerContainer,probeRemoteAgent,discoverSshHostKey,discoverSshHostKeyVia,pinSshHostKey,listSftpDirectory,type SftpEntry,readSftpImage,startLocalForward,stopLocalForward,listLocalForwards,readSftpText,mutateSftpFile,backupEncryptedVaultToSsh,backupEncryptedVaultBatch,type VaultBackupBatchProgress,exportEncryptedVaultLocally,inspectEncryptedVaultBackup,inspectRemoteEncryptedVaultBackup,commitEncryptedVaultRestore,type VaultRestorePreview,listLiveSshSessions} from "./backend";
import {AGENTS,validateHostDraft,type AgentKind,type HostDraft} from "./integrations";
import {Activity, Bot, ChevronDown, CircleHelp, Command, Container, FileText, FolderClosed, KeyRound, LockKeyhole, Monitor, Plus, Search, Server, Settings2, ShieldCheck, TerminalSquare, Trash2, X} from "lucide-react";

type Panel = "connections" | "terminal" | "files" | "docker" | "agent" | "snippets" | "ports" | "settings";
type Host = {id:string; label:string; address:string; user:string; port:number; group:string; fingerprint:boolean;identityAlias?:string;hasSavedCredentials?:boolean;savedAuthMode?:string|null;backupDirectory?:string|null;jumpAlias?:string|null};
const DEMO_HOSTS:Host[] = [
  {id:"dev",label:"Development",address:"dev.example.invalid",user:"ubuntu",port:22,group:"Development",fingerprint:true},
  {id:"staging",label:"Staging",address:"staging.example.invalid",user:"deploy",port:22,group:"Development",fingerprint:false},
  {id:"prod",label:"Production",address:"prod.example.invalid",user:"ops",port:22,group:"Production",fingerprint:true}
];
function formatSftpSize(size:number|null):string{
  if(size===null)return "Size unknown";
  if(size<1024)return size+" B";
  if(size<1024*1024)return (size/1024).toFixed(1)+" KiB";
  return (size/(1024*1024)).toFixed(2)+" MiB";
}
function sftpBreadcrumbs(path:string):{label:string;path:string}[]{
  const absolute=path.startsWith("/");
  const pieces=path.split("/").filter(part=>part&&part!==".");
  const root=absolute?"/":".";
  return [{label:root,path:root},...pieces.map((piece,index)=>({
    label:piece,path:(absolute?"/":"")+pieces.slice(0,index+1).join("/")
  }))];
}
const tabs: {id:Panel;label:string; Icon:typeof Bot}[]=[
  {id:"files",label:"Files",Icon:FolderClosed},{id:"docker",label:"Docker",Icon:Container},
  {id:"ports",label:"Ports",Icon:Activity},{id:"agent",label:"AI Agent",Icon:Bot}
];
export default function App(){
  const [selected,setSelected]=useState("dev");
  const [sshTabs,setSshTabs]=useState<{id:string;alias:string}[]>([]);
  const [vaultUnlocked,setVaultUnlocked]=useState(false);
  // Native session events use a stable callback; its owner map stays fresh.
  const sshTabsRef=useRef(sshTabs);
  useEffect(()=>{sshTabsRef.current=sshTabs},[sshTabs]);
  const [activeSsh,setActiveSsh]=useState("");
  const [sshBusy,setSshBusy]=useState(false);
  const [loginOpen,setLoginOpen]=useState(false);
  const [tofuCandidate,setTofuCandidate]=useState<{alias:string;fingerprint:string}|null>(null);
  const [tofuBusy,setTofuBusy]=useState(false);
  const [tofuError,setTofuError]=useState("");
  const [jumpBusy,setJumpBusy]=useState(false);
  const [jumpError,setJumpError]=useState("");
  const saveJumpRoute=async(alias:string,gateway:string|null)=>{
    if(!alias||jumpBusy||sshTabs.some(t=>t.alias===alias))return;
    setJumpBusy(true);setJumpError("");
    try{
      await setHostJumpRoute(alias,gateway);
      setHosts(previous=>previous.map(host=>host.id===alias?{...host,jumpAlias:gateway}:host));
      setProbeError("");
    }catch(error){setJumpError("Could not configure jump gateway: "+String(error))}
    finally{setJumpBusy(false)}
  };

  const [loginPassword,setLoginPassword]=useState("");
  const [hostIdentityChoice,setHostIdentityChoice]=useState("");
  const [hostIdentityBusy,setHostIdentityBusy]=useState(false);
  const [rememberCredentials,setRememberCredentials]=useState(false);
  const [useSavedCredentials,setUseSavedCredentials]=useState(false);
  const [credentialWarning,setCredentialWarning]=useState("");
  const [accessOpen,setAccessOpen]=useState(false);
  const [accessPublicKey,setAccessPublicKey]=useState("");
  const [loginMode,setLoginMode]=useState<"key"|"password"|"key-password">("key-password");
  useEffect(()=>{
    const current=sshTabs.find(t=>t.id===activeSsh);
    if(current?.alias===selected)return;
    // The side panel must never operate on a different server than YOUR HOSTS.
    const matching=sshTabs.find(t=>t.alias===selected);
    setActiveSsh(matching?.id??"");
  },[sshTabs,activeSsh,selected]);
  const [tunnels,setTunnels]=useState<{session:string;localPort:number;targetHost:string;remotePort:number}[]>([]);
  // The backend owns active TCP listeners. Recover them after WebView reload
  // and when a previously existing native terminal session becomes visible.
  useEffect(()=>{
    if(!vaultUnlocked||!desktopAvailable()||sshTabs.length===0)return;
    let live=true;
    const ids=new Set(sshTabs.map(s=>s.id));
    void Promise.all(sshTabs.map(async session=>{
      try{
        const items=await listLocalForwards(session.id);
        return items.map(item=>({session:session.id,...item}));
      }catch{return [] as {session:string;localPort:number;targetHost:string;remotePort:number}[]}
    })).then(groups=>{
      if(!live)return;
      setTunnels(previous=>[
        ...previous.filter(t=>!ids.has(t.session)),...groups.flat()
      ]);
    });
    return()=>{live=false};
  },[vaultUnlocked,sshTabs]);
  const [sessionNotice,setSessionNotice]=useState<{alias:string;detail:string}|null>(null);
  const onSessionClosed=useCallback((id:string,detail?:string)=>{
    const alias=sshTabsRef.current.find(t=>t.id===id)?.alias||"";
    setSshTabs(t=>t.filter(x=>x.id!==id));
    setTunnels(t=>t.filter(x=>x.session!==id));
    setActiveSsh(current=>current===id?"":current);
    if(detail)setSessionNotice({alias,detail});
  },[]);
  const [hosts,setHosts]=useState<Host[]>(desktopAvailable()?[]:DEMO_HOSTS);
  useEffect(()=>{if(!vaultUnlocked){setSshTabs([]);setTunnels([]);setActiveSsh("");setSessionNotice(null)}},[vaultUnlocked]);
  // The native SSH session manager is authoritative. Reconcile after a remote
  // disconnect, missed Tauri close event, sleep/resume, or vault expiration.
  useEffect(()=>{
    if(!vaultUnlocked||!desktopAvailable())return;
    let mounted=true;
    const observedAtStart=new Set(sshTabs.map(t=>t.id));
    const verify=async()=>{
      try{
        const live=await listLiveSshSessions();
        if(!mounted)return;
        const liveIds=new Set(live.map(t=>t.id));
        const lost=sshTabs.filter(t=>!liveIds.has(t.id));
        setSshTabs(current=>{
          if(current.every(t=>!observedAtStart.has(t.id)||liveIds.has(t.id)))return current;
          return current.filter(t=>!observedAtStart.has(t.id)||liveIds.has(t.id));
        });
        if(lost.length){
          setTunnels(current=>current.filter(t=>!lost.some(s=>s.id===t.session)));
          setSessionNotice({alias:lost[0]?.alias||"",detail:"SSH session closed unexpectedly. Reconnect to restore Files, Docker and tunnels."});
        }
      }catch{/* A transient IPC error must not mark an authenticated session offline. */}
    };
    void verify();
    const timer=window.setInterval(()=>void verify(),12000);
    return ()=>{mounted=false;window.clearInterval(timer)};
  },[vaultUnlocked,sshTabs]);

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
  const attachIdentityToActiveHost=async()=>{
    if(!active.id||!hostIdentityChoice||hostIdentityBusy)return;
    if(!window.confirm("Use vault key "+hostIdentityChoice+" for "+active.id+"? The public key must already be installed on the SSH server for key login."))return;
    setHostIdentityBusy(true);setProbeError("");
    try{
      await setHostIdentity(active.id,hostIdentityChoice);
      setHosts(previous=>previous.map(h=>h.id===active.id
        ? {...h,identityAlias:hostIdentityChoice}:h));
      setLoginMode("key-password");
      setHostIdentityChoice("");
    }catch(error){setProbeError("Could not attach vault identity: "+String(error))}
    finally{setHostIdentityBusy(false)}
  };
  const closeLogin=()=>{
    if(sshBusy)return;
    setLoginOpen(false);setLoginPassword("");setLoginKeyPassphrase("");
  };
  useEffect(()=>{
    if(!vaultUnlocked){
      setLoginOpen(false);setLoginPassword("");setLoginKeyPassphrase("");
      setKeyPem("");setImportKeyPassphrase("");setVaultPassword("");
    }
  },[vaultUnlocked]);
  useEffect(()=>{if(desktopAvailable()){void vaultExists().then(setVaultPresent).catch(()=>setVaultPresent(false))}},[]);
  const lockVault=async()=>{await lockNativeVault();setVaultPassword("");setVaultUnlocked(false);setHosts([]);setIdentities([])};
  const unlockVault=async()=>{try{if(!vaultPresent){await initializeVault(vaultPassword);setVaultPresent(true)}await unlockNativeVault(vaultPassword);setVaultPassword("");const saved=await getHosts();setIdentities(await getIdentities());setHosts(saved.map((h,i)=>({id:h.alias,label:h.alias,address:h.hostname,user:h.username,port:h.port,group:"My hosts",fingerprint:h.hostKeyPinned,identityAlias:h.identityAlias,hasSavedCredentials:h.hasSavedCredentials,savedAuthMode:h.savedAuthMode,backupDirectory:h.backupDirectory,jumpAlias:h.jumpAlias})));setSelected(saved[0]?.alias||"");setVaultUnlocked(true);setVaultDialog(false);setError("")}catch(e){setError(String(e))}};
  // A WebView refresh can remount React without terminating the Rust process.
  // Recover ONLY an already-unlocked native vault and already-open sessions;
  // never auto-unlock persisted vault data or request secret material.
  useEffect(()=>{
    if(!desktopAvailable())return;
    let mounted=true;
    const restore=async()=>{
      try{
        if(!await vaultStatus())return;
        const [saved,identities,live]=await Promise.all([
          getHosts(),getIdentities(),listLiveSshSessions()
        ]);
        if(!mounted)return;
        const allowed=new Set(saved.map(h=>h.alias));
        const sessions=live.filter(t=>allowed.has(t.alias));
        setHosts(saved.map(h=>({
          id:h.alias,label:h.alias,address:h.hostname,user:h.username,port:h.port,
          group:"My hosts",fingerprint:h.hostKeyPinned,identityAlias:h.identityAlias,
          hasSavedCredentials:h.hasSavedCredentials,savedAuthMode:h.savedAuthMode,backupDirectory:h.backupDirectory,jumpAlias:h.jumpAlias
        })));
        setIdentities(identities);
        sshTabsRef.current=sessions;
        setSshTabs(sessions);
        setSelected(sessions[0]?.alias||saved[0]?.alias||"");
        setActiveSsh(sessions[0]?.id||"");
        setVaultUnlocked(true);
      }catch(error){
        if(mounted)setError("Could not restore the active Vault window: "+String(error));
      }
    };
    void restore();
    return()=>{mounted=false};
  },[]);
  useEffect(()=>{if(!desktopAvailable()||!vaultUnlocked)return;const id=window.setInterval(()=>{void vaultStatus().then(ok=>{if(!ok){setVaultUnlocked(false);setHosts([]);setSelected("");}}).catch(()=>{})},30000);return ()=>window.clearInterval(id)},[vaultUnlocked]);
  const [configImportOpen,setConfigImportOpen]=useState(false);
  const [configImportBusy,setConfigImportBusy]=useState(false);
  const [configImportError,setConfigImportError]=useState("");
  const [configImportResult,setConfigImportResult]=useState("");
  const [configCandidates,setConfigCandidates]=useState<(LocalSshConfigHost&{selected:boolean})[]>([]);
  const inspectLocalSshConfig=async()=>{
    if(!desktopAvailable()||!vaultUnlocked){setVaultDialog(true);return}
    setConfigImportOpen(true);setConfigImportBusy(true);
    setConfigImportError("");setConfigImportResult("");
    try{
      const existing=new Set(hosts.map(h=>h.id));
      const found=await discoverLocalSshConfigHosts();
      setConfigCandidates(found.filter(h=>!existing.has(h.alias))
        .map(h=>({...h,selected:!!h.username.trim()})));
      if(!found.length)setConfigImportResult("No direct hosts found in your local ~/.ssh/config. Add a host manually if needed.");
      else if(found.every(h=>existing.has(h.alias)))setConfigImportResult("All supported SSH config hosts are already in your vault.");
    }catch(error){setConfigImportError("Could not inspect local SSH config: "+String(error))}
    finally{setConfigImportBusy(false)}
  };
  const importSelectedConfigHosts=async()=>{
    if(configImportBusy)return;
    const selected=configCandidates.filter(h=>h.selected);
    if(selected.length===0)return;
    if(selected.some(h=>!h.username.trim()||/\\s/.test(h.username))){
      setConfigImportError("Specify a valid SSH username for each selected host.");return;
    }
    setConfigImportBusy(true);setConfigImportError("");setConfigImportResult("");
    const imported:string[]=[];
    const failures:string[]=[];
    for(const host of selected){
      try{
        await addHost({
          alias:host.alias,hostname:host.hostname,port:host.port,
          username:host.username.trim(),identityAlias:"",pinnedHostKey:null
        });
        imported.push(host.alias);
      }catch(error){failures.push(host.alias+": "+String(error))}
    }
    try{
      const saved=await getHosts();
      setHosts(saved.map(h=>({
        id:h.alias,label:h.alias,address:h.hostname,user:h.username,port:h.port,
        group:"My hosts",fingerprint:h.hostKeyPinned,identityAlias:h.identityAlias,
        hasSavedCredentials:h.hasSavedCredentials,savedAuthMode:h.savedAuthMode,backupDirectory:h.backupDirectory,jumpAlias:h.jumpAlias
      })));
      if(imported.length)setSelected(imported[0]);
    }catch(error){failures.push("Vault host list refresh: "+String(error))}
    setConfigCandidates(current=>current.filter(h=>!imported.includes(h.alias)));
    setConfigImportResult(imported.length?imported.length+" host(s) imported. Verify each server's fingerprint before your first connection.":"No hosts imported.");
    if(failures.length)setConfigImportError(failures.join("; "));
    setConfigImportBusy(false);
  };
  const [addOpen,setAddOpen]=useState(false);
  const [step,setStep]=useState(0);
  const [draft,setDraft]=useState<HostDraft>({label:"",hostname:"",port:22,username:"",auth:"password",identity:"",fingerprint:""});
  const [sftpPath,setSftpPath]=useState(".");
  const [sftpEntries,setSftpEntries]=useState<{session:string;path:string;items:SftpEntry[]}|null>(null);
  const [sftpBusy,setSftpBusy]=useState(false);
  const [sftpFilter,setSftpFilter]=useState("");
  const [sftpOrder,setSftpOrder]=useState<"folders"|"name"|"size"|"modified">(()=>loadPreferences().sftpSort);
  const visibleSftpEntries=useMemo(()=>{
    const needle=sftpFilter.toLocaleLowerCase().trim();
    const rows=(sftpEntries?.items??[]).filter(item=>!needle||item.name.toLocaleLowerCase().includes(needle));
    return [...rows].sort((a,b)=>{
      if(sftpOrder==="folders"&&a.isDir!==b.isDir)return a.isDir?-1:1;
      if(sftpOrder==="size"&&a.sizeBytes!==b.sizeBytes){
        return (b.sizeBytes??-1)-(a.sizeBytes??-1);
      }
      if(sftpOrder==="modified"&&a.modifiedAt!==b.modifiedAt){
        return (b.modifiedAt??-1)-(a.modifiedAt??-1);
      }
      return a.name.localeCompare(b.name,undefined,{numeric:true,sensitivity:"base"});
    });
  },[sftpEntries,sftpFilter,sftpOrder]);
  const [sftpError,setSftpError]=useState("");
  const [sftpNotice,setSftpNotice]=useState<{session:string;text:string}|null>(null);
  const [sftpPreview,setSftpPreview]=useState<{session:string;path:string;body:string;kind:"image"|"text"}|null>(null);
  const [sftpPreviewError,setSftpPreviewError]=useState<{session:string;path:string;message:string}|null>(null);
  const sftpPreviewRequestRef=useRef(0);
  const [sftpPreviewBusy,setSftpPreviewBusy]=useState(false);
  const transferSessionRef=useRef(activeSsh);
  transferSessionRef.current=activeSsh;
  const transferFolderRef=useRef({session:activeSsh,path:sftpEntries?.session===activeSsh?sftpEntries.path:sftpPath});
  transferFolderRef.current={session:activeSsh,path:sftpEntries?.session===activeSsh?sftpEntries.path:sftpPath};
  const transferQueue=useSftpTransferQueue((session,directory)=>{
    // A completed background upload must not navigate the user away from a
    // newer folder or an unrelated SSH host.
    void listSftpDirectory(session,directory).then(items=>{
      if(transferFolderRef.current.session===session&&transferFolderRef.current.path===directory){
        setSftpEntries({session,path:directory,items});
        setSftpPath(directory);
      }
    }).catch(error=>{
      if(transferFolderRef.current.session===session&&transferFolderRef.current.path===directory)
        setSftpError("Upload succeeded; could not refresh folder: "+String(error));
    });
  },sshTabs.map(tab=>tab.id));
  const sftpTransferBusy=transferQueue.active;
  const [vaultSnapshotHistory,setVaultSnapshotHistory]=useState<{
    session:string;directory:string;entries:SftpEntry[]
  }|null>(null);
  const [vaultHistoryBusy,setVaultHistoryBusy]=useState(false);
  const [vaultHistoryError,setVaultHistoryError]=useState("");
  const refreshVaultHistory=async()=>{
    const session=sshTabs.find(t=>t.id===activeSsh&&t.alias===selected);
    if(!session){setVaultHistoryError("Connect to the backup destination first.");return}
    if(vaultHistoryBusy)return;
    setVaultHistoryBusy(true);setVaultHistoryError("");
    const folder=sftpEntries?.session===session.id?sftpEntries.path:sftpPath;
    try{
      const entries=await listSftpDirectory(session.id,folder);
      const snapshots=entries.filter(item=>!item.isDir &&
        /^passh7-vault-[0-9]+-[0-9]+\.enc\.json$/.test(item.name))
        .sort((a,b)=>(b.modifiedAt??0)-(a.modifiedAt??0) ||
          b.name.localeCompare(a.name));
      setVaultSnapshotHistory({session:session.id,directory:folder,entries:snapshots});
    }catch(error){
      setVaultSnapshotHistory(null);
      setVaultHistoryError("Cannot list remote Vault backup history: "+String(error));
    }finally{setVaultHistoryBusy(false)}
  };
  const [vaultBackupBusy,setVaultBackupBusy]=useState(false);
  const [vaultBackupNotice,setVaultBackupNotice]=useState("");
  const [vaultBackupError,setVaultBackupError]=useState("");
  const [backupTargetsBusy,setBackupTargetsBusy]=useState(false);
  const saveBackupTarget=async(save:boolean)=>{
    if(!vaultUnlocked||backupTargetsBusy||!selected)return;
    const session=sshTabs.find(t=>t.id===activeSsh&&t.alias===selected);
    if(save&&!session){setVaultBackupError("Connect to this host before saving its remote backup directory.");return}
    const folder=sftpEntries&&sftpEntries.session===session?.id?sftpEntries.path:sftpPath;
    if(save&&!folder.trim()){setVaultBackupError("Select a nonempty remote backup directory.");return}
    setBackupTargetsBusy(true);setVaultBackupError("");setVaultBackupNotice("");
    try{
      await setHostBackupDirectory(selected,save?folder:null);
      setHosts(previous=>previous.map(host=>host.id===selected
        ? {...host,backupDirectory:save?folder:null}:host));
      setVaultBackupNotice(save
        ?"Saved "+selected+" backup directory: "+folder+". The directory must exist and be private."
        :"Removed "+selected+" from the saved backup destinations.");
    }catch(error){setVaultBackupError("Could not update backup destination: "+String(error))}
    finally{setBackupTargetsBusy(false)}
  };
  const backupAllConnected=async()=>{
    if(!vaultUnlocked||vaultBackupBusy)return;
    const targetHosts=hosts.filter(h=>!!h.backupDirectory);
    const connected=targetHosts.map(host=>({
      alias:host.id,directory:host.backupDirectory!,
      session:sshTabs.find(tab=>tab.alias===host.id)
    }));
    const available=connected.filter(t=>t.session);
    if(!available.length){
      setVaultBackupError("No configured backup destination has an active SSH session.");return;
    }
    const missing=connected.filter(t=>!t.session).map(t=>t.alias);
    const list=available.map(t=>t.alias+" → "+t.directory).join("\n");
    if(!window.confirm("Create one encrypted Vault snapshot and replicate that SAME generation to these "+available.length+" connected server(s)?\n\n"+list+
      (missing.length?"\n\nDisconnected configured targets (skipped): "+missing.join(", "):"")+
      "\n\nRemote administrators can copy encrypted backups for offline password guessing. Use only trusted servers and a strong master password. This is one-way backup replication, NOT conflict-free sync."))return;
    setVaultBackupBusy(true);setVaultBackupError("");setVaultBackupNotice("");
    let unsubscribe:(()=>void)|null=null;
    try{
      unsubscribe=await listen<VaultBackupBatchProgress>("passh7:vault-batch",event=>{
        const status=event.payload;
        setVaultBackupNotice("Vault replica "+status.index+"/"+status.total+": "+status.alias+" · "+status.stage);
      });
      // Native Rust reads and validates ciphertext ONCE before the first SFTP
      // upload, even if another Vault write occurs during the batch.
      const outcomes=await backupEncryptedVaultBatch(available.map(t=>({
        id:t.session!.id,alias:t.alias,directory:t.directory
      })));
      const success=outcomes.filter(o=>o.remotePath&&!o.error);
      const failure=outcomes.filter(o=>o.error);
      setVaultBackupNotice(success.length+" of "+available.length+" destinations have a verified copy of the SAME encrypted generation. "+
        (success.length?"Saved: "+success.map(o=>o.alias+": "+o.remotePath).join(" | "):"No successful backups."));
      if(missing.length||failure.length)setVaultBackupError(
        (failure.length?"Failed: "+failure.map(o=>o.alias+": "+o.error).join(" | ")+". ":"")+
        (missing.length?"Disconnected: "+missing.join(", ")+".":""));
    }catch(error){
      setVaultBackupError("Encrypted multi-server backup failed: "+String(error)+". Check remote history before retrying to avoid redundant copies.");
    }finally{
      unsubscribe?.();
      setVaultBackupBusy(false);
    }
  };
  const [vaultRestorePreview,setVaultRestorePreview]=useState<VaultRestorePreview|null>(null);
  const [vaultRestorePhrase,setVaultRestorePhrase]=useState("");
  const saveVaultBackup=async()=>{
    const session=sshTabs.find(t=>t.id===activeSsh&&t.alias===selected);
    if(!session||!vaultUnlocked){setVaultBackupError("Unlock Vault and connect to the backup destination first.");return}
    if(vaultBackupBusy)return;
    const folder=sftpEntries?.session===session.id?sftpEntries.path:sftpPath;
    if(!window.confirm("Create a NEW encrypted Vault backup on "+session.alias+" in "+folder+"?\n\nThe remote SSH account can read/copy the encrypted file. Secure the destination directory and keep your master password offline. The backup is NOT an automatic two-way sync."))return;
    setVaultBackupBusy(true);setVaultBackupError("");setVaultBackupNotice("");
    try{
      const result=await backupEncryptedVaultToSsh(session.id,folder);
      setVaultBackupNotice("Encrypted snapshot verified on "+session.alias+": "+result.remotePath+" ("+result.bytes+" bytes).");
      // Refresh the backup history independently of the normal file browser.
      try{
        const entries=await listSftpDirectory(session.id,folder);
        setVaultSnapshotHistory({
          session:session.id,directory:folder,
          entries:entries.filter(item=>!item.isDir&&
            /^passh7-vault-[0-9]+-[0-9]+\.enc\.json$/.test(item.name))
            .sort((a,b)=>(b.modifiedAt??0)-(a.modifiedAt??0) ||
              b.name.localeCompare(a.name))
        });
      }catch(historyError){
        setVaultHistoryError("Backup succeeded, but history refresh failed: "+String(historyError));
      }
      try{
        const entries=await listSftpDirectory(session.id,folder);
        setSftpEntries({session:session.id,path:folder,items:entries});
      }catch(error){
        setVaultBackupError("Backup succeeded, but directory refresh failed: "+String(error));
      }
    }catch(error){setVaultBackupError("Encrypted backup failed: "+String(error))}
    finally{setVaultBackupBusy(false)}
  };
  const exportVaultBackup=async()=>{
    if(vaultBackupBusy)return;
    setVaultBackupBusy(true);setVaultBackupError("");setVaultBackupNotice("");
    try{
      const result=await exportEncryptedVaultLocally();
      if(result)setVaultBackupNotice(result+". Store it offline in a safe place.");
    }catch(error){setVaultBackupError("Encrypted Vault export failed: "+String(error))}
    finally{setVaultBackupBusy(false)}
  };
  const inspectVaultRestore=async()=>{
    if(vaultBackupBusy)return;
    setVaultBackupBusy(true);setVaultBackupError("");setVaultBackupNotice("");
    setVaultRestorePhrase("");setVaultRestorePreview(null);
    try{
      const preview=await inspectEncryptedVaultBackup();
      if(preview)setVaultRestorePreview(preview);
    }catch(error){setVaultBackupError("Backup inspection failed: "+String(error))}
    finally{setVaultBackupBusy(false)}
  };
  const inspectRemoteVaultRestore=async(path:string)=>{
    const session=sshTabs.find(t=>t.id===activeSsh&&t.alias===selected);
    if(!session){setVaultBackupError("Connect to the remote Vault backup server first.");return}
    if(vaultBackupBusy)return;
    setVaultBackupBusy(true);setVaultBackupError("");setVaultBackupNotice("");
    setVaultRestorePhrase("");setVaultRestorePreview(null);
    try{
      const preview=await inspectRemoteEncryptedVaultBackup(session.id,path);
      setVaultRestorePreview(preview);
      setVaultBackupNotice("Remote encrypted backup authenticated and inspected: "+path+". Review the summary below before recovery.");
    }catch(error){setVaultBackupError("Remote backup inspection failed: "+String(error))}
    finally{setVaultBackupBusy(false)}
  };
  const commitVaultRestore=async()=>{
    if(!vaultRestorePreview||vaultRestorePreview.sameContents||vaultRestorePhrase!=="RESTORE"||vaultBackupBusy)return;
    if(!window.confirm("FINAL CONFIRMATION: Replace the entire local PaSSH7 Vault with the selected backup?\n\nExisting hosts, saved credentials and keys will be replaced. A separate encrypted copy of your previous Vault will be saved locally before replacement; live SSH sessions will close."))return;
    setVaultBackupBusy(true);setVaultBackupError("");setVaultBackupNotice("");
    try{
      await commitEncryptedVaultRestore(vaultRestorePreview.token);
      setSshTabs([]);setActiveSsh("");setTunnels([]);
      setSftpEntries(null);setSftpPreview(null);setDockerInventory(null);setAgentAvailability({});
      const [saved,keys]=await Promise.all([getHosts(),getIdentities()]);
      setHosts(saved.map(h=>({
        id:h.alias,label:h.alias,address:h.hostname,user:h.username,
        port:h.port,group:"My hosts",fingerprint:h.hostKeyPinned,
        identityAlias:h.identityAlias,hasSavedCredentials:h.hasSavedCredentials,
        savedAuthMode:h.savedAuthMode,backupDirectory:h.backupDirectory,jumpAlias:h.jumpAlias
      })));
      setIdentities(keys);setSelected(saved[0]?.alias||"");
      setVaultBackupNotice("Encrypted Vault restored. Previous local Vault preserved as an encrypted backup. Reconnect to your hosts.");
      setVaultRestorePreview(null);setVaultRestorePhrase("");
    }catch(error){setVaultBackupError("Vault restore was not completed: "+String(error))}
    finally{setVaultBackupBusy(false)}
  };

  const enqueueSftpTransfer=(direction:"upload"|"download",paths:string[]=[])=>{
    const session=sshTabs.find(t=>t.id===activeSsh&&t.alias===selected);
    if(!session){setSftpError("Select a connected SSH session before transferring files.");return}
    const targetDir=sftpEntries?.session===session.id?sftpEntries.path:sftpPath;
    const items=direction==="download"?paths.filter(Boolean):[targetDir];
    if(!items.length)return;
    if(preferences.confirmTransfer&&!window.confirm(direction==="upload"
      ?"Add a local-file upload to "+targetDir+" on "+session.alias+"?\n\nA system file picker opens when the job starts."
      :"Queue "+items.length+" remote file(s) from "+session.alias+"?\n\nEach download will open a native Save dialog. Existing local files will not be overwritten."))return;
    const count=transferQueue.enqueue({session:session.id,host:session.alias,direction,paths:items});
    if(count<items.length)setSftpError("Only "+count+" of "+items.length+" transfers were queued. Finish or clear existing jobs before adding more.");
    else setSftpError("");
  };
  const readSftpPreview=async(path:string)=>{
    const session=sshTabs.find(t=>t.id===activeSsh&&t.alias===selected);
    if(!session){setSftpError("Select an active SSH session first.");return}
    const request=++sftpPreviewRequestRef.current;
    const image=/\.(png|jpe?g|gif|webp)$/i.test(path);
    setSftpPreviewBusy(true);setSftpPreview(null);setSftpPreviewError(null);
    try{
      const body=image?await readSftpImage(session.id,path):await readSftpText(session.id,path);
      if(request===sftpPreviewRequestRef.current)
        setSftpPreview({session:session.id,path,body,kind:image?"image":"text"});
    }catch(error){
      if(request===sftpPreviewRequestRef.current)
        setSftpPreviewError({session:session.id,path,message:String(error)});
    }finally{
      if(request===sftpPreviewRequestRef.current)setSftpPreviewBusy(false);
    }
  };

  const [sftpMutationBusy,setSftpMutationBusy]=useState(false);
  const mutateRemoteSftp=async(operation:"mkdir"|"delete"|"rename",name:string,isDirectory=false,newName?:string)=>{
    const session=sshTabs.find(t=>t.id===activeSsh&&t.alias===selected);
    if(!session||sftpMutationBusy)return;
    const dir=sftpEntries?.session===session.id?sftpEntries.path:sftpPath;
    setSftpMutationBusy(true);setSftpError("");
    try{
      await mutateSftpFile(session.id,operation,dir,name,isDirectory,newName);
      const entries=await listSftpDirectory(session.id,dir);
      if(transferSessionRef.current===session.id){
        setSftpEntries({session:session.id,path:dir,items:entries});
        setSftpNotice({session:session.id,text:(operation==="mkdir"?"Created folder ":operation==="rename"?"Renamed ":"Deleted ")+name+(newName?" → "+newName:"")});
      }
    }catch(error){setSftpError("Remote "+operation+" failed: "+String(error))}
    finally{setSftpMutationBusy(false)}
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
  const refreshLocalForwarding=async()=>{
    const sessions=sshTabs.filter(s=>s.alias===selected);
    if(!sessions.length){setTunnelError("Connect to this host before inspecting local forwards.");return}
    setTunnelBusy(true);setTunnelError("");
    try{
      const results=await Promise.all(sessions.map(async session=>{
        const entries=await listLocalForwards(session.id);
        return entries.map(entry=>({session:session.id,...entry}));
      }));
      const ids=new Set(sessions.map(s=>s.id));
      setTunnels(current=>[...current.filter(t=>!ids.has(t.session)),...results.flat()]);
    }catch(error){setTunnelError("Cannot refresh native SSH forwards: "+String(error))}
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
  const [agentProbeBusy,setAgentProbeBusy]=useState(false);
  const [agentProbeError,setAgentProbeError]=useState("");
  const [agentAvailability,setAgentAvailability]=useState<Partial<Record<AgentKind,{
    session:string;installed:boolean;version:string|null
  }>>>({});
  const checkRemoteAgents=async()=>{
    const session=sshTabs.find(t=>t.id===activeSsh&&t.alias===selected);
    if(!session){setAgentProbeError("Connect to this host before checking installed tools.");return}
    if(agentProbeBusy)return;
    setAgentProbeBusy(true);setAgentProbeError("");
    const checks=await Promise.allSettled(AGENTS.map(a=>probeRemoteAgent(session.id,a.kind)));
    const discovered:Partial<Record<AgentKind,{session:string;installed:boolean;version:string|null}>>={};
    const failures:string[]=[];
    checks.forEach((check,index)=>{
      const kind=AGENTS[index].kind;
      if(check.status==="fulfilled"){
        discovered[kind]={session:session.id,...check.value};
      }else{
        failures.push(AGENTS[index].name+": "+String(check.reason));
      }
    });
    setAgentAvailability(prev=>({...prev,...discovered}));
    if(failures.length)setAgentProbeError(failures.join("; "));
    setAgentProbeBusy(false);
  };
  const launchRemoteAgent=async()=>{
    const session=sshTabs.find(t=>t.id===activeSsh&&t.alias===selected);
    if(!session){setAgentStatus("Connect to this host first.");return}
    const cli:Record<AgentKind,string>={codex:"codex",claude:"claude",opencode:"opencode"};
    const name=AGENTS.find(a=>a.kind===agent)?.name||agent;
    // Exec probes can miss binaries loaded by custom interactive shell startup.
    // Never block an explicit user-triggered interactive launch on a probe.
    if(!window.confirm("Run "+name+" on "+session.alias+" in the existing SSH terminal? This CLI runs with your full SSH account privileges, NOT in a PaSSH7 sandbox. It must already be installed and configured on the remote host."))return;
    try{
      await writeSshSession(session.id,cli[agent]+"\r");
      setAgentStatus("Launch command sent to the SSH terminal. Check terminal output to confirm "+name+" started.");
      setPanel("terminal");
    }catch(e){setAgentStatus("Could not launch agent: "+String(e))}
  };
  const [error,setError]=useState("");
  const [query,setQuery]=useState("");
  const [panel,setPanel]=useState<Panel>(()=>{
    try{const value=localStorage.getItem("passh7.workspace.v1");return ["connections","terminal","agent","files","docker","snippets","ports","settings"].includes(value||"")?value as Panel:"connections"}catch{return "agent"}
  });
  const [preferences,setPreferences]=useState<AppPreferences>(loadPreferences);
  const updatePreferences=(value:AppPreferences)=>{
    setPreferences(value);savePreferences(value);setSftpOrder(value.sftpSort);setTheme(value.theme);
  };
  const updatePaneSize=(key:keyof PaneSizes,value:number)=>{
    // Read latest non-secret preferences to avoid a stale closure clobbering
    // another setting while the user drags or switches workspaces.
    setPreferences(current=>{
      const updated={...current,paneSizes:{...current.paneSizes,[key]:value}};
      savePreferences(updated);
      return updated;
    });
  };
  useEffect(()=>{
    try{if(preferences.rememberWorkspace)localStorage.setItem("passh7.workspace.v1",panel)}catch{/* local UI preference is best effort */}
  },[panel,preferences.rememberWorkspace]);
  const [dockerInventory,setDockerInventory]=useState<{session:string;items:Array<{ID?:string;Names?:string;Image?:string;State?:string;Status?:string;Ports?:string}>}|null>(null);
  const dockerContextRef=useRef({session:activeSsh,host:selected});
  dockerContextRef.current={session:activeSsh,host:selected};
  const dockerRefreshRequestRef=useRef(0);
  const dockerCurrent=(session:string,host:string)=>dockerContextRef.current.session===session&&dockerContextRef.current.host===host;
  const [dockerBusy,setDockerBusy]=useState(false);
  const [dockerStats,setDockerStats]=useState<{session:string;items:DockerRuntimeStats[]}|null>(null);
  const [dockerStatsError,setDockerStatsError]=useState<{session:string;message:string}|null>(null);
  const [dockerDetails,setDockerDetails]=useState<{session:string;containerId:string;data:DockerDetails}|null>(null);
  const [dockerDetailsError,setDockerDetailsError]=useState<{session:string;containerId:string;message:string}|null>(null);
  const dockerDetailsRequestRef=useRef(0);
  const readDockerDetails=async(containerId:string)=>{
    const session=sshTabs.find(t=>t.id===activeSsh&&t.alias===selected);
    if(!session)return;
    const request=++dockerDetailsRequestRef.current;
    const host=session.alias;
    setDockerDetailsError(null);setDockerDetails(null);
    try{
      const data=await inspectDockerContainer(session.id,containerId);
      if(request===dockerDetailsRequestRef.current&&dockerCurrent(session.id,host))
        setDockerDetails({session:session.id,containerId,data});
    }catch(error){
      if(request===dockerDetailsRequestRef.current&&dockerCurrent(session.id,host))
        setDockerDetailsError({session:session.id,containerId,message:String(error)});
    }
  };
  const dockerStatsRequestRef=useRef(0);
  const [dockerLogsBusy,setDockerLogsBusy]=useState(false);
  const [dockerActionBusy,setDockerActionBusy]=useState("");
  const [dockerActionStatus,setDockerActionStatus]=useState<{session:string;text:string}|null>(null);
  const [dockerLogs,setDockerLogs]=useState<{session:string;containerId:string;containerName:string;text:string}|null>(null);
  const [dockerLogsError,setDockerLogsError]=useState<{session:string;message:string}|null>(null);
  const dockerLogsRequestRef=useRef(0);
  useEffect(()=>{
    dockerLogsRequestRef.current++;
    dockerDetailsRequestRef.current++;
    dockerStatsRequestRef.current++;
    dockerRefreshRequestRef.current++;
    setDockerLogsBusy(false);setDockerBusy(false);setDockerStatsError(null);
    setDockerDetailsError(null);setDockerError("");setDockerLiveStatus("off");
  },[activeSsh,selected]);
  const [dockerLiveStatus,setDockerLiveStatus]=useState<"off"|"connecting"|"streaming"|"closed"|"error">("off");
  const [dockerError,setDockerError]=useState("");
  const runDockerAction=async(containerId:string,containerName:string,action:"start"|"stop"|"restart")=>{
    const session=sshTabs.find(t=>t.id===activeSsh&&t.alias===selected);
    if(!session){setDockerError("Connect to this host before managing containers.");return}
    const prompt=action==="stop"?"This will interrupt the container and its services.":"This changes the state of the remote container.";
    if(!window.confirm(action.toUpperCase()+" "+containerName+" on "+session.alias+"?\n"+prompt+"\nAction runs with your SSH user's Docker privileges."))return;
    setDockerActionBusy(containerId);setDockerError("");setDockerActionStatus(null);
    try{
      const result=await controlDockerContainer(session.id,containerId,action);
      if(dockerCurrent(session.id,session.alias))setDockerActionStatus({session:session.id,text:result});
      try{
        const raw=await listDockerContainers(session.id);
        const items=raw.split(/\r?\n/).map(line=>line.trim()).filter(Boolean)
          .map(line=>JSON.parse(line) as {ID?:string;Names?:string;Image?:string;State?:string;Status?:string;Ports?:string});
        if(dockerCurrent(session.id,session.alias))setDockerInventory({session:session.id,items});
      }catch(refreshError){
        if(dockerCurrent(session.id,session.alias))setDockerError("Docker "+action+" succeeded, but refreshing container state failed: "+String(refreshError));
      }
    }catch(error){if(dockerCurrent(session.id,session.alias))setDockerError("Docker "+action+" failed: "+String(error))}
    finally{setDockerActionBusy("")}
  };
  const openDockerShell=async(containerId:string,containerName:string)=>{
    const session=sshTabs.find(t=>t.id===activeSsh&&t.alias===selected);
    if(!session){setDockerError("Select a connected SSH terminal first.");return}
    if(!/^[a-f0-9]{12,64}$/i.test(containerId)){
      setDockerError("Invalid container ID; refresh Docker inventory.");return;
    }
    if(!window.confirm("Open an interactive sh in "+containerName+" on "+session.alias+"?\n\n"+
      "This executes as your remote SSH account with Docker privileges. The command "+
      "will be sent to the current terminal; confirm it is at a shell prompt."))return;
    try{
      await writeSshSession(session.id,"docker exec -it "+containerId+" sh\r");
      setDockerError("");setPanel("terminal");
    }catch(error){setDockerError("Could not start Docker shell: "+String(error))}
  };
  const viewDockerLogs=async(containerId:string,containerName:string)=>{
    const session=sshTabs.find(t=>t.id===activeSsh&&t.alias===selected);
    if(!session){setDockerError("Select a connected SSH session to read Docker logs.");return}
    const request=++dockerLogsRequestRef.current;
    setDockerLogsBusy(true);setDockerLogsError(null);setDockerError("");
    // A new selection must never display stale log data from another container.
    setDockerLogs(previous=>previous?.session===session.id&&previous.containerId===containerId?previous:null);
    try{
      const text=await readDockerLogs(session.id,containerId,preferences.dockerTail);
      if(request===dockerLogsRequestRef.current)
        setDockerLogs({session:session.id,containerId,containerName,text});
    }catch(e){
      if(request===dockerLogsRequestRef.current)
        setDockerLogsError({session:session.id,message:"Could not read Docker logs: "+String(e)});
    }finally{
      if(request===dockerLogsRequestRef.current)setDockerLogsBusy(false);
    }
  };
  const refreshDocker=async()=>{
    const session=sshTabs.find(t=>t.id===activeSsh&&t.alias===selected);
    if(!session){setDockerError("Connect to and select an SSH session for this host.");return}
    const id=session.id,host=session.alias,request=++dockerRefreshRequestRef.current;
    setDockerBusy(true);setDockerError("");setDockerStatsError(null);
    const statsRequest=++dockerStatsRequestRef.current;
    // CPU/RAM sampling is independent of inventory and bound to the same host.
    void listDockerStats(id).then(items=>{
      if(statsRequest===dockerStatsRequestRef.current&&dockerCurrent(id,host))setDockerStats({session:id,items});
    }).catch(error=>{
      if(statsRequest===dockerStatsRequestRef.current&&dockerCurrent(id,host)){
        setDockerStats({session:id,items:[]});
        setDockerStatsError({session:id,message:String(error)});
      }
    });
    try{
      const raw=await listDockerContainers(id);
      const items=raw.split(/\r?\n/).map(line=>line.trim()).filter(Boolean).map(line=>JSON.parse(line) as {ID?:string;Names?:string;Image?:string;State?:string;Status?:string;Ports?:string});
      if(request===dockerRefreshRequestRef.current&&dockerCurrent(id,host))
        setDockerInventory({session:id,items});
    }catch(error){
      if(request===dockerRefreshRequestRef.current&&dockerCurrent(id,host))setDockerError(String(error));
    }finally{
      if(request===dockerRefreshRequestRef.current&&dockerCurrent(id,host))setDockerBusy(false);
    }
  };
  // Opening Docker or switching hosts should load the current server immediately.
  // Auto-refresh is an optional subsequent 15-second poll, not a prerequisite.
  useEffect(()=>{
    if(panel==="docker"&&vaultUnlocked&&activeSsh&&sshTabs.some(tab=>tab.id===activeSsh&&tab.alias===selected))
      void refreshDocker();
  },[panel,activeSsh,selected,vaultUnlocked]);
  useEffect(()=>{
    if(panel!=="docker"||!preferences.dockerAutoRefresh||!vaultUnlocked||!activeSsh)return;
    const timer=window.setInterval(()=>{void refreshDocker()},15000);
    return ()=>window.clearInterval(timer);
  },[panel,activeSsh,selected,vaultUnlocked,preferences.dockerAutoRefresh]);
  // A real dedicated SSH exec channel follows Docker output. Subscribe to
  // native events before requesting the stream so its first bytes are never
  // dropped. Changing host, container, workspace or Follow closes the channel.
  useEffect(()=>{
    if(panel!=="docker"||!preferences.dockerFollowLogs||!dockerLogs?.containerId||
       dockerLogs.session!==activeSsh){
      setDockerLiveStatus("off");
      return;
    }
    const sessionId=activeSsh;
    const containerId=dockerLogs.containerId;
    let disposed=false;
    let finished=false;
    let streamId="";
    let unsubscribe:(()=>void)|undefined;
    let flushTimer:number|undefined;
    let pending="";
    const decoder=new TextDecoder("utf-8");
    setDockerLiveStatus("connecting");
    const flush=()=>{
      if(flushTimer!==undefined){window.clearTimeout(flushTimer);flushTimer=undefined;}
      if(!pending||disposed)return;
      const chunk=pending;pending="";
      setDockerLogs(previous=>previous?.session===sessionId&&previous.containerId===containerId
        ?{...previous,text:(previous.text+chunk).slice(-1_500_000)}:previous);
    };
    void (async()=>{
      unsubscribe=await listen<DockerLogEvent>("passh7:docker-log",event=>{
        if(disposed)return;
        const data=event.payload;
        if(data.sessionId!==sessionId||data.containerId!==containerId||
           (streamId&&data.streamId!==streamId))return;
        if(data.kind==="data"&&data.data){
          const binary=atob(data.data);
          const bytes=new Uint8Array(binary.length);
          for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
          pending+=decoder.decode(bytes,{stream:true});
          if(pending.length>64*1024)flush();
          else if(flushTimer===undefined)flushTimer=window.setTimeout(flush,80);
        }else{
          finished=true;
          pending+=decoder.decode();
          flush();
          if(data.kind==="error"){
            setDockerLiveStatus("error");
            setDockerLogsError({session:sessionId,message:data.detail||"Docker live log channel failed"});
          }else setDockerLiveStatus("closed");
        }
      });
      if(disposed){unsubscribe();unsubscribe=undefined;return;}
      const opened=await startDockerLogStream(sessionId,containerId,0);
      streamId=opened;
      if(disposed){
        void stopDockerLogStream(sessionId,opened).catch(()=>{});
      }else if(!finished)setDockerLiveStatus("streaming");
    })().catch(error=>{
      if(!disposed){
        setDockerLiveStatus("error");
        setDockerLogsError({session:sessionId,message:"Could not follow Docker logs: "+String(error)});
      }
    });
    return ()=>{
      // Suppress event handlers before tearing down the async listener.
      // Rust also closes every follow channel when the owning SSH session ends.
      disposed=true;
      if(flushTimer!==undefined)window.clearTimeout(flushTimer);
      unsubscribe?.();
      if(streamId)void stopDockerLogStream(sessionId,streamId).catch(()=>{});
    };
  },[panel,activeSsh,preferences.dockerFollowLogs,dockerLogs?.session,dockerLogs?.containerId]);
  // Lazy-load contextual tools on the selected host. Do not show an empty panel
  // when a usable authenticated SSH session is already available.
  useEffect(()=>{
    const session=sshTabs.find(t=>t.id===activeSsh&&t.alias===selected);
    if(!session)return;
    if(panel==="files"&&sftpEntries?.session!==session.id){void browseSftp(".")}
  },[panel,activeSsh,selected]);
  const confirmRemove=async()=>{
    if(!deleteTarget || !desktopAvailable() || !vaultUnlocked)return;
    try{
      if(deleteTarget.kind==="host"){
        await removeHost(deleteTarget.alias);
        setSshTabs(t=>t.filter(session=>session.alias!==deleteTarget.alias));
        setTunnels(t=>t.filter(tunnel=>!sshTabs.some(session=>session.alias===deleteTarget.alias&&session.id===tunnel.session)));
        const saved=await getHosts();
        setHosts(saved.map(h=>({id:h.alias,label:h.alias,address:h.hostname,user:h.username,port:h.port,group:"My hosts",fingerprint:h.hostKeyPinned,identityAlias:h.identityAlias,hasSavedCredentials:h.hasSavedCredentials,savedAuthMode:h.savedAuthMode,backupDirectory:h.backupDirectory,jumpAlias:h.jumpAlias})));
        setSelected(current=>current===deleteTarget.alias?(saved[0]?.alias||""):current);
      } else {
        await removeIdentity(deleteTarget.alias);
        setIdentities(await getIdentities());
      }
      setDeleteTarget(null);setError("");
    }catch(e){setError(String(e))}
  };
  const sidebar=preferences.sidebarExpanded;
  const toggleSidebar=()=>updatePreferences({...preferences,sidebarExpanded:!sidebar});
  const [commandOpen,setCommandOpen]=useState(false);

  const [theme,setTheme]=useState<"dark"|"light">(()=>loadPreferences().theme);
  const [buildInfo,setBuildInfo]=useState<BuildInfo|null>(null);
  useEffect(()=>{void getBuildInfo().then(setBuildInfo).catch(()=>setBuildInfo(null))},[]);
  useEffect(()=>{setProbeResult(null);setProbeError("");setAuthResult("");setTofuCandidate(null)},[selected,vaultUnlocked]);
  const probeActive=async()=>{if(!desktopAvailable()||!vaultUnlocked||!selected)return;if(hosts.find(h=>h.id===selected)?.jumpAlias){setProbeError("Direct TCP probe is not applicable to a private target. Connect to the gateway and use Connect instead.");return}setProbeBusy(true);setProbeError("");setProbeResult(null);try{const data=await probeSshHost(selected);setProbeResult({alias:selected,data})}catch(e){setProbeError(String(e))}finally{setProbeBusy(false)}};
  const authenticateActive=async()=>{if(!desktopAvailable()||!vaultUnlocked||!selected)return;setAuthBusy(true);setAuthResult("");setProbeError("");try{const result=await authenticateSshHost(selected);setAuthResult(`Verified SSH login: ${result.username} @ ${result.hostAlias}. Test connection closed.`)}catch(e){setProbeError(String(e))}finally{setAuthBusy(false)}};
  const connectionHelp=(message:string):{title:string;checks:string[]}=>{
    const raw=message.replace(/^Error:\s*/, "");
    const code=raw.match(/SSH_[A-Z_]+/)?.[0] || "";
    const known:Record<string,{title:string;checks:string[]}>={
      SSH_PUBLICKEY_REJECTED:{title:"Server rejected the offered SSH public key",checks:["Verify the selected vault identity and remote username.","On Windows, an administrator normally uses C:\\ProgramData\\ssh\\administrators_authorized_keys; other users normally use their own .ssh/authorized_keys.","Check the server's SSHD logs and file permissions. Only the server can explain the exact rejection."]},
      SSH_KEY_UNLOCK:{title:"PaSSH7 could not unlock the private key",checks:["Enter the private-key passphrase (different from your Windows password).","Confirm that the selected identity contains the intended private key."]},
      SSH_PARTIAL_AUTH:{title:"Key accepted — another sign-in factor is required",checks:["Choose SSH key + Windows password.","Enter the key passphrase, if encrypted, and the Windows account password in their separate fields."]},
      SSH_SECOND_FACTOR_REQUIRED:{title:"Key accepted — Windows password needed",checks:["Select SSH key + account password and enter the account password."]},
      SSH_SECOND_FACTOR_REJECTED:{title:"Key accepted — account password rejected",checks:["Verify the Windows account password for the selected username.","Check Windows account restrictions and SSHD authentication logs if the password is correct."]},
      SSH_SECOND_FACTOR_ERROR:{title:"Key accepted — password step failed",checks:["Check the account password and whether the SSH server disconnected during the second factor."]},
      SSH_PASSWORD_REJECTED:{title:"SSH password authentication was rejected",checks:["Verify the username and password.","If SSHD requires publickey,password, select SSH key + Windows password instead."]},
      SSH_PASSWORD_REQUIRED:{title:"Windows password is required",checks:["Enter the SSH account password before connecting."]},
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
      setSshTabs(t=>[...t,opened]);setActiveSsh(opened.id);setLoginOpen(false);setSessionNotice(null);
      if(rememberCredentials&&(!useSavedCredentials||!!accountPassword||!!loginKeyPassphrase)){
        try{
          await saveHostCredentials(selected,loginMode,accountPassword||"",loginKeyPassphrase,useSavedCredentials);
          const saved=await getHosts();
          setHosts(saved.map(h=>({id:h.alias,label:h.alias,address:h.hostname,user:h.username,port:h.port,group:"My hosts",fingerprint:h.hostKeyPinned,identityAlias:h.identityAlias,hasSavedCredentials:h.hasSavedCredentials,savedAuthMode:h.savedAuthMode,backupDirectory:h.backupDirectory,jumpAlias:h.jumpAlias})));
        }catch(e){setCredentialWarning("Connected, but could not save credentials: "+String(e))}
      }
    }catch(e){setProbeError(String(e))}
    finally{setLoginPassword("");setLoginKeyPassphrase("");setSshBusy(false)}
  };
  const quickConnect=async(alias:string,mode:"key"|"password"|"key-password")=>{
    if(!desktopAvailable()||!vaultUnlocked||sshBusy)return;
    setSshBusy(true);setProbeError("");setCredentialWarning("");
    try{
      const opened=await openSshSession(alias,100,30,undefined,mode,undefined,true);
      setSshTabs(v=>[...v,opened]);setActiveSsh(opened.id);setLoginOpen(false);setSessionNotice(null);
    }catch(e){
      setLoginMode(mode);setUseSavedCredentials(true);setRememberCredentials(true);
      setProbeError(String(e));setLoginOpen(true);
    }finally{setSshBusy(false)}
  };
  const connectFromConnections=async(alias:string)=>{
    const host=hosts.find(h=>h.id===alias);
    if(!host)return;
    setSelected(alias);setPanel("terminal");setProbeError("");setTofuError("");
    if(!desktopAvailable()||!vaultUnlocked){setVaultDialog(true);return}
    if(!host.fingerprint){
      setTofuBusy(true);
      try{
        const key=host.jumpAlias?await discoverSshHostKeyVia(alias):await discoverSshHostKey(alias);
        setTofuCandidate({alias,fingerprint:key.fingerprint});
      }catch(error){setProbeError(String(error))}
      finally{setTofuBusy(false)}
      return;
    }
    const mode=(host.savedAuthMode as "key"|"password"|"key-password")||(host.identityAlias?"key-password":"password");
    if(host.hasSavedCredentials){await quickConnect(alias,mode);return}
    setLoginPassword("");setLoginKeyPassphrase("");setHostIdentityChoice("");
    setLoginMode(mode);setRememberCredentials(false);setUseSavedCredentials(false);setLoginOpen(true);
  };
  const executeSnippet=async(command:string)=>{
    const session=sshTabs.find(t=>t.id===activeSsh&&t.alias===selected);
    if(!session){setProbeError("Select an authenticated SSH session before running a snippet.");setPanel("terminal");return}
    if(!command||command.length>512||/[\r\n]/.test(command))return;
    if(!window.confirm("Execute this command as the remote SSH user on "+session.alias+"?\n\n"+command+
      "\n\nPaSSH7 does not sandbox commands. Confirm the terminal is at a shell prompt."))return;
    try{await writeSshSession(session.id,command+"\r");setPanel("terminal")}
    catch(error){setProbeError("Snippet could not be sent: "+String(error));setPanel("terminal")}
  };
  const reconnectNotice=(alias:string)=>{
    const host=hosts.find(h=>h.id===alias);
    if(!host||!vaultUnlocked)return;
    setSelected(alias);
    setSessionNotice(null);
    const mode=(host.savedAuthMode as "key"|"password"|"key-password")||(host.identityAlias?"key-password":"password");
    if(host.hasSavedCredentials){
      void quickConnect(alias,mode);
    }else{
      setLoginMode(mode);setUseSavedCredentials(false);setRememberCredentials(false);
      setLoginPassword("");setLoginKeyPassphrase("");setProbeError("");
      setLoginOpen(true);
    }
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
  const context="Host: "+active.label+"\nTarget: "+active.user+"@"+active.address+"\nConnection: "+(connected?`connected (${activeConnections} SSH session${activeConnections===1?"":"s"})`:"disconnected")+"\nVault: "+(vaultUnlocked?"unlocked":"locked")+"\nPermissions: "+(connected?"Remote SSH account privileges (not sandboxed)":"No active SSH account")+"\nSelected resources: none"+"\nSSH route: "+(active.jumpAlias?"via "+active.jumpAlias+" (gateway LAN → "+active.address+":"+active.port+")":"direct");
  return <div className={"shell "+theme+(preferences.density==="compact"?" compact":"")} onKeyDown={e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="k"){e.preventDefault();setCommandOpen(v=>!v)}if(e.key==="Escape"){setCommandOpen(false);}}}>
    <header className="topbar">
      <div className="brand"><div className="brandicon"><TerminalSquare size={16}/></div><strong>PaSSH7</strong></div>
      <div className="topHost">
        <button type="button" className="hostSelectIcon" title={sidebar?"Collapse host sidebar":"Expand host sidebar"} aria-label={sidebar?"Collapse host sidebar":"Expand host sidebar"} onClick={()=>toggleSidebar()}><ChevronDown size={17}/></button>
        <span className={"hostDot "+(connected?"connected":active.fingerprint?"trusted":"untrusted")} title={connected?"SSH connected":active.fingerprint?"Host-key pinned, disconnected":"Not connected"}/>
        <div className="topHostIdentity"><strong>{active.label}</strong><small>{active.id?active.user+" · "+active.address+" · SSH (port "+active.port+")"+(active.jumpAlias?" · via "+active.jumpAlias:""):"Choose a saved SSH host"}</small></div>
        <span className="hostStatusLabel">{connected?activeConnections+" live session"+(activeConnections===1?"":"s"):active.fingerprint?"Verified key · Offline":"Disconnected"}</span>
      </div>
      <div className="topactions">
        <button type="button" className="topQuickButton" disabled={!active.id} onClick={()=>setPanel("terminal")}><TerminalSquare size={15}/><span>Open in Terminal</span></button>
        <button type="button" className="topQuickButton topDisconnect" disabled={!connected||sshBusy} title="Disconnect the selected host's active SSH session" onClick={()=>{const session=sshTabs.find(t=>t.id===activeSsh&&t.alias===active.id)||sshTabs.find(t=>t.alias===active.id);if(session)void closeInteractive(session.id)}}><X size={15}/><span>Disconnect</span></button>
        <button type="button" className="lock" onClick={()=>{if(!desktopAvailable())return;if(vaultUnlocked){void lockVault()}else setVaultDialog(true)}}><LockKeyhole size={14}/><span>{vaultUnlocked?"Lock Vault":"Unlock Vault"}</span></button>
        <button type="button" className="iconbtn" title="Quick switch (Ctrl+K)" aria-label="Quick switch" onClick={()=>setCommandOpen(true)}><Command size={17}/></button>
      </div>
    </header>
    <div className={"workspace "+(["connections","snippets","ports","files","docker","agent","settings"].includes(panel)?"workspaceFull":"")}>
      {sidebar&&<aside className="sidebar"><nav className="workspaceNav" aria-label="Workspaces">
{([["connections","Connections",Server],["terminal","Terminal",TerminalSquare],["files","Remote Files",FolderClosed],["docker","Docker",Container],["ports","Port Forwarding",Activity],["snippets","Snippets",FileText],["agent","AI Agents",Bot],["settings","Settings",Settings2]] as const).map(([id,label,Icon])=>
<button type="button" key={id} className={panel===id?"active":""} onClick={()=>setPanel(id)}><Icon size={16}/>{label}</button>)}
</nav><div className="sectionHeading"><span>YOUR HOSTS</span><button className="iconbtn" title="Import hosts from local OpenSSH config" aria-label="Import SSH config" onClick={()=>void inspectLocalSshConfig()}><FileText size={15}/></button><button className="iconbtn" title="Add host" aria-label="Add host" onClick={()=>{if(desktopAvailable()&&!vaultUnlocked){setVaultDialog(true);return}setAddOpen(true);setStep(0);setError("")}}><Plus size={16}/></button></div><label className="search"><Search size={15}/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search hosts" aria-label="Search hosts"/><span>⌘ K</span></label>
        {[...new Set(hosts.map(h=>h.group))].map(group=><section key={group}><div className="groupLabel"><ChevronDown size={13}/>{group}</div>{filtered.filter(h=>h.group===group).map(h=><button key={h.id} className={"host "+(selected===h.id?"selected":"")} title={h.user+"@"+h.address+":"+h.port+(h.jumpAlias?" via "+h.jumpAlias:"")} onClick={()=>setSelected(h.id)}><Server size={16}/><span className="hostText"><strong>{h.label}</strong><small>{h.user}@{h.address}{h.jumpAlias?" · via "+h.jumpAlias:""}</small></span><span className={"hostDot "+(sshTabs.some(t=>t.alias===h.id)?"connected":h.fingerprint?"trusted":"untrusted")} title={sshTabs.some(t=>t.alias===h.id)?"SSH connected ("+sshTabs.filter(t=>t.alias===h.id).length+" session(s))":h.fingerprint?"Host key pinned; SSH disconnected":"SSH disconnected; host key not pinned"}/></button>)}</section>)}
        {!filtered.length&&<div className="emptySearch"><p>{!vaultUnlocked&&desktopAvailable()?"Unlock your vault to access saved hosts.":hosts.length===0?"No saved SSH hosts yet. Add your first server to get started.":query.trim()?"No hosts match your search.":"No matching hosts."}</p>{desktopAvailable()&&vaultUnlocked&&hosts.length===0&&<button type="button" className="contextAction" onClick={()=>{setAddOpen(true);setStep(0);setError("")}}><Plus size={14}/> Add your first host</button>}{desktopAvailable()&&!vaultUnlocked&&<button type="button" className="contextAction" onClick={()=>setVaultDialog(true)}><LockKeyhole size={14}/> Unlock vault</button>}</div>}
        {desktopAvailable()&&vaultUnlocked&&<section className="identityManage"><div className="groupLabel">SSH IDENTITIES</div>{identities.map(name=><div className="identityManageRow" key={name}><KeyRound size={14}/><span title={name}>{name}</span><button className="iconbtn" title={"Show public key "+name} aria-label={"Show public key "+name} onClick={async()=>{try{const pub=await getPublicIdentity(name);setGeneratedKey(pub);setKeyDialog(true);setError("")}catch(e){setError(String(e))}}}><KeyRound size={14}/></button><button className="iconbtn" title={"Remove identity "+name} aria-label={"Remove identity "+name} onClick={()=>{setError("");setDeleteTarget({kind:"identity",alias:name})}}><Trash2 size={14}/></button></div>)}{!identities.length&&<p className="emptySearch">No keys imported</p>}</section>}
        <div className="sidebottom"><span><ShieldCheck size={15}/> Local-first workspace</span><small>{desktopAvailable()?(vaultUnlocked?`${hosts.length} saved host${hosts.length===1?"":"s"} in encrypted vault`:"Unlock vault to view saved hosts"):"Example hosts only. No real credentials."}</small></div></aside>}
      <main className="main"><div className="sessionTabs"><button className="iconbtn" aria-label={sidebar?"Hide host sidebar":"Show host sidebar"} onClick={()=>toggleSidebar()}><Monitor size={16}/></button><div className="sessionActive"><TerminalSquare size={15}/>{active.label}<span className="tabdot" style={{background:connected?"#22c55e":undefined}}/></div><div className="tabSpacer"/><span className="unavailable" style={{color:connected?"#22c55e":undefined}}>{connected?`Connected · ${activeConnections} session${activeConnections===1?"":"s"}`:"Not connected"}</span></div>
        <div className="identity"><div><div className="eyebrow">WORKSPACE / {active.group.toUpperCase()}</div><h1>{active.label}</h1><div className="identityMeta"><span><Server size={14}/>{active.user}@{active.address}</span><span>Port {active.port ?? 22}</span><span title={active.jumpAlias?"Internal network through an already connected SSH gateway":"Direct SSH connection"}>{active.jumpAlias?"Via "+active.jumpAlias:"Direct"}</span><span title={active.identityAlias?"This host has a vault SSH key associated":"No SSH key is required for password login"}>{active.identityAlias?"Vault key: "+active.identityAlias:"Password SSH profile"}</span><span className={active.fingerprint?"pin ok":"pin warn"}><ShieldCheck size={14}/>{active.fingerprint?"Host key saved":"Host key unpinned"}</span></div></div><div className="jumpRouteConfig">
<label htmlFor="jump-host-selector">SSH route</label>
<select id="jump-host-selector" aria-label="Jump gateway" value={active.jumpAlias||""} disabled={!vaultUnlocked||jumpBusy||sshBusy||activeConnections>0}
  onChange={e=>void saveJumpRoute(active.id,e.target.value||null)}>
<option value="">Direct connection</option>
{hosts.filter(h=>h.id!==active.id&&h.fingerprint&&!h.jumpAlias).map(h=>
<option value={h.id} key={h.id}>Via {h.label}{sshTabs.some(t=>t.alias===h.id)?" · connected":" · connect first"}</option>)}
</select>
{active.jumpAlias&&<small>Route: this computer → {active.jumpAlias} (SSH) → {active.address}:{active.port} (SSH). The gateway must be connected first. Target SSH keys never leave this PC.</small>}
{active.jumpAlias&&!sshTabs.some(t=>t.alias===active.jumpAlias)&&<button type="button" className="contextAction" onClick={()=>{setSelected(active.jumpAlias!);setProbeError("")}}>Open {active.jumpAlias} gateway to connect first →</button>}
{jumpError&&<small role="alert" className="wizardError">{jumpError}</small>}
</div>
<div className="identityActions">{desktopAvailable()&&vaultUnlocked&&active.id&&<button className="iconbtn" title="Remove selected host" aria-label="Remove selected host" onClick={()=>{setError("");setDeleteTarget({kind:"host",alias:active.id})}}><Trash2 size={16}/></button>}<button className="primary" disabled={!desktopAvailable()||!vaultUnlocked||!active.id||sshBusy||tofuBusy} onClick={async()=>{
  setProbeError("");setTofuError("");
  if(!active.fingerprint){
    setTofuBusy(true);
    try{const key=active.jumpAlias?await discoverSshHostKeyVia(active.id):await discoverSshHostKey(active.id);setTofuCandidate({alias:active.id,fingerprint:key.fingerprint})}
    catch(e){setProbeError(String(e))}
    finally{setTofuBusy(false)}
    return;
  }
  setLoginPassword("");setLoginKeyPassphrase("");setHostIdentityChoice("");setLoginMode((active.savedAuthMode as "key"|"password"|"key-password")||(active.identityAlias?"key-password":"password"));setUseSavedCredentials(!!active.hasSavedCredentials);setRememberCredentials(!!active.hasSavedCredentials);setLoginOpen(true)
}}>Connect <span>↗</span></button>{active.hasSavedCredentials&&active.fingerprint&&<button className="iconbtn" style={{width:"auto",padding:"0 12px"}} disabled={sshBusy||!vaultUnlocked} title="Connect using credentials saved in the encrypted vault" onClick={()=>void quickConnect(active.id,(active.savedAuthMode as "key"|"password"|"key-password")||"key-password")}>Quick connect</button>}{desktopAvailable()&&vaultUnlocked&&active.id&&active.fingerprint&&<button className="iconbtn" style={{width:"auto",padding:"0 12px"}} onClick={()=>void authenticateActive()} disabled={authBusy||!active.identityAlias||!!active.jumpAlias} title="Key-only direct SSH authentication check. For encrypted keys, Windows passwords or two-factor SSH use Connect instead.">{authBusy?"Testing key…":"Test SSH key-only"}</button>}{desktopAvailable()&&vaultUnlocked&&active.id&&<button className="iconbtn" style={{width:"auto",padding:"0 12px"}} onClick={()=>void probeActive()} disabled={probeBusy} title="Check SSH banner; not an authenticated connection">{probeBusy?"Checking…":"Test SSH port"}</button>}</div></div>
        {sessionNotice&&<div role="status" className="wizardError" style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,flexWrap:"wrap"}}>
<span>{sessionNotice.alias?sessionNotice.alias+": ":""}{sessionNotice.detail}</span>
{sessionNotice.alias&&hosts.some(h=>h.id===sessionNotice.alias)&&vaultUnlocked&&<button type="button" disabled={sshBusy} onClick={()=>reconnectNotice(sessionNotice.alias)}>Reconnect</button>}
<button type="button" aria-label="Dismiss session notice" onClick={()=>setSessionNotice(null)}>Dismiss</button></div>}{credentialWarning&&<p className="wizardError" role="alert">{credentialWarning}</p>}{probeError&&sshTabs.length>0&&!loginOpen&&<p className="wizardError" role="alert">{connectionHelp(probeError).title}: {probeError}</p>}<div className="terminal"><div className="terminalbar"><span><TerminalSquare size={15}/> Terminal</span><small>{connected?`${activeConnections} active session(s) on this host`:"NO ACTIVE SESSION ON THIS HOST"}</small>{activeSsh&&<button onClick={()=>{setAccessOpen(true);setAccessPublicKey("");setError("")}}>Windows Access Manager</button>}{activeSsh&&<button title="Windows local account: interactive password change. Requires appropriate account permissions." onClick={()=>void changeWindowsPassword()}>Change Windows password</button>}</div>{sshTabs.length>0&&<div className="sshTabBar">{sshTabs.map(t=><button key={t.id} className={activeSsh===t.id?"sshTab active":"sshTab"} onClick={()=>{setSelected(t.alias);setActiveSsh(t.id)}}>{t.alias} <span role="button" title="Disconnect" onClick={e=>{e.stopPropagation();void closeInteractive(t.id)}}>×</span></button>)}</div>}{sshTabs.map(t=><TerminalView key={t.id} id={t.id} active={t.id===activeSsh} onClosed={onSessionClosed}/>)}{!connected&&<div className="terminalEmpty"><div className="terminalGlyph"><TerminalSquare size={28}/></div><h2>{sshTabs.length?"No active terminal for this host":"Your terminal starts here"}</h2><p>{sshTabs.length?"Other SSH sessions remain open. Choose a connected tab or connect to this host to use Files, Docker, tunnels and AI tools here.":"Choose a host and unlock your vault to open a secure SSH session. Connect to your saved host to open an interactive SSH terminal."}</p><div className="statusline"><LockKeyhole size={14}/> {vaultUnlocked?"Vault unlocked":"Vault locked"} <span>·</span> SSH requires a pinned host key</div>{authResult&&<p role="status" className="note">{authResult}</p>}{probeResult?.alias===selected&&<p className="note" role="status">SSH service responded in {probeResult.data.elapsedMs} ms: {probeResult.data.banner}. Identity and host key have NOT been verified.</p>}{probeError&&<p className="wizardError" role="alert">{probeError}</p>}</div>}</div>
        <footer><span className="footerBrand"><span className="statusDot" style={{background:connected?"#22c55e":undefined}}/> {connected?"SSH connected":desktopAvailable()?"No active SSH session":"Offline preview"}</span><span>{active.label} · {activeConnections} on host · {sshTabs.length} total</span><span>{buildInfo?.publisher ?? "PAS7 Studio"} · {buildInfo?.target ?? "Loading build info"}</span></footer>
      </main>
      <aside className={"context "+(["connections","snippets","ports","files","docker","agent","settings"].includes(panel)?"fullContext":"")}><div className="contextHeader"><span>CONTEXT</span><CircleHelp size={16}/></div><div className="contextTabs">{tabs.map(({id,label,Icon})=><button key={id} className={panel===id?"active":""} title={label} aria-label={label} onClick={()=>setPanel(id)}><Icon size={17}/></button>)}</div><div className="contextBody">
        {panel==="connections"?<ConnectionsWorkspace
  hosts={hosts} selected={selected} connectedAliases={sshTabs.map(t=>t.alias)} vaultUnlocked={vaultUnlocked}
  onSelect={setSelected} onConnect={alias=>void connectFromConnections(alias)}
  onTerminal={alias=>{setSelected(alias);setPanel("terminal")}}
  onAdd={()=>{if(desktopAvailable()&&!vaultUnlocked){setVaultDialog(true);return}setAddOpen(true);setStep(0);setError("")}}
  onImport={()=>void inspectLocalSshConfig()}
 />:
 panel==="snippets"?<SnippetsWorkspace host={active.label} connected={connected}
  onTerminal={()=>setPanel("terminal")} onExecute={command=>void executeSnippet(command)}
 />:
 panel==="agent"?<AgentWorkspace
 host={active.label} address={active.address} username={active.user} port={active.port}
 route={active.jumpAlias?"Via "+active.jumpAlias:"Direct SSH"}
 sessionId={sshTabs.some(t=>t.id===activeSsh&&t.alias===active.id)?activeSsh:""}
 sessions={sshTabs.filter(t=>t.alias===active.id)}
 vaultUnlocked={vaultUnlocked}
 agent={agent} onAgent={setAgent}
 availability={agentAvailability} checking={agentProbeBusy}
 error={agentProbeError} status={agentStatus} context={context}
 onCheck={()=>void checkRemoteAgents()}
 onLaunch={()=>void launchRemoteAgent()}
 onTerminal={()=>setPanel("terminal")}
 onSession={id=>{if(sshTabs.some(t=>t.id===id&&t.alias===active.id))setActiveSsh(id)}}
 />:
         panel==="files"?<RemoteFilesWorkspace
 paneSizes={preferences.paneSizes} onPaneSize={updatePaneSize}
 session={activeSsh} host={active.label} connected={connected}
 pathInput={sftpPath} setPathInput={setSftpPath}
 entries={sftpEntries} busy={sftpBusy} error={sftpError}
 notice={sftpNotice?.session===activeSsh?sftpNotice.text:""}
 filter={sftpFilter} setFilter={setSftpFilter}
 sort={sftpOrder} setSort={setSftpOrder} showHidden={preferences.sftpShowHidden}
 navigate={path=>void browseSftp(path)}
 upload={()=>enqueueSftpTransfer("upload")}
 download={path=>enqueueSftpTransfer("download",[path])}
 queueDownloads={paths=>enqueueSftpTransfer("download",paths)}
 readPreview={path=>void readSftpPreview(path)}
 preview={sftpPreview} previewBusy={sftpPreviewBusy}
 previewError={sftpPreviewError?.session===activeSsh?sftpPreviewError:null}
 transferJobs={transferQueue.jobs} transferPaused={transferQueue.paused}
 onPauseQueue={transferQueue.setQueuePaused}
 onCancelJob={id=>void transferQueue.cancel(id)}
 onRetryJob={transferQueue.retry} onClearFinished={transferQueue.clearFinished}
 mutationBusy={sftpMutationBusy}
 onMkdir={name=>void mutateRemoteSftp("mkdir",name)}
 onDelete={(name,isDir)=>void mutateRemoteSftp("delete",name,isDir)}
 onRename={(name,newName,isDir)=>void mutateRemoteSftp("rename",name,isDir,newName)}
 backupPanel={<>
<section className="vaultBackupCard" aria-label="Encrypted Vault backups">
<strong><LockKeyhole size={14}/> Encrypted Vault backups</strong>
<p className="note">Create versioned, encrypted snapshots on this SSH server without overwriting earlier copies. Only cipher text leaves this device. Existing versions are not overwritten and the remote file is read back for verification.</p>
<div className="vaultBackupActions">
<button type="button" disabled={!connected||!activeSsh||!vaultUnlocked||vaultBackupBusy||sftpTransferBusy} onClick={()=>void saveVaultBackup()}>{vaultBackupBusy?"Working…":"Back up Vault to this server"}</button><div className="vaultBackupTarget">
<p className="note">Saved backup destination for {selected||"this host"}: <strong>{hosts.find(h=>h.id===selected)?.backupDirectory||"Not configured"}</strong></p>
<div className="vaultBackupActions">
<button type="button" disabled={!connected||!vaultUnlocked||backupTargetsBusy||vaultBackupBusy} onClick={()=>void saveBackupTarget(true)}>Use current folder as backup target</button>
<button type="button" disabled={!hosts.find(h=>h.id===selected)?.backupDirectory||backupTargetsBusy||vaultBackupBusy} onClick={()=>void saveBackupTarget(false)}>Remove target</button>
</div>
<p className="note">Saved destinations are encrypted in your local Vault. Each server must have an existing private directory writable by your SSH account.</p>
<button type="button" disabled={!vaultUnlocked||vaultBackupBusy||backupTargetsBusy||!hosts.some(h=>h.backupDirectory&&sshTabs.some(t=>t.alias===h.id))} onClick={()=>void backupAllConnected()}>
{vaultBackupBusy?"Backing up…":"Back up to all connected targets"}
</button>
</div>
<button type="button" disabled={!vaultUnlocked||vaultBackupBusy} onClick={()=>void exportVaultBackup()}>Export local backup…</button><button type="button" disabled={!vaultUnlocked||vaultBackupBusy} onClick={()=>void inspectVaultRestore()}>Restore from encrypted file…</button>
</div>
<div className="vaultHistory">
<div className="vaultHistoryHeading">
  <strong>Backup history</strong>
  <button type="button" disabled={!connected||vaultHistoryBusy||vaultBackupBusy} onClick={()=>void refreshVaultHistory()}>{vaultHistoryBusy?"Scanning…":"Refresh versions"}</button>
</div>
{vaultSnapshotHistory?.session===activeSsh&&<p className="note">{vaultSnapshotHistory.entries.length} snapshot(s) in {vaultSnapshotHistory.directory}. Versions are unverified until inspected.</p>}
{vaultSnapshotHistory?.session===activeSsh&&vaultSnapshotHistory.entries.length===0&&<p className="note">No versioned PaSSH7 backups in this directory.</p>}
{vaultSnapshotHistory?.session===activeSsh&&<div className="vaultHistoryList">{vaultSnapshotHistory.entries.slice(0,100).map(item=><div className="vaultHistoryItem" key={item.name}>
  <div className="vaultHistoryMeta"><strong>{item.name}</strong><small>{formatSftpSize(item.sizeBytes)}{item.modifiedAt!==null?" · "+new Date(item.modifiedAt*1000).toLocaleString():""} · Not yet authenticated</small></div>
  <button type="button" disabled={!vaultUnlocked||vaultBackupBusy||vaultHistoryBusy} onClick={()=>void inspectRemoteVaultRestore(vaultSnapshotHistory.directory+"/"+item.name)}>Compare &amp; review</button>
</div>)}</div>}
{vaultHistoryError&&<p className="wizardError" role="alert">{vaultHistoryError}</p>}
</div>
<p className="note">For direct recovery, click <strong>Review Vault backup</strong> beside a remote <code>passh7-vault-*.enc.json</code> file. You can also download it and restore later from a local file. You must know the same master password. This is manual versioned backup, not conflict-free multi-device sync.</p>
{vaultBackupNotice&&<p role="status" className="note">{vaultBackupNotice}</p>}
{vaultBackupError&&<p role="alert" className="wizardError">{vaultBackupError}</p>}
{vaultRestorePreview&&<div className="vaultRestorePreview">
<strong>Backup ready for recovery</strong>
<p>{vaultRestorePreview.hosts} host(s), {vaultRestorePreview.identities} SSH identity/identities, {(vaultRestorePreview.bytes/1024).toFixed(1)} KiB.</p>
<p className="note">Hosts: {vaultRestorePreview.hostAliases.slice(0,12).join(", ")||"None"}{vaultRestorePreview.hostAliases.length>12?" and more":""}</p><div className="vaultDiff" aria-label="Vault version comparison">
<strong>{vaultRestorePreview.sameContents?"No content differences detected":"Differences from your current Vault"}</strong>
{!vaultRestorePreview.sameContents&&<p className="note">These are records from the selected backup compared with your current Vault. No credentials or key contents are displayed. This is a full-Vault replacement, not a merge.</p>}
{([
  ["Only in backup — hosts",vaultRestorePreview.difference.backupOnlyHosts],
  ["Only locally — hosts (would be lost)",vaultRestorePreview.difference.localOnlyHosts],
  ["Changed hosts",vaultRestorePreview.difference.changedHosts],
  ["Only in backup — SSH identities",vaultRestorePreview.difference.backupOnlyIdentities],
  ["Only locally — SSH identities (would be lost)",vaultRestorePreview.difference.localOnlyIdentities],
  ["Changed SSH identities",vaultRestorePreview.difference.changedIdentities]
] as [string,string[]][]).filter(([,names])=>names.length>0).map(([heading,names])=><p className="note" key={heading}><strong>{heading}:</strong> {names.slice(0,18).join(", ")}{names.length>18?" (and "+(names.length-18)+" more)":""}</p>)}
{vaultRestorePreview.difference.otherMetadataChanged&&<p className="note">Other Vault settings/metadata differ.</p>}
</div>
{vaultRestorePreview.sameContents&&<p className="note">This backup contains the same hosts, identities and metadata as your active Vault. No restore is necessary.</p>}
<label>Type RESTORE to replace your local Vault
<input aria-label="Confirm Vault restore" value={vaultRestorePhrase} onChange={e=>setVaultRestorePhrase(e.target.value)} placeholder="RESTORE"/>
</label>
<div className="vaultBackupActions">
<button type="button" disabled={vaultBackupBusy} onClick={()=>{setVaultRestorePreview(null);setVaultRestorePhrase("")}}>Cancel recovery</button>
<button type="button" disabled={vaultBackupBusy||vaultRestorePhrase!=="RESTORE"||vaultRestorePreview.sameContents} onClick={()=>void commitVaultRestore()}>Restore selected backup</button>
</div>
</div>}
</section>
 </>}
 />:
        panel==="docker"?<DockerWorkspace
 paneSizes={preferences.paneSizes} onPaneSize={updatePaneSize}
 host={active.label} session={activeSsh} connected={connected}
 items={dockerInventory?.session===activeSsh?dockerInventory.items:null}
 stats={dockerStats?.session===activeSsh?dockerStats.items:null}
 statsError={dockerStatsError?.session===activeSsh?dockerStatsError.message:""}
 details={dockerDetails?.session===activeSsh?dockerDetails:null}
 detailsError={dockerDetailsError?.session===activeSsh?dockerDetailsError:null}
 onInspect={id=>void readDockerDetails(id)}
 loading={dockerBusy} error={dockerError}
 actionStatus={dockerActionStatus?.session===activeSsh?dockerActionStatus.text:null}
 actionBusy={dockerActionBusy} logs={dockerLogs} logsBusy={dockerLogsBusy}
 logsError={dockerLogsError?.session===activeSsh?dockerLogsError.message:""}
 liveStatus={dockerLiveStatus}
 tail={preferences.dockerTail} follow={preferences.dockerFollowLogs}
 autoRefresh={preferences.dockerAutoRefresh} onAutoRefresh={enabled=>updatePreferences({...preferences,dockerAutoRefresh:enabled})}
 onTail={tail=>updatePreferences({...preferences,dockerTail:tail})}
 onFollow={follow=>updatePreferences({...preferences,dockerFollowLogs:follow})}
 onRefresh={()=>void refreshDocker()}
 onAction={(id,name,action)=>void runDockerAction(id,name,action)}
 onLogs={(id,name)=>void viewDockerLogs(id,name)}
 onShell={(id,name)=>void openDockerShell(id,name)}
 onCloseLogs={()=>{dockerLogsRequestRef.current++;setDockerLogs(null);setDockerLogsError(null)}}
 />:
        panel==="settings"?<SettingsWorkspace
 preferences={preferences} onChange={updatePreferences}
 buildInfo={buildInfo} vaultUnlocked={vaultUnlocked}
 onLock={()=>void lockVault()}
 onExport={()=>void exportVaultBackup()}
 onRestore={()=>{setPanel("files");void inspectVaultRestore()}}
 />:
        panel==="ports"?<PortForwardingWorkspace
 host={active.label} connected={connected} session={activeSsh}
 forwards={tunnels} busy={tunnelBusy} error={tunnelError}
 localPort={tunnelLocalPort} remoteHost={tunnelRemoteHost} remotePort={tunnelRemotePort}
 onLocalPort={setTunnelLocalPort} onRemoteHost={setTunnelRemoteHost} onRemotePort={setTunnelRemotePort}
 onStart={()=>void addTunnel()} onRefresh={()=>void refreshLocalForwarding()}
 onStop={(session,localPort)=>void removeTunnel(session,localPort)}
 onTerminal={()=>setPanel("terminal")}
 />:
        panel==="terminal"?<div className="terminalContext">
 <div className="contextTitle"><TerminalSquare size={18}/><h3>SSH session</h3></div>
 <p className="muted">Use the secure interactive terminal on the left. Open a dedicated tool workspace for remote files, containers, agents or ports.</p>
 <div className="permission"><ShieldCheck size={16}/><div><strong>{connected?"Connected to "+active.label:"No SSH session selected"}</strong><small>{connected?active.user+"@"+active.address:"Select a host and connect to get started."}</small></div></div>
 <button className="contextAction" onClick={()=>setPanel("agent")}><Bot size={15}/> Open AI Agent workspace</button>
 <button className="contextAction" onClick={()=>setPanel("files")}><FolderClosed size={15}/> Browse remote files</button>
 <button className="contextAction" onClick={()=>setPanel("docker")}><Container size={15}/> Inspect Docker</button>
 <button className="contextAction" onClick={()=>setPanel("ports")}><Activity size={15}/> Manage port forwarding</button>
 {agentStatus&&<p className="note" role="status">{agentStatus}</p>}
 </div>:
        <><div className="contextTitle"><Activity size={18}/><h3>Local SSH tunnels</h3></div><p className="muted">Bind to localhost only. Route connections through this verified SSH session to a remote destination. Stops on disconnect or vault lock.</p><label className="fieldLabel">Local TCP port<input type="number" min={1} max={65535} value={tunnelLocalPort} onChange={e=>setTunnelLocalPort(Number(e.target.value))}/></label><label className="fieldLabel">Remote destination hostname<input value={tunnelRemoteHost} onChange={e=>setTunnelRemoteHost(e.target.value)} placeholder="127.0.0.1"/></label><label className="fieldLabel">Remote destination TCP port<input type="number" min={1} max={65535} value={tunnelRemotePort} onChange={e=>setTunnelRemotePort(Number(e.target.value))}/></label><button className="contextAction" disabled={!connected||!activeSsh||tunnelBusy||tunnelLocalPort<1||tunnelLocalPort>65535||tunnelRemotePort<1||tunnelRemotePort>65535||!tunnelRemoteHost.trim()} onClick={()=>void addTunnel()}>{tunnelBusy?"Working…":"Start local forwarding"}</button><button className="contextAction" type="button" disabled={!connected||tunnelBusy} onClick={()=>void refreshLocalForwarding()}>Refresh active forwards</button>{tunnelError&&<p role="alert" className="wizardError">{tunnelError}</p>}<div className="dockerInventory">{!tunnels.some(t=>sshTabs.some(s=>s.id===t.session&&s.alias===selected))&&<p className="note">No active local forwards for this host. Start one above to map a localhost port through SSH, or refresh to retrieve active native tunnels.</p>}{tunnels.filter(t=>sshTabs.some(s=>s.id===t.session&&s.alias===selected)).map(t=><div className="dockerItem" key={t.session+":"+t.localPort}><strong>127.0.0.1:{t.localPort}</strong><small>→ {t.targetHost}:{t.remotePort} via SSH</small><button disabled={tunnelBusy} onClick={()=>void removeTunnel(t.session,t.localPort)}>Stop tunnel</button></div>)}</div></>}
      </div></aside>
    </div>
    {deleteTarget&&<div className="overlay" onMouseDown={()=>{setDeleteTarget(null);setError("")}}><div className="modal" role="dialog" aria-modal="true" aria-label="Confirm vault removal" onMouseDown={e=>e.stopPropagation()}><div className="modalTitle"><Trash2 size={18}/> Remove {deleteTarget.kind}<button aria-label="Close" onClick={()=>{setDeleteTarget(null);setError("")}}><X size={17}/></button></div><p>Remove <strong>{deleteTarget.alias}</strong> from the encrypted vault? This cannot be undone. Removing a host keeps its SSH key; removing a key used by a host is blocked.</p>{error&&<p role="alert" className="wizardError">{error}</p>}<div className="wizardActions"><button onClick={()=>{setDeleteTarget(null);setError("")}}>Cancel</button><button className="primary" onClick={()=>void confirmRemove()}>Confirm removal</button></div></div></div>}
    {vaultDialog&&<div className="overlay" onMouseDown={()=>setVaultDialog(false)}><div className="modal" role="dialog" aria-modal="true" aria-label="Unlock encrypted vault" onMouseDown={e=>e.stopPropagation()}><div className="modalTitle"><LockKeyhole size={18}/> {vaultPresent?"Unlock vault":"Create vault"}<button aria-label="Close" onClick={()=>setVaultDialog(false)}><X size={17}/></button></div><p>Master password stays in this application session only. Lock the vault when finished.</p><form onSubmit={async e=>{e.preventDefault();await unlockVault()}} className="wizardFields"><label>Master password<input autoFocus type="password" autoComplete="off" value={vaultPassword} onChange={e=>setVaultPassword(e.target.value)} minLength={12} required/></label>{error&&<p role="alert" className="wizardError">{error}</p>}<button className="primary" type="submit">{vaultPresent?"Unlock":"Create encrypted vault"}</button></form></div></div>}
    {accessOpen&&<div className="overlay" onMouseDown={()=>setAccessOpen(false)}><div className="modal wizard" role="dialog" aria-modal="true" aria-label="Windows SSH Access Manager" onMouseDown={e=>e.stopPropagation()}><div className="modalTitle"><ShieldCheck size={18}/> Windows Access Manager<button aria-label="Close" onClick={()=>setAccessOpen(false)}><X size={17}/></button></div><div className="wizardFields"><p className="note">Commands run under the connected Windows account. Administrator operations require the appropriate Windows permissions. Output appears in the SSH terminal.</p><button onClick={()=>void runWindowsAccessAction("users")}>List Windows local users</button><button onClick={()=>void runWindowsAccessAction("keys")}>Show administrator authorized SSH keys</button><label>Public SSH key (for add / revoke)<textarea rows={4} value={accessPublicKey} onChange={e=>setAccessPublicKey(e.target.value)} placeholder="ssh-ed25519 AAAA… colleague-device"/></label><button onClick={()=>void runWindowsAccessAction("add")}>Add public key to administrator access</button><button onClick={()=>void runWindowsAccessAction("remove")}>Revoke exact public key (with backup)</button><p className="note">Before removing a key, verify an alternative login. This tool never changes sshd_config or grants Windows administrator membership.</p>{error&&<p className="wizardError" role="alert">{error}</p>}</div></div></div>}
    {tofuCandidate&&<div className="overlay" onMouseDown={()=>{if(!tofuBusy)setTofuCandidate(null)}}><div className="modal wizard" role="dialog" aria-modal="true" aria-label="Trust SSH server key" onMouseDown={e=>e.stopPropagation()}><div className="modalTitle"><ShieldCheck size={18}/> Verify first SSH connection<button type="button" aria-label="Cancel" disabled={tofuBusy} onClick={()=>setTofuCandidate(null)}><X size={17}/></button></div><p>The server at <strong>{active.address}:{active.port}</strong> presented this host-key fingerprint. Verify it independently with the server administrator before trusting it.</p><pre className="preview" style={{userSelect:"text",overflowWrap:"anywhere"}}>{tofuCandidate.fingerprint}</pre><p className="note">No password or private key has been sent. If the key differs from the trusted fingerprint, cancel. Once saved, a changed fingerprint blocks future connections.</p>{tofuError&&<p role="alert" className="wizardError">{tofuError}</p>}<div className="wizardActions"><button type="button" disabled={tofuBusy} onClick={()=>setTofuCandidate(null)}>Cancel</button><button type="button" className="primary" disabled={tofuBusy} onClick={async()=>{setTofuBusy(true);setTofuError("");try{await pinSshHostKey(tofuCandidate.alias,tofuCandidate.fingerprint);const saved=await getHosts();setHosts(saved.map(h=>({id:h.alias,label:h.alias,address:h.hostname,user:h.username,port:h.port,group:"My hosts",fingerprint:h.hostKeyPinned,identityAlias:h.identityAlias,hasSavedCredentials:h.hasSavedCredentials,savedAuthMode:h.savedAuthMode,backupDirectory:h.backupDirectory,jumpAlias:h.jumpAlias})));setTofuCandidate(null);setLoginPassword("");setLoginKeyPassphrase("");setLoginMode(active.identityAlias?"key-password":"password");setHostIdentityChoice("");setUseSavedCredentials(false);setRememberCredentials(false);setLoginOpen(true)}catch(e){setTofuError(String(e))}finally{setTofuBusy(false)}}}>Trust &amp; Continue</button></div></div></div>}
    {loginOpen&&<div className="overlay" onMouseDown={closeLogin}><form className="modal wizard" role="dialog" aria-modal="true" aria-label="Connect via SSH" onMouseDown={e=>e.stopPropagation()} onSubmit={e=>{e.preventDefault();void connectInteractive(loginPassword)}}><div className="modalTitle"><KeyRound size={18}/> Connect to {active.label}<button type="button" aria-label="Close" disabled={sshBusy} onClick={closeLogin}><X size={17}/></button></div><div className="wizardFields"><p className="note">PaSSH7 verifies the pinned host key before authentication. Your SSH private key remains in the encrypted vault.</p>{!active.identityAlias&&identities.length>0&&<div className="permission" style={{display:"grid",gap:8}}>
<strong>Optional: link a saved SSH key to this host</strong>
<small>You can sign in with a password now. Later, after installing the matching public key on the server, link an existing vault identity to use SSH key authentication.</small>
<select value={hostIdentityChoice} aria-label="Vault SSH identity for this host" onChange={e=>setHostIdentityChoice(e.target.value)}>
<option value="">Choose an existing SSH key</option>{identities.map(name=><option key={name} value={name}>{name}</option>)}
</select>
<button type="button" disabled={!hostIdentityChoice||hostIdentityBusy||sshBusy} onClick={()=>void attachIdentityToActiveHost()}>{hostIdentityBusy?"Attaching…":"Attach key to host"}</button>
</div>}<label>Authentication mode<select value={loginMode} onChange={e=>setLoginMode(e.target.value as "key"|"password"|"key-password")}><option value="password">Password only (first login / install key)</option><option value="key">SSH key only</option><option value="key-password">SSH key + account password</option></select></label>{loginMode!=="password"&&<label>SSH private-key passphrase (if encrypted)<input type="password" autoComplete="off" value={loginKeyPassphrase} onChange={e=>setLoginKeyPassphrase(e.target.value)} placeholder="Leave blank for unencrypted keys"/></label>}<label>SSH account password (Windows or Linux, when required)<input type="password" autoComplete="off" value={loginPassword} onChange={e=>setLoginPassword(e.target.value)} placeholder="Optional for key-only login"/></label><label style={{display:"flex",gap:9,alignItems:"center",flexDirection:"row"}}><input type="checkbox" checked={rememberCredentials} onChange={e=>{setRememberCredentials(e.target.checked);setUseSavedCredentials(e.target.checked&&!!active.hasSavedCredentials)}}/> Remember authentication for this host in encrypted vault</label>{useSavedCredentials&&<p className="note">Saved credentials will be used after vault unlock. Leave password fields empty to use saved values.</p>}{active.hasSavedCredentials&&<button type="button" onClick={async()=>{if(!window.confirm("Forget saved SSH passwords for this host?"))return;try{await forgetHostCredentials(selected);setUseSavedCredentials(false);setRememberCredentials(false);setHosts(v=>v.map(h=>h.id===selected?{...h,hasSavedCredentials:false,savedAuthMode:null}:h))}catch(e){setProbeError(String(e))}}}>Forget saved passwords</button>}<p className="note">For initial onboarding use Password only. After the matching public key is installed, attach that vault key to this host, then select SSH key + account password if the server requires both factors. Passwords are saved only when Remember authentication is checked.</p>{probeError&&<div role="alert" className="wizardError" style={{textAlign:"left"}}><strong>{connectionHelp(probeError).title}</strong><ul>{connectionHelp(probeError).checks.map((check,i)=><li key={i}>{check}</li>)}</ul><details><summary>Technical error (copy for support)</summary><code style={{display:"block",whiteSpace:"pre-wrap",overflowWrap:"anywhere"}}>{probeError}</code><button type="button" onClick={()=>void navigator.clipboard.writeText(probeError)}>Copy error</button></details></div>}<button type="submit" className="primary" disabled={sshBusy}>{sshBusy?"Authenticating…":"Connect securely"}</button></div></form></div>}
    {keyDialog&&<div className="overlay" onMouseDown={()=>{setKeyDialog(false);setKeyPem("");setImportKeyPassphrase("");setError("")}}><div className="modal wizard" role="dialog" aria-modal="true" aria-label="SSH identity manager" onMouseDown={e=>e.stopPropagation()}><div className="modalTitle"><KeyRound size={18}/> SSH identity manager<button aria-label="Close" onClick={()=>{setKeyDialog(false);setKeyPem("");setImportKeyPassphrase("");}}><X size={17}/></button></div><div className="wizardFields"><label>Identity name<input value={keyAlias} onChange={e=>setKeyAlias(e.target.value)} placeholder="my-ed25519"/></label><button className="primary" disabled={keyWorking||!vaultUnlocked||!keyAlias.trim()} onClick={async()=>{setKeyWorking(true);setError("");try{const key=await generateEd25519(keyAlias,"passh7-main");setGeneratedKey(key);setIdentities(await getIdentities());setDraft(v=>({...v,identity:key.alias}));setKeyAlias("")}catch(e){setError(String(e))}finally{setKeyWorking(false)}}}>{keyWorking?"Generating…":"Generate new Ed25519 key"}</button>{generatedKey&&<div className="permission" style={{display:"block",overflowWrap:"anywhere"}}><strong>Public key generated — safe to share</strong><p className="note">{generatedKey.fingerprint}</p><textarea readOnly value={generatedKey.publicKey} rows={4} aria-label="Generated public SSH key"/><button onClick={()=>void navigator.clipboard.writeText(generatedKey.publicKey).catch(e=>setError(String(e)))}>Copy PUBLIC key</button><button onClick={()=>{try{void navigator.clipboard.writeText(windowsAdminKeyScript(generatedKey.publicKey)).catch(e=>setError(String(e)))}catch(e){setError(String(e))}}}>Copy Windows Admin setup (PowerShell)</button><button disabled={!activeSsh||sshBusy} onClick={async()=>{
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
    {configImportOpen&&<div className="overlay" onMouseDown={()=>{if(!configImportBusy)setConfigImportOpen(false)}}>
      <div className="modal wizard" role="dialog" aria-modal="true" aria-label="Import OpenSSH config hosts" onMouseDown={e=>e.stopPropagation()}>
        <div className="modalTitle"><FileText size={18}/> Import OpenSSH hosts
          <button type="button" aria-label="Close" disabled={configImportBusy} onClick={()=>setConfigImportOpen(false)}><X size={17}/></button>
        </div>
        <p className="note">Preview direct entries from your computer's ~/.ssh/config. Nothing is imported until you select hosts and confirm. This reads only aliases, hostnames, usernames and ports — no private keys, passwords or provider tokens.</p>
        <p className="note">Wildcards, Include, Match, ProxyJump and ProxyCommand are not imported. Unsupported SSH options must be configured manually. Every imported host starts without a trusted host key or stored login password.</p>
        {configImportBusy&&<p className="note" role="status">Working with local OpenSSH profiles…</p>}
        <div className="configImportList">
          {configCandidates.map((host,index)=><div key={host.alias} className="configImportItem">
            <label className="configImportHeader"><input type="checkbox" checked={host.selected} disabled={configImportBusy}
              onChange={e=>setConfigCandidates(prev=>prev.map((h,i)=>i===index?{...h,selected:e.target.checked}:h))}/>
              <strong>{host.alias}</strong>
            </label>
            <small>{host.hostname}:{host.port}</small>
            <label>SSH username<input value={host.username} disabled={configImportBusy} placeholder="e.g. ubuntu or Administrator"
              onChange={e=>setConfigCandidates(prev=>prev.map((h,i)=>i===index?{...h,username:e.target.value}:h))}/></label>
          </div>)}
        </div>
        {configImportError&&<p role="alert" className="wizardError">{configImportError}</p>}
        {configImportResult&&<p role="status" className="note">{configImportResult}</p>}
        <div className="wizardActions">
          <button type="button" disabled={configImportBusy} onClick={()=>setConfigImportOpen(false)}>Close</button>
          <button type="button" className="primary" disabled={configImportBusy||!configCandidates.some(h=>h.selected)} onClick={()=>void importSelectedConfigHosts()}>Import {configCandidates.filter(h=>h.selected).length} selected host(s)</button>
        </div>
      </div>
    </div>}
    {addOpen&&!keyDialog&&<div className="overlay" onMouseDown={()=>setAddOpen(false)}><div className="modal wizard" role="dialog" aria-modal="true" aria-label="Add a new SSH host" onMouseDown={e=>e.stopPropagation()}>
      <div className="modalTitle"><Server size={18}/> Add a host <button aria-label="Close" onClick={()=>setAddOpen(false)}><X size={17}/></button></div>
      <div className="steps">{["Connection","Authentication","Trust","Review"].map((t,i)=><span className={i===step?"active":""} key={t}>{i+1}. {t}</span>)}</div>
      {step===0&&<div className="wizardFields"><label>Name<input value={draft.label} onChange={e=>setDraft({...draft,label:e.target.value})} placeholder="My Ubuntu server"/></label><label>Hostname / IP<input value={draft.hostname} onChange={e=>setDraft({...draft,hostname:e.target.value})} placeholder="192.168.1.10"/></label><div className="twoFields"><label>User<input value={draft.username} onChange={e=>setDraft({...draft,username:e.target.value})} placeholder="ubuntu"/></label><label>Port<input type="number" min={1} max={65535} value={draft.port} onChange={e=>setDraft({...draft,port:Number(e.target.value)})}/></label></div></div>}
      {step===1&&<div className="wizardFields"><label>Authentication<select value={draft.auth} onChange={e=>setDraft({...draft,auth:e.target.value as "password"|"key"|"agent"})}><option value="password">Password only (no SSH key required)</option><option value="key">Vault SSH key</option><option value="agent" disabled>Windows OpenSSH agent (future)</option></select></label>{draft.auth==="key"&&<label>SSH identity<select value={draft.identity} onChange={e=>setDraft({...draft,identity:e.target.value})}><option value="">Choose an imported key</option>{identities.map(name=><option key={name} value={name}>{name}</option>)}</select></label>}{desktopAvailable()&&<button className="iconbtn" style={{width:"auto",justifyContent:"start"}} onClick={()=>{setKeyDialog(true);setGeneratedKey(null);setError("")}}><Plus size={14}/> Manage / Generate key</button>}<p className="note">Password-only hosts do not require an SSH identity. If you select a key, its private portion remains encrypted in the vault. After saving, use Connect to enter your account password.</p></div>}
      {step===2&&<div className="wizardFields"><label>Verified server fingerprint<input value={draft.fingerprint} onChange={e=>setDraft({...draft,fingerprint:e.target.value})} placeholder="SHA256:..."/></label><p className="note">Obtain this fingerprint independently from a trusted administrator. You may leave this empty. On first connection PaSSH7 will show the discovered SHA256 fingerprint and require your explicit approval before any authentication.</p></div>}
      {step===3&&<div className="wizardFields"><div className="permission"><ShieldCheck size={16}/><div><strong>{draft.label || "Unnamed host"}</strong><small>{draft.username}@{draft.hostname}:{draft.port}</small></div></div><p className="note">{desktopAvailable()?"The host will be saved in your encrypted local vault. If no fingerprint is supplied, you will verify it when you first connect.":"Web preview only: this host is temporary and disappears after refresh."}</p></div>}
      {error&&<p role="alert" className="wizardError">{error}</p>}
      <div className="wizardActions"><button onClick={()=>step===0?setAddOpen(false):setStep(step-1)}>{step===0?"Cancel":"Back"}</button><button className="primary" onClick={async()=>{const issue=validateHostDraft({...draft,fingerprint:step<2?"":draft.fingerprint,identity:step===0?"placeholder":draft.identity});if(step===0&&(!draft.label.trim()||!draft.hostname.trim()||!draft.username.trim()||draft.port<1||draft.port>65535)){setError("Complete the connection details");return}if(step>=1&&issue){setError(issue);return}setError("");if(step<3){setStep(step+1);return}if(desktopAvailable()){try{await addHost({alias:draft.label,hostname:draft.hostname,port:draft.port,username:draft.username,identityAlias:draft.auth==="password"?"":draft.identity,pinnedHostKey:draft.fingerprint||null});const saved=await getHosts();setHosts(saved.map(h=>({id:h.alias,label:h.alias,address:h.hostname,user:h.username,port:h.port,group:"My hosts",fingerprint:h.hostKeyPinned,identityAlias:h.identityAlias})));setSelected(draft.label);setDraft({label:"",hostname:"",port:22,username:"",auth:"password",identity:"",fingerprint:""});setAddOpen(false)}catch(err){setError(String(err))}return}const id="preview-"+Date.now();setHosts(v=>[...v,{id,label:draft.label,address:draft.hostname,user:draft.username,port:draft.port,group:"My hosts",fingerprint:!!draft.fingerprint,identityAlias:draft.auth==="password"?"":draft.identity}]);setSelected(id);setDraft({label:"",hostname:"",port:22,username:"",auth:"password",identity:"",fingerprint:""});setAddOpen(false);}}> {step===3?(desktopAvailable()?"Save host":"Add to preview"):"Continue"} </button></div>
    </div></div>}
    {commandOpen&&<div className="overlay" onMouseDown={()=>setCommandOpen(false)}><div className="modal" role="dialog" aria-modal="true" aria-label="Command palette" onMouseDown={e=>e.stopPropagation()}><div className="modalTitle"><Search size={18}/> Quick switch <button onClick={()=>setCommandOpen(false)} aria-label="Close"><X size={17}/></button></div><p>Switch to a host</p>{hosts.map(h=><button className="paletteHost" key={h.id} onClick={()=>{setSelected(h.id);setCommandOpen(false)}}><Server size={16}/>{h.label}<small>{h.address}</small></button>)}</div></div>}

  </div>;
}
