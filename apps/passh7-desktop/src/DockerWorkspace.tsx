import {useEffect,useMemo,useRef,useState} from "react";
import {WorkspaceHeader} from "./WorkspaceChrome";
import {listDockerCatalog,listComposeProjectContainers,type DockerCatalogKind,type DockerRuntimeStats,type DockerDetails} from "./backend";
import PaneResizeHandle from "./PaneResizeHandle";
import {defaultPaneSizes,type PaneSizes} from "./preferences";
import {Clipboard,Container,Cpu,Download,HardDrive,Layers,Maximize2,Minimize2,Network,Play,RefreshCw,Search,Square,TerminalSquare} from "lucide-react";

export type ContainerRow={ID?:string;Names?:string;Image?:string;State?:string;Status?:string;Ports?:string};
type Logs={session:string;containerId:string;containerName:string;text:string}|null;
type Props={host:string;session:string;connected:boolean;items:ContainerRow[]|null;stats:DockerRuntimeStats[]|null;statsError:string;
  details:{session:string;containerId:string;data:DockerDetails}|null;
  detailsError:{session:string;containerId:string;message:string}|null;
  onInspect:(containerId:string)=>void;
  paneSizes:PaneSizes;onPaneSize:(key:keyof PaneSizes,value:number)=>void;
  loading:boolean;error:string;actionStatus:string|null;actionBusy:string;
  logs:Logs;logsBusy:boolean;logsError:string;tail:number;follow:boolean;
  liveStatus:"off"|"connecting"|"streaming"|"closed"|"error";
  onFollow:(value:boolean)=>void;onTail:(value:number)=>void;
  autoRefresh:boolean;onAutoRefresh:(value:boolean)=>void;
  onRefresh:()=>void;onAction:(id:string,name:string,action:"start"|"stop"|"restart")=>void;
  onLogs:(id:string,name:string)=>void;onCloseLogs:()=>void;
  onShell:(id:string,name:string)=>void;};
