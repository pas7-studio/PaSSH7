/**
 * Development-only deterministic visual fixture for the three approved mockups.
 * This module is imported only through the Vite DEV gate in main.tsx.
 * No real Vault, SSH session or Docker daemon is opened by this page.
 */
import {useState} from "react";
import {Bot,ChevronDown,Command,Container,FileText,FolderClosed,LockKeyhole,Network,Search,Server,Settings2,ShieldCheck,TerminalSquare} from "lucide-react";
import RemoteFilesWorkspace from "./RemoteFilesWorkspace";
import DockerWorkspace from "./DockerWorkspace";
import SettingsWorkspace from "./SettingsWorkspace";
import {defaultPreferences,type AppPreferences,type PaneSizes} from "./preferences";
import type {SftpEntry,BuildInfo,DockerDetails,DockerRuntimeStats} from "./backend";
import type {TransferJob} from "./useSftpTransferQueue";

type Screen="settings"|"files"|"docker";
const screenNames:{key:Screen;name:string}[]=[
  {key:"settings",name:"Settings"},{key:"files",name:"Remote Files"},{key:"docker",name:"Docker"}
];
const fixtures:SftpEntry[]=[
  {name:"src",isDir:true,sizeBytes:null,modifiedAt:1792100200,unixPermissions:0o755,ownerId:1000,groupId:1000},
  {name:"config",isDir:true,sizeBytes:null,modifiedAt:1792000200,unixPermissions:0o750,ownerId:1000,groupId:1000},
  {name:"logs",isDir:true,sizeBytes:null,modifiedAt:1791900200,unixPermissions:0o755,ownerId:1000,groupId:1000},
  {name:"README.md",isDir:false,sizeBytes:8432,modifiedAt:1792100300,unixPermissions:0o644,ownerId:1000,groupId:1000},
  {name:"docker-compose.yml",isDir:false,sizeBytes:2953,modifiedAt:1792100290,unixPermissions:0o644,ownerId:1000,groupId:1000},
  {name:"package.json",isDir:false,sizeBytes:1137,modifiedAt:1792100180,unixPermissions:0o644,ownerId:1000,groupId:1000},
  {name:"app.config.ts",isDir:false,sizeBytes:2104,modifiedAt:1792100100,unixPermissions:0o644,ownerId:1000,groupId:1000},
  {name:"sample.png",isDir:false,sizeBytes:6130,modifiedAt:1792000000,unixPermissions:0o644,ownerId:1000,groupId:1000}
];
const treeFolders:Record<string,SftpEntry[]>={
  "/": [{...fixtures[0],name:"home"},{...fixtures[1],name:"etc"},{...fixtures[2],name:"var"}],
  "/home": [{...fixtures[0],name:"deploy"}],
  "/home/deploy": [{...fixtures[0],name:"projects"},{...fixtures[1],name:"backups"}],
  "/home/deploy/projects": [{...fixtures[0],name:"passh7-app"}],
  "/home/deploy/projects/passh7-app": fixtures.filter(x=>x.isDir)
};
if(import.meta.env.DEV){
  // The fixture's only permitted IPC response is a fake directory tree.
  // Do not override real Tauri internals if preview is opened inside Tauri.
  const scope=window as unknown as {__TAURI_INTERNALS__?:{invoke:(command:string,args:Record<string,unknown>)=>Promise<unknown>}};
  if(!scope.__TAURI_INTERNALS__)scope.__TAURI_INTERNALS__={
    invoke:async(command,args)=>{
      if(command==="ssh_session_sftp_list")return treeFolders[String(args.path)]||[];
      throw new Error("Visual fixture never runs native command: "+command);
    }
  };
}
const containerRows=[
  {ID:"a1b2c3d4e5f6",Names:"api-server",Image:"ghcr.io/example/api:2.4.1",State:"running",Status:"Up 3 days",Ports:"0.0.0.0:8080->8080/tcp"},
  {ID:"b2c3d4e5f6a7",Names:"postgres",Image:"postgres:16-alpine",State:"running",Status:"Up 6 days",Ports:"5432/tcp"},
  {ID:"c3d4e5f6a7b8",Names:"redis",Image:"redis:7-alpine",State:"running",Status:"Up 6 days",Ports:"6379/tcp"},
  {ID:"d4e5f6a7b8c9",Names:"worker",Image:"ghcr.io/example/worker:2.4.1",State:"running",Status:"Up 3 days",Ports:"—"},
  {ID:"e5f6a7b8c9d0",Names:"backup-service",Image:"ghcr.io/example/backup:1.5",State:"exited",Status:"Exited (0) 1 day ago",Ports:"—"}
];
const dockerStats:DockerRuntimeStats[]=[
  {ID:"a1b2c3d4e5f6",Name:"api-server",CPUPerc:"3.12%",MemUsage:"244.3MiB / 4GiB"},
  {ID:"b2c3d4e5f6a7",Name:"postgres",CPUPerc:"1.35%",MemUsage:"338.2MiB / 4GiB"},
  {ID:"c3d4e5f6a7b8",Name:"redis",CPUPerc:"0.24%",MemUsage:"39.4MiB / 4GiB"},
  {ID:"d4e5f6a7b8c9",Name:"worker",CPUPerc:"2.48%",MemUsage:"155.7MiB / 4GiB"}
];
const dockerDetails:DockerDetails={
  created:"2026-10-11T08:22:30Z",startedAt:"2026-10-14T13:05:01Z",
  finishedAt:"0001-01-01T00:00:00Z",restartPolicy:"unless-stopped",
  image:"ghcr.io/example/api:2.4.1",
  mounts:[{type:"volume",source:"api_data",destination:"/app/data",rw:true}],
  networks:["internal","reverse-proxy"]
};
const logs=[
  "2026-10-17T11:04:22Z INFO  api-server | Listening on port 8080",
  "2026-10-17T11:04:23Z INFO  api-server | Postgres connection ready",
  "2026-10-17T11:04:24Z INFO  api-server | Route registry: 21 routes",
  "2026-10-17T11:04:26Z WARN  api-server | Background job retry scheduled",
  "2026-10-17T11:04:28Z INFO  api-server | GET /health 200",
  "2026-10-17T11:04:30Z INFO  api-server | GET /api/v1/status 200",
  "2026-10-17T11:04:33Z ERROR api-server | Test-only timeout marker",
  "2026-10-17T11:04:37Z INFO  api-server | Retry succeeded"
].join("\n");
const build:BuildInfo={version:"0.2.0",publisher:"PAS7 Studio",repository:"pas7-studio/PaSSH7",
  commit:"visual-fixture-not-a-build",builtAt:"2026-10-17T10:00:00Z",runNumber:"reference",target:"DEV visual fixture"};
const sampleFileText="# PaSSH7 app\n\nDevelopment-only fixture for screenshot layout checks.\n\n- Native SSH sessions remain disconnected\n- No real credentials are present\n- Colors and spacing use the actual UI components";
export default function ReferenceScreens(){
  const params=new URLSearchParams(window.location.search);
  const requested=params.get("screen");
  const [screen,setScreen]=useState<Screen>(screenNames.some(s=>s.key===requested)?requested as Screen:"settings");
  const [preferences,setPreferences]=useState<AppPreferences>({...defaultPreferences,paneSizes:{...defaultPreferences.paneSizes}});
  const [path,setPath]=useState("/home/deploy/projects/passh7-app");
  const [filter,setFilter]=useState("");
  const [sort,setSort]=useState<AppPreferences["sftpSort"]>("folders");
  const [preview,setPreview]=useState<{session:string;path:string;body:string;kind:"image"|"text"}|null>(null);
  const [chosenContainer,setChosenContainer]=useState(containerRows[0]);
  const [transferJobs]=useState<TransferJob[]>([
    {id:"fixture-complete",session:"visual-fixture",host:"dev-server",direction:"download",path:"/home/deploy/README.md",name:"README.md",status:"completed",bytes:8432,totalBytes:8432,result:"Downloaded",createdAt:1792100200000}
  ]);
  const navigate=(next:string)=>{setPath(next);setPreview(null)};
  const choose=(value:Screen)=>{setScreen(value);window.history.replaceState(null,"","?__reference=1&screen="+value)};
  const pane=(key:keyof PaneSizes,value:number)=>setPreferences(p=>({...p,paneSizes:{...p.paneSizes,[key]:value}}));
  const selected=screenNames.find(s=>s.key===screen);
  return <div className={"shell "+preferences.theme+" referenceFixture"+(preferences.density==="compact"?" compact":"")}>
    <header className="topbar">
      <div className="brand"><div className="brandicon"><TerminalSquare size={16}/></div><strong>PaSSH7</strong></div>
      <div className="topHost">
        <span className="hostDot trusted"/>
        <div className="topHostIdentity"><strong>dev-server</strong><small>deploy · 192.0.2.10 · SSH (port 22) · fixture</small></div>
        <span className="hostStatusLabel">Visual fixture · no real connection</span>
      </div>
      <div className="topactions"><button type="button" className="topQuickButton" disabled><TerminalSquare size={15}/>Open in Terminal</button>
        <button type="button" className="lock" disabled><LockKeyhole size={14}/> Visual-only Vault</button>
        <button type="button" className="iconbtn" disabled><Command size={16}/></button></div>
    </header>
    <div className="workspace workspaceFull">
      <aside className="sidebar"><nav className="workspaceNav" aria-label="Reference fixture workspaces">
        <button disabled><Server size={16}/>Connections</button>
        <button disabled><TerminalSquare size={16}/>Terminal</button>
        <button className={screen==="files"?"active":""} onClick={()=>choose("files")}><FolderClosed size={16}/>Remote Files</button>
        <button className={screen==="docker"?"active":""} onClick={()=>choose("docker")}><Container size={16}/>Docker</button>
        <button disabled><Network size={16}/>Port Forwarding</button>
        <button disabled><FileText size={16}/>Snippets</button>
        <button disabled><Bot size={16}/>AI Agents</button>
        <button className={screen==="settings"?"active":""} onClick={()=>choose("settings")}><Settings2 size={16}/>Settings</button>
      </nav>
      <div className="sectionHeading"><span>YOUR HOSTS</span></div>
      <label className="search"><Search size={15}/><input disabled value="" readOnly placeholder="Search hosts"/></label>
      <div className="groupLabel"><ChevronDown size={13}/>Examples</div>
      <button className="host selected" disabled><span className="hostText"><strong>dev-server</strong></span><span className="hostDot trusted"/></button>
      <div className="sidebottom"><span><ShieldCheck size={15}/> Visual reference</span><small>Development fixture only · No SSH connections</small></div>
      </aside>
      <aside className="context fullContext"><div className="contextBody">
        {screen==="settings"?<SettingsWorkspace preferences={preferences} onChange={setPreferences}
          buildInfo={build} vaultUnlocked={true} onLock={()=>{}} onExport={()=>{}} onRestore={()=>{}}/>:
        screen==="files"?<RemoteFilesWorkspace
          session="visual-fixture" host="dev-server" connected={true}
          pathInput={path} setPathInput={setPath}
          entries={{session:"visual-fixture",path,items:fixtures}}
          busy={false} error="" notice=""
          filter={filter} setFilter={setFilter}
          sort={sort} setSort={setSort}
          showHidden={preferences.sftpShowHidden} navigate={navigate}
          upload={()=>{}} download={()=>{}} queueDownloads={()=>{}}
          readPreview={target=>setPreview({session:"visual-fixture",path:target,kind:"text",body:sampleFileText})}
          onMkdir={()=>{}} onDelete={()=>{}} onRename={()=>{}} mutationBusy={false}
          preview={preview} previewBusy={false} previewError={null}
          transferJobs={transferJobs} transferPaused={false} onPauseQueue={()=>{}} onCancelJob={()=>{}} onRetryJob={()=>{}} onClearFinished={()=>{}}
          paneSizes={preferences.paneSizes} onPaneSize={pane}
          backupPanel={<section className="vaultBackupCard"><strong>Encrypted Vault backups</strong><p className="prefInfo">Reference layout only · No actual vault or files are accessed.</p></section>}
        />:<DockerWorkspace
          host="dev-server" session="visual-fixture" connected={true} items={containerRows} stats={dockerStats} statsError=""
          details={{session:"visual-fixture",containerId:chosenContainer.ID,data:{...dockerDetails,image:chosenContainer.Image}}} detailsError={null}
          onInspect={id=>{const selectedRow=containerRows.find(c=>c.ID===id);if(selectedRow)setChosenContainer(selectedRow)}}
          paneSizes={preferences.paneSizes} onPaneSize={pane}
          loading={false} error="" actionStatus={null} actionBusy=""
          logs={{session:"visual-fixture",containerId:chosenContainer.ID,containerName:chosenContainer.Names,text:logs}}
          logsBusy={false} logsError="" tail={preferences.dockerTail} follow={false}
          liveStatus="off" onFollow={()=>{}} onTail={()=>{}}
          autoRefresh={false} onAutoRefresh={()=>{}} onRefresh={()=>{}}
          onAction={()=>{}} onLogs={()=>{}} onCloseLogs={()=>{}} onShell={()=>{}}
        />}
      </div></aside>
    </div>
    <div className="referenceFixtureLabel" role="status">DEV UI FIXTURE · {selected?.name} · NOT A REAL SSH CONNECTION</div>
  </div>;
}