const isRunning=(item:ContainerRow)=>(item.State||"").toLowerCase()==="running";
const containerStat=(item:ContainerRow,stats:DockerRuntimeStats[]|null)=>{
  if(!stats)return null;
  const id=item.ID||"";
  return stats.find(entry=>(id&&entry.ID&&(entry.ID.startsWith(id)||id.startsWith(entry.ID)))||
    (entry.Name&&entry.Name===item.Names))||null;
};
const parseMemoryBytes=(text:string)=>{
  const match=text.split("/")[0]?.trim().match(/^([\d.]+)\s*([KMGT]?i?B|B)$/i);
  if(!match)return 0;
  const n=Number(match[1]);
  const unit=match[2].toLowerCase();
  const powers:{[name:string]:number}={b:1,kb:1000,mb:1000**2,gb:1000**3,tb:1000**4,kib:1024,mib:1024**2,gib:1024**3,tib:1024**4};
  return Number.isFinite(n)?n*(powers[unit]||0):0;
};
const readableMemory=(bytes:number)=>bytes>=1024**3?(bytes/1024**3).toFixed(2)+" GiB":(bytes/1024**2).toFixed(1)+" MiB";
export default function DockerWorkspace(p:Props){
  const [search,setSearch]=useState("");
  const [tab,setTab]=useState<"containers"|DockerCatalogKind>("containers");
  const [catalog,setCatalog]=useState<{session:string;kind:DockerCatalogKind;rows:Record<string,string>[]} |null>(null);
  const [catalogBusy,setCatalogBusy]=useState(false);
  const [catalogError,setCatalogError]=useState("");
  const [catalogSearch,setCatalogSearch]=useState("");
  const [composeSelected,setComposeSelected]=useState("");
  const [composeMembers,setComposeMembers]=useState<{session:string;project:string;rows:Record<string,string>[]} |null>(null);
  const [composeBusy,setComposeBusy]=useState(false);
  const [composeError,setComposeError]=useState("");
  // Results belong to a specific SSH session AND tab. A response arriving
  // after host/tab navigation must never clear or overwrite the new view.
  const catalogRequest=useRef(0);
  const catalogContext=useRef({session:p.session,tab});
  catalogContext.current={session:p.session,tab};
  const loadCatalog=async(kind:DockerCatalogKind)=>{
    if(!p.connected||!p.session)return;
    const session=p.session, request=++catalogRequest.current;
    setCatalogBusy(true);setCatalogError("");
    try{
      const rows=await listDockerCatalog(session,kind);
      if(request===catalogRequest.current&&catalogContext.current.session===session&&catalogContext.current.tab===kind)
        setCatalog({session,kind,rows});
    }catch(error){
      if(request===catalogRequest.current&&catalogContext.current.session===session&&catalogContext.current.tab===kind)
        setCatalogError("Could not list Docker "+kind+": "+String(error));
    }finally{
      if(request===catalogRequest.current)setCatalogBusy(false);
    }
  };
  useEffect(()=>{
    catalogRequest.current++;
    setCatalogBusy(false);setCatalogError("");setComposeError("");
    // Keep only the selected session's cached record; never show stale tabs.
    if(tab==="containers"||!p.connected)return;
    if(catalog?.session===p.session&&catalog.kind===tab)return;
    void loadCatalog(tab);
    // Requests are invalidated when this tab/session is left.
    return ()=>{catalogRequest.current++};
  },[tab,p.session,p.connected]);
  const displayCatalog=catalog?.session===p.session&&catalog.kind===tab?catalog.rows:null;
  const activeComposeProject=tab==="compose"&&displayCatalog?.some(row=>row.Name===composeSelected)
    ?composeSelected:"";
  useEffect(()=>{
    if(!p.connected||!p.session||!activeComposeProject)return;
    let cancelled=false;
    setComposeBusy(true);setComposeError("");setComposeMembers(null);
    void listComposeProjectContainers(p.session,activeComposeProject).then(rows=>{
      if(!cancelled)setComposeMembers({session:p.session,project:activeComposeProject,rows});
    }).catch(error=>{if(!cancelled)setComposeError(String(error))})
      .finally(()=>{if(!cancelled)setComposeBusy(false)});
    return()=>{cancelled=true};
  },[p.connected,p.session,activeComposeProject]);
  const filteredCatalog=(displayCatalog||[]).filter(row=>
    Object.values(row).join(" ").toLocaleLowerCase().includes(catalogSearch.toLocaleLowerCase())
  );
  const catalogColumns:Record<DockerCatalogKind,string[]>={
    images:["Repository","Tag","ID","Size","CreatedSince"],
    volumes:["Name","Driver","Scope"],
    networks:["Name","ID","Driver","Scope"],
    compose:["Name","Status","ConfigFiles"]
  };

  const [selected,setSelected]=useState("");
  useEffect(()=>{
    setSelected("");setComposeSelected("");setComposeMembers(null);setComposeBusy(false);
    setComposeError("");setCatalog(null);setCatalogBusy(false);setCatalogError("");
  },[p.session]);
  const [filter,setFilter]=useState<"all"|"running"|"stopped">("all");
  const [sortBy,setSortBy]=useState<"name"|"cpu"|"memory">("name");
  const [descending,setDescending]=useState(false);
  const sortWith=(kind:typeof sortBy)=>{
    if(kind===sortBy)setDescending(previous=>!previous);
    else {setSortBy(kind);setDescending(kind!=="name");}
  };
  const [logsSearch,setLogsSearch]=useState("");
  const [wrap,setWrap]=useState(false);
  const [level,setLevel]=useState<"all"|"error"|"warn">("all");
  const [logsFullscreen,setLogsFullscreen]=useState(false);
  const [inspectorWidth,setInspectorWidth]=useState(p.paneSizes.dockerInspector);
  const [logsHeight,setLogsHeight]=useState(p.paneSizes.dockerLogs);
  useEffect(()=>setInspectorWidth(p.paneSizes.dockerInspector),[p.paneSizes.dockerInspector]);
  useEffect(()=>setLogsHeight(p.paneSizes.dockerLogs),[p.paneSizes.dockerLogs]);
  const [inspectorTab,setInspectorTab]=useState<"details"|"mounts"|"network">("details");
  const running=(p.items||[]).filter(isRunning).length;
  const stopped=(p.items||[]).length-running;
  const images=new Set((p.items||[]).map(c=>c.Image).filter(Boolean)).size;
  const totalCpu=p.stats?.reduce((sum,item)=>sum+(Number.parseFloat(item.CPUPerc||"")||0),0)??null;
  const totalMemory=p.stats?.reduce((sum,item)=>sum+parseMemoryBytes(item.MemUsage||""),0)??null;
  const visible=useMemo(()=>(p.items||[]).filter(row=>
    (filter==="all"||(filter==="running"?isRunning(row):!isRunning(row))) &&
    (row.Names+" "+row.ID+" "+row.Image+" "+row.Status).toLowerCase().includes(search.toLowerCase())
  ).sort((a,b)=>{
    let comparison=0;
    if(sortBy==="name")comparison=(a.Names||a.ID||"").localeCompare(b.Names||b.ID||"");
    else if(sortBy==="cpu")comparison=(Number.parseFloat(containerStat(a,p.stats)?.CPUPerc||"")||0)-(Number.parseFloat(containerStat(b,p.stats)?.CPUPerc||"")||0);
    else comparison=parseMemoryBytes(containerStat(a,p.stats)?.MemUsage||"")-parseMemoryBytes(containerStat(b,p.stats)?.MemUsage||"");
    return descending?-comparison:comparison;
  }),[p.items,p.stats,filter,search,sortBy,descending]);
  const chosen=p.items?.find(x=>x.ID===selected)||visible[0];
  const inspected=p.details?.session===p.session&&p.details.containerId===chosen?.ID?p.details.data:null;
  const inspectError=p.detailsError?.session===p.session&&p.detailsError.containerId===chosen?.ID?p.detailsError.message:"";
  useEffect(()=>{
    if(tab==="containers"&&p.connected&&p.session&&chosen?.ID)p.onInspect(chosen.ID);
  },[tab,p.session,p.connected,chosen?.ID]);
  const logLines=useMemo(()=>(p.logs?.session===p.session?p.logs.text:"").split(/\r?\n/)
    .filter(Boolean).filter(line=>line.toLowerCase().includes(logsSearch.toLowerCase()))
    .filter(line=>level==="all"||(level==="error"?/\berror\b|\bfatal\b|\bpanic\b/i.test(line):/\bwarn(ing)?\b/i.test(line)))
    .slice(-2000),[p.logs,p.session,logsSearch,level]);
  return <div className="widePage dockerPage">
    <WorkspaceHeader icon={Container} title="Docker"
      description={"Inspect and manage remote containers, Compose projects and logs · "+p.host}
      status={p.connected?"connected":"offline"} statusText={p.connected?"SSH connected":"SSH disconnected"}/>
    <div className="dockerMetrics">
      <div><small><Container size={17}/> Containers</small><strong>{p.items?.length??"—"}</strong><span>Total on selected SSH host</span></div>
      <div><small><Play size={17}/> Running</small><strong className="textGood">{p.items?running:"—"}</strong><span>{p.items?.length?Math.round(100*running/p.items.length)+"% running":"No inventory"}</span></div>
      <div><small><Square size={17}/> Stopped</small><strong>{p.items?stopped:"—"}</strong><span>{p.items?.length?Math.round(100*stopped/p.items.length)+"% stopped":"No inventory"}</span></div>
      <div><small><Layers size={17}/> Images in use</small><strong>{p.items?images:"—"}</strong><span>Unique container image names</span></div>
      <div title="One read-only docker stats sample. CPU percentages are summed across running containers, not normalized to total host CPU."><small><Cpu size={17}/> Container CPU</small><strong>{totalCpu===null?"—":totalCpu.toFixed(1)+"%"}</strong><span>{p.statsError?"Stats unavailable":p.stats?"Sum of container CPU":"Sampling remote Docker…"}</span></div>
      <div title="One read-only docker stats sample. Memory sums the container usage values, not overall server RAM."><small><HardDrive size={17}/> Container memory</small><strong>{totalMemory===null?"—":readableMemory(totalMemory)}</strong><span>{p.statsError?"Stats unavailable":p.stats?"Reported container usage":"Sampling remote Docker…"}</span></div>
    </div>
    <div className="dockerResourceTabs" role="tablist" aria-label="Docker resources">{(["containers","images","volumes","networks","compose"] as const).map(kind=><button type="button" role="tab" aria-selected={tab===kind} className={tab===kind?"active":""} key={kind} onClick={()=>setTab(kind)}>{kind[0].toUpperCase()+kind.slice(1)} {tab===kind&&tab!=="containers"&&displayCatalog?"("+displayCatalog.length+")":""}</button>)}</div>
    {tab==="containers"?<><div className="dockerWorkspaceGrid resizableDockerGrid"
      style={{gridTemplateColumns:`minmax(250px,1fr) 7px minmax(265px,${inspectorWidth}px)`}}><section className="dockerContainersPane">
      <div className="dockerToolbar"><div className="filesSearch"><Search size={15}/><input placeholder="Search containers…" value={search} onChange={e=>setSearch(e.target.value)} aria-label="Search containers"/></div>
        <select aria-label="Container state filter" value={filter} onChange={e=>setFilter(e.target.value as typeof filter)}><option value="all">All containers</option><option value="running">Running</option><option value="stopped">Stopped / other</option></select>
        <label className="compactToggle dockerAutoRefresh" title="Refresh container inventory automatically every 15 seconds."><input type="checkbox" checked={p.autoRefresh} onChange={e=>p.onAutoRefresh(e.target.checked)}/> Auto-refresh</label>
        <button onClick={p.onRefresh} disabled={!p.connected||p.loading}><RefreshCw size={15}/>{p.loading?" Loading…":" Refresh"}</button>
      </div>
      {p.error&&<div className="workspaceError" role="alert">{p.error}</div>}
      {p.actionStatus&&<div className="workspaceNotice" role="status">{p.actionStatus}</div>}
      <div className="dockerTableScroll"><table className="workspaceTable"><thead><tr>
        <th><button className="dockerSort" aria-label="Sort containers by name" onClick={()=>sortWith("name")}>Name {sortBy==="name"?(descending?"↓":"↑"):""}</button></th>
        <th>Status</th><th>Image</th><th>Ports</th>
        <th><button className="dockerSort" aria-label="Sort containers by CPU usage" onClick={()=>sortWith("cpu")}>CPU {sortBy==="cpu"?(descending?"↓":"↑"):""}</button></th>
        <th><button className="dockerSort" aria-label="Sort containers by memory usage" onClick={()=>sortWith("memory")}>Memory {sortBy==="memory"?(descending?"↓":"↑"):""}</button></th>
        <th>Uptime / detail</th></tr></thead><tbody>
      {visible.map(row=>{
        const stat=containerStat(row,p.stats);
        return <tr key={row.ID} tabIndex={0} className={row.ID===chosen?.ID?"selected":""}
          onClick={()=>setSelected(row.ID||"")}
          onKeyDown={e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();setSelected(row.ID||"")}}}>
          <td className="dockerContainerName"><Container size={15}/> {row.Names||row.ID?.slice(0,12)||"Unknown"}</td>
          <td><span className={"dockerStatus "+(isRunning(row)?"running":"stopped")}>{isRunning(row)?"● Running":"● "+(row.State||"Other")}</span></td>
          <td title={row.Image}>{row.Image||"—"}</td><td title={row.Ports}>{row.Ports||"—"}</td>
          <td className="dockerStatCell">{stat?.CPUPerc||"—"}</td>
          <td className="dockerStatCell" title={stat?.MemUsage||""}>{stat?.MemUsage?.split("/")[0]?.trim()||"—"}</td>
          <td>{row.Status||"—"}</td>
        </tr>;
      })}</tbody></table>
      {p.connected&&p.items&&!visible.length&&<div className="workspaceEmpty">No matching containers. Change the filter or search.</div>}
      {!p.connected&&<div className="workspaceEmpty">Connect to {p.host} to inspect remote Docker.</div>}
      {p.connected&&!p.items&&<div className="workspaceEmpty">Click Refresh to load containers from the remote host. Your SSH user needs Docker permissions.</div>}
      </div></section>
      <PaneResizeHandle label="Docker container inspector width" direction="vertical"
        value={inspectorWidth} min={265} max={520} invert defaultValue={defaultPaneSizes.dockerInspector}
        onPreview={setInspectorWidth} onCommit={n=>{setInspectorWidth(n);p.onPaneSize("dockerInspector",n)}}/>
      <aside className="dockerInspector"><div className="paneTitle">CONTAINER DETAILS</div>
        {chosen&&chosen.ID?<><div className="inspectorFile"><Container size={30}/><strong>{chosen.Names||chosen.ID.slice(0,12)}</strong><span className={"dockerStatus "+(isRunning(chosen)?"running":"stopped")}>{chosen.Status||chosen.State}</span></div>
          <div className="inspectorActions">
            {isRunning(chosen)?<><button className="dangerButton" disabled={!!p.actionBusy} onClick={()=>p.onAction(chosen.ID!,chosen.Names||chosen.ID!,"stop")}><Square size={14}/> Stop</button>
              <button disabled={!!p.actionBusy} onClick={()=>p.onAction(chosen.ID!,chosen.Names||chosen.ID!,"restart")}><RefreshCw size={14}/> Restart</button></>:<button disabled={!!p.actionBusy} onClick={()=>p.onAction(chosen.ID!,chosen.Names||chosen.ID!,"start")}><Play size={14}/> Start</button>}
            <button disabled={p.logsBusy} onClick={()=>p.onLogs(chosen.ID!,chosen.Names||chosen.ID!)}><TerminalSquare size={14}/> {p.logsBusy?"Loading…":"View logs"}</button>
            {isRunning(chosen)&&<button onClick={()=>p.onShell(chosen.ID!,chosen.Names||chosen.ID!)}><TerminalSquare size={14}/> Open shell</button>}
            <button onClick={()=>void navigator.clipboard.writeText("docker inspect "+chosen.ID)}><Clipboard size={14}/> Copy command</button>
          </div>
          <div className="dockerInspectTabs" role="tablist" aria-label="Container details tabs">
            {(["details","mounts","network"] as const).map(kind=><button key={kind} role="tab" aria-selected={inspectorTab===kind}
              className={inspectorTab===kind?"active":""} onClick={()=>setInspectorTab(kind)}>{kind==="details"?"Details":kind==="mounts"?"Volumes":"Network"}</button>)}
          </div>
          {inspectError&&<div className="workspaceError" role="alert">Could not inspect container: {inspectError}
            <button onClick={()=>p.onInspect(chosen.ID!)}>Retry</button></div>}
          {inspectorTab==="details"&&<dl><dt>Container ID</dt><dd className="filePath">{chosen.ID}</dd>
            <dt>Image</dt><dd>{inspected?.image||chosen.Image||"Unknown"}</dd>
            <dt>Status</dt><dd><span className={"dockerStatus "+(isRunning(chosen)?"running":"stopped")}>{chosen.State||"Unknown"}</span></dd>
            <dt>Created</dt><dd>{inspected?.created?new Date(inspected.created).toLocaleString():"—"}</dd>
            <dt>Started</dt><dd>{inspected?.startedAt&&!inspected.startedAt.startsWith("0001-")?new Date(inspected.startedAt).toLocaleString():"—"}</dd>
            <dt>Restart policy</dt><dd>{inspected?.restartPolicy||"—"}</dd>
            <dt>Ports</dt><dd>{chosen.Ports||"None published"}</dd>
            <dt>Mounts</dt><dd>{inspected?inspected.mounts.length:"—"}</dd>
            <dt>Networks</dt><dd>{inspected?inspected.networks.join(", ")||"None":"—"}</dd></dl>}
          {inspectorTab==="mounts"&&<div className="dockerMounts">{inspected?.mounts.map((mount,index)=><div key={index}>
            <strong>{mount.destination||"Unknown target"}</strong><small>{mount.source||"Unknown source"}</small>
            <span>{mount.type||"Mount"} · {mount.rw?"read/write":"read-only"}</span>
          </div>)}{inspected?.mounts.length===0&&<p>No volumes or bind mounts reported.</p>}{!inspected&&<p>Loading Docker mount details…</p>}</div>}
          {inspectorTab==="network"&&<div className="dockerNetworks">
            {inspected?.networks.map(name=><div key={name}><Network size={14}/>{name}</div>)}
            {inspected?.networks.length===0&&<p>No networks reported.</p>}{!inspected&&<p>Loading Docker network details…</p>}
          </div>}
          <p className="prefInfo">Read-only inspection intentionally omits environment variable values, labels and full command arguments, which may contain secrets.</p>
        </>:<div className="workspaceEmpty">Select a container to inspect its details.</div>}
      </aside>
    </div>
    <PaneResizeHandle label="Container logs panel height" direction="horizontal" value={logsHeight}
      min={240} max={620} invert defaultValue={defaultPaneSizes.dockerLogs}
      onPreview={setLogsHeight} onCommit={n=>{setLogsHeight(n);p.onPaneSize("dockerLogs",n)}}/>
    <section className={"dockerLogViewer "+(logsFullscreen?"dockerLogsFullscreen":"")} style={{height:logsFullscreen?undefined:logsHeight}}>
      <div className="dockerLogToolbar"><strong><TerminalSquare size={17}/> Container Logs</strong>
      <select aria-label="Container for log viewer" value={p.logs?.session===p.session?p.logs.containerId:""} onChange={e=>{const row=p.items?.find(item=>item.ID===e.target.value);if(row?.ID)p.onLogs(row.ID,row.Names||row.ID)}} disabled={!p.connected||p.logsBusy}>
        <option value="">Select container…</option>{(p.items||[]).map(item=>item.ID?<option key={item.ID} value={item.ID}>{item.Names||item.ID.slice(0,12)}</option>:null)}
      </select>
      <label className="filesSearch"><Search size={14}/><input value={logsSearch} onChange={e=>setLogsSearch(e.target.value)} placeholder="Find in logs" aria-label="Search Docker logs"/></label>
      <select value={level} onChange={e=>setLevel(e.target.value as typeof level)} aria-label="Log severity"><option value="all">All levels</option><option value="warn">Warnings</option><option value="error">Errors</option></select>
      <select value={p.tail} onChange={e=>p.onTail(Number(e.target.value))} aria-label="Recent log lines">{[50,100,200,500,1000].map(n=><option value={n} key={n}>{n} lines</option>)}</select>
      <label className="compactToggle" title="Open an SSH log stream. Stop following automatically on navigation or disconnect."><input type="checkbox" checked={p.follow} onChange={e=>p.onFollow(e.target.checked)}/> Follow live</label>
      <label className="compactToggle"><input type="checkbox" checked={wrap} onChange={e=>setWrap(e.target.checked)}/> Wrap</label>
      <button title="Reload selected container logs" disabled={!p.logs||p.logsBusy} onClick={()=>{if(p.logs)p.onLogs(p.logs.containerId,p.logs.containerName)}}><RefreshCw size={15}/></button>
      <button title="Copy visible logs" disabled={!logLines.length} onClick={()=>navigator.clipboard.writeText(logLines.join("\n"))}><Clipboard size={15}/></button>
      <button title="Close log viewer" disabled={!p.logs} onClick={p.onCloseLogs}>Clear</button>
      <button title={logsFullscreen?"Exit full-screen logs":"Expand logs to full screen"} aria-label={logsFullscreen?"Exit full-screen logs":"Expand logs to full screen"} onClick={()=>setLogsFullscreen(value=>!value)}>{logsFullscreen?<Minimize2 size={15}/>:<Maximize2 size={15}/>}</button>
      <button title="Save recent logs to a local text file" disabled={!logLines.length} onClick={()=>{
        const blob=new Blob([logLines.join("\n")],{type:"text/plain;charset=utf-8"});
        const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download=(p.logs?.containerName||"docker")+"-logs.txt";a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
      }}><Download size={15}/></button>
    </div>{p.logsError&&<div className="workspaceError" role="alert">{p.logsError} <button type="button" disabled={p.logsBusy||!chosen?.ID} onClick={()=>{if(chosen?.ID)p.onLogs(chosen.ID,chosen.Names||chosen.ID)}}>Retry logs</button></div>}<div className={"dockerLogsBody "+(wrap?"wrapped":"")}>
      {p.logs?.session===p.session?<>{p.logsBusy&&<div className="logsLoading">Refreshing latest Docker logs…</div>}
        {logLines.map((line,index)=><div className="dockerLogLine" key={index}><span>{index+1}</span><code className={/\berror\b|fatal|panic/i.test(line)?"logError":/\bwarn/i.test(line)?"logWarn":""}>{line}</code></div>)}
        {!logLines.length&&!p.logsBusy&&<div className="workspaceEmpty">No log lines match the selected filters.</div>}
      </>:<div className="workspaceEmpty">Select a container and click View logs. Log output is fetched through a dedicated SSH exec channel.</div>}
    </div><div className="dockerLogFooter"><span>{p.logs?.session===p.session?"● Recent logs loaded":"○ No log stream"}</span><span>{logLines.length.toLocaleString()} visible lines · {new Blob([logLines.join("\n")]).size.toLocaleString()} UTF-8 bytes</span><span>{p.follow?p.liveStatus==="streaming"?"● Live SSH stream":p.liveStatus==="connecting"?"Connecting live stream…":p.liveStatus==="error"?"Live stream failed":p.liveStatus==="closed"?"Stream ended":"Follow enabled":"Manual refresh"}</span></div>
    </section></>:<section className="dockerCatalogWorkspace">
      <div className="dockerToolbar">
        <div className="filesSearch"><Search size={15}/><input value={catalogSearch} onChange={e=>setCatalogSearch(e.target.value)} placeholder={"Search "+tab+"…"} aria-label={"Search Docker "+tab}/></div>
        <button disabled={!p.connected||catalogBusy} onClick={()=>void loadCatalog(tab)}><RefreshCw size={15}/>{catalogBusy?" Loading…":" Refresh "+tab}</button>
      </div>
      {catalogError&&<div className="workspaceError" role="alert">{catalogError}</div>}
      <div className="dockerTableScroll">
      <table className="workspaceTable"><thead><tr>{catalogColumns[tab].map(name=><th key={name}>{name}</th>)}</tr></thead><tbody>
        {filteredCatalog.map((row,index)=><tr key={(row.ID||row.Name||row.Repository||"")+index}
          className={tab==="compose"&&row.Name===activeComposeProject?"selected":""}
          tabIndex={tab==="compose"?0:undefined}
          onClick={tab==="compose"?()=>setComposeSelected(row.Name||""):undefined}
          onKeyDown={tab==="compose"?e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();setComposeSelected(row.Name||"")}}:undefined}>
          {catalogColumns[tab].map(key=><td key={key} title={row[key]||""}>{row[key]||"—"}</td>)}
        </tr>)}
      </tbody></table>
      {!p.connected?<div className="workspaceEmpty">Connect to your SSH host to browse Docker resources.</div>:
        displayCatalog&&filteredCatalog.length===0?<div className="workspaceEmpty">No matching {tab}.</div>:
        !displayCatalog&&!catalogBusy?<div className="workspaceEmpty">Select Refresh to load {tab}.</div>:null}
      </div>
      {tab==="compose"&&<section className="dockerComposeMembers">
        <div className="dockerComposeMembersHeader">
          <div><strong>Project containers</strong><small>{activeComposeProject||"Select a Compose project above"}</small></div>
          <span>{composeBusy?"Loading…":composeMembers?.session===p.session&&composeMembers.project===activeComposeProject?composeMembers.rows.length+" containers":"Read-only"}</span>
        </div>
        {composeError&&<div className="workspaceError" role="alert">Cannot inspect Compose containers: {composeError}</div>}
        {activeComposeProject&&composeMembers?.session===p.session&&composeMembers.project===activeComposeProject?
          <div className="dockerTableScroll"><table className="workspaceTable"><thead><tr><th>Name</th><th>State</th><th>Image</th><th>Ports</th><th>Status</th></tr></thead>
            <tbody>{composeMembers.rows.map((row,index)=><tr key={(row.ID||"")+index}><td>{row.Names||row.ID?.slice(0,12)||"—"}</td><td>{row.State||"—"}</td><td>{row.Image||"—"}</td><td>{row.Ports||"—"}</td><td>{row.Status||"—"}</td></tr>)}</tbody></table>
            {!composeMembers.rows.length&&<div className="workspaceEmpty">No containers found with this Compose project label.</div>}
          </div>:<div className="workspaceEmpty">{activeComposeProject?"Reading project containers through SSH…":"Select a project to list its containers without reading compose YAML or .env files."}</div>}
      </section>}
      <p className="prefInfo">{tab==="compose"
        ?"Read-only Compose discovery and project-labelled containers. Compose up/down, YAML editing, and mutations are not enabled."
        :"Read-only "+tab+" inventory using the connected SSH account. No resource is modified by browsing."}</p>
    </section>}
  </div>;
}
