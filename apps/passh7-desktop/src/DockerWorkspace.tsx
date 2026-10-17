import {useEffect,useMemo,useState} from "react";
import {listDockerCatalog,type DockerCatalogKind,type DockerRuntimeStats} from "./backend";
import {Clipboard,Container,Cpu,Download,HardDrive,Layers,Maximize2,Minimize2,Play,RefreshCw,Search,Square,TerminalSquare} from "lucide-react";

export type ContainerRow={ID?:string;Names?:string;Image?:string;State?:string;Status?:string;Ports?:string};
type Logs={session:string;containerId:string;containerName:string;text:string}|null;
type Props={host:string;session:string;connected:boolean;items:ContainerRow[]|null;stats:DockerRuntimeStats[]|null;statsError:string;
  loading:boolean;error:string;actionStatus:string|null;actionBusy:string;
  logs:Logs;logsBusy:boolean;logsError:string;tail:number;follow:boolean;
  liveStatus:"off"|"connecting"|"streaming"|"closed"|"error";
  onFollow:(value:boolean)=>void;onTail:(value:number)=>void;
  onRefresh:()=>void;onAction:(id:string,name:string,action:"start"|"stop"|"restart")=>void;
  onLogs:(id:string,name:string)=>void;onCloseLogs:()=>void;};
const isRunning=(item:ContainerRow)=>(item.State||"").toLowerCase()==="running";
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
  const loadCatalog=async(kind:DockerCatalogKind)=>{
    if(!p.connected||!p.session)return;
    setCatalogBusy(true);setCatalogError("");
    try{
      const rows=await listDockerCatalog(p.session,kind);
      setCatalog({session:p.session,kind,rows});
    }catch(error){setCatalogError("Could not list Docker "+kind+": "+String(error))}
    finally{setCatalogBusy(false)}
  };
  useEffect(()=>{
    if(tab==="containers"||!p.connected)return;
    if(catalog?.session===p.session&&catalog.kind===tab)return;
    void loadCatalog(tab);
  },[tab,p.session,p.connected]);
  const displayCatalog=catalog?.session===p.session&&catalog.kind===tab?catalog.rows:null;
  const filteredCatalog=(displayCatalog||[]).filter(row=>
    Object.values(row).join(" ").toLocaleLowerCase().includes(catalogSearch.toLocaleLowerCase())
  );
  const catalogColumns:Record<DockerCatalogKind,string[]>={
    images:["Repository","Tag","ID","Size","CreatedSince"],
    volumes:["Name","Driver","Scope"],
    networks:["Name","ID","Driver","Scope"]
  };

  const [selected,setSelected]=useState("");
  const [filter,setFilter]=useState<"all"|"running"|"stopped">("all");
  const [logsSearch,setLogsSearch]=useState("");
  const [wrap,setWrap]=useState(false);
  const [level,setLevel]=useState<"all"|"error"|"warn">("all");
  const [logsFullscreen,setLogsFullscreen]=useState(false);
  const running=(p.items||[]).filter(isRunning).length;
  const stopped=(p.items||[]).length-running;
  const images=new Set((p.items||[]).map(c=>c.Image).filter(Boolean)).size;
  const totalCpu=p.stats?.reduce((sum,item)=>sum+(Number.parseFloat(item.CPUPerc||"")||0),0)??null;
  const totalMemory=p.stats?.reduce((sum,item)=>sum+parseMemoryBytes(item.MemUsage||""),0)??null;
  const visible=useMemo(()=>(p.items||[]).filter(row=>
    (filter==="all"||(filter==="running"?isRunning(row):!isRunning(row))) &&
    (row.Names+" "+row.ID+" "+row.Image+" "+row.Status).toLowerCase().includes(search.toLowerCase())
  ),[p.items,filter,search]);
  const chosen=p.items?.find(x=>x.ID===selected)||visible[0];
  const logLines=useMemo(()=>(p.logs?.session===p.session?p.logs.text:"").split(/\r?\n/)
    .filter(Boolean).filter(line=>line.toLowerCase().includes(logsSearch.toLowerCase()))
    .filter(line=>level==="all"||(level==="error"?/\berror\b|\bfatal\b|\bpanic\b/i.test(line):/\bwarn(ing)?\b/i.test(line)))
    .slice(-2000),[p.logs,p.session,logsSearch,level]);
  return <div className="widePage dockerPage">
    <div className="widePageTitle"><Container size={26}/><div><h1>Docker</h1><p>Manage remote containers and inspect their logs · {p.host}</p></div>
      <span className={p.connected?"workspaceConnected":"workspaceOffline"}>{p.connected?"● Connected":"○ Disconnected"}</span></div>
    <div className="dockerMetrics">
      <div><small><Container size={17}/> Containers</small><strong>{p.items?.length??"—"}</strong><span>Total on selected SSH host</span></div>
      <div><small><Play size={17}/> Running</small><strong className="textGood">{p.items?running:"—"}</strong><span>{p.items?.length?Math.round(100*running/p.items.length)+"% running":"No inventory"}</span></div>
      <div><small><Square size={17}/> Stopped</small><strong>{p.items?stopped:"—"}</strong><span>{p.items?.length?Math.round(100*stopped/p.items.length)+"% stopped":"No inventory"}</span></div>
      <div><small><Layers size={17}/> Images in use</small><strong>{p.items?images:"—"}</strong><span>Unique container image names</span></div>
      <div title="One read-only docker stats sample. CPU percentages are summed across running containers, not normalized to total host CPU."><small><Cpu size={17}/> Container CPU</small><strong>{totalCpu===null?"—":totalCpu.toFixed(1)+"%"}</strong><span>{p.statsError?"Stats unavailable":p.stats?"Sum of container CPU":"Sampling remote Docker…"}</span></div>
      <div title="One read-only docker stats sample. Memory sums the container usage values, not overall server RAM."><small><HardDrive size={17}/> Container memory</small><strong>{totalMemory===null?"—":readableMemory(totalMemory)}</strong><span>{p.statsError?"Stats unavailable":p.stats?"Reported container usage":"Sampling remote Docker…"}</span></div>
    </div>
    <div className="dockerResourceTabs" role="tablist" aria-label="Docker resources">{(["containers","images","volumes","networks"] as const).map(kind=><button type="button" role="tab" aria-selected={tab===kind} className={tab===kind?"active":""} key={kind} onClick={()=>setTab(kind)}>{kind[0].toUpperCase()+kind.slice(1)} {tab===kind&&tab!=="containers"&&displayCatalog?"("+displayCatalog.length+")":""}</button>)}</div>
    {tab==="containers"?<><div className="dockerWorkspaceGrid"><section className="dockerContainersPane">
      <div className="dockerToolbar"><div className="filesSearch"><Search size={15}/><input placeholder="Search containers…" value={search} onChange={e=>setSearch(e.target.value)} aria-label="Search containers"/></div>
        <select aria-label="Container state filter" value={filter} onChange={e=>setFilter(e.target.value as typeof filter)}><option value="all">All containers</option><option value="running">Running</option><option value="stopped">Stopped / other</option></select>
        <button onClick={p.onRefresh} disabled={!p.connected||p.loading}><RefreshCw size={15}/>{p.loading?" Loading…":" Refresh"}</button>
      </div>
      {p.error&&<div className="workspaceError" role="alert">{p.error}</div>}
      {p.actionStatus&&<div className="workspaceNotice" role="status">{p.actionStatus}</div>}
      <div className="dockerTableScroll"><table className="workspaceTable"><thead><tr><th>Name</th><th>Status</th><th>Image</th><th>Ports</th><th>Uptime / detail</th></tr></thead><tbody>
      {visible.map(row=><tr key={row.ID} className={row.ID===chosen?.ID?"selected":""} onClick={()=>setSelected(row.ID||"")}>
        <td className="dockerContainerName"><Container size={15}/> {row.Names||row.ID?.slice(0,12)||"Unknown"}</td>
        <td><span className={"dockerStatus "+(isRunning(row)?"running":"stopped")}>{isRunning(row)?"● Running":"● "+(row.State||"Other")}</span></td>
        <td title={row.Image}>{row.Image||"—"}</td><td title={row.Ports}>{row.Ports||"—"}</td><td>{row.Status||"—"}</td>
      </tr>)}</tbody></table>
      {p.connected&&p.items&&!visible.length&&<div className="workspaceEmpty">No matching containers. Change the filter or search.</div>}
      {!p.connected&&<div className="workspaceEmpty">Connect to {p.host} to inspect remote Docker.</div>}
      {p.connected&&!p.items&&<div className="workspaceEmpty">Click Refresh to load containers from the remote host. Your SSH user needs Docker permissions.</div>}
      </div></section>
      <aside className="dockerInspector"><div className="paneTitle">CONTAINER DETAILS</div>
        {chosen&&chosen.ID?<><div className="inspectorFile"><Container size={30}/><strong>{chosen.Names||chosen.ID.slice(0,12)}</strong><span className={"dockerStatus "+(isRunning(chosen)?"running":"stopped")}>{chosen.Status||chosen.State}</span></div>
          <dl><dt>ID</dt><dd className="filePath">{chosen.ID}</dd><dt>Image</dt><dd>{chosen.Image||"Unknown"}</dd><dt>Ports</dt><dd>{chosen.Ports||"None"}</dd><dt>State</dt><dd>{chosen.State||"Unknown"}</dd><dt>Status</dt><dd>{chosen.Status||"Unknown"}</dd></dl>
          <div className="inspectorActions"><button disabled={p.logsBusy} onClick={()=>p.onLogs(chosen.ID!,chosen.Names||chosen.ID!)}><TerminalSquare size={14}/> {p.logsBusy?"Loading…":"View logs"}</button>
            {isRunning(chosen)?<><button disabled={!!p.actionBusy} onClick={()=>p.onAction(chosen.ID!,chosen.Names||chosen.ID!,"restart")}><RefreshCw size={14}/> Restart</button><button className="dangerButton" disabled={!!p.actionBusy} onClick={()=>p.onAction(chosen.ID!,chosen.Names||chosen.ID!,"stop")}><Square size={14}/> Stop</button></>:<button disabled={!!p.actionBusy} onClick={()=>p.onAction(chosen.ID!,chosen.Names||chosen.ID!,"start")}><Play size={14}/> Start</button>}
          </div>
          <p className="prefInfo">Actions run using your remote SSH account's Docker privileges. Destructive actions require confirmation.</p>
        </>:<div className="workspaceEmpty">Select a container to inspect its details.</div>}
      </aside>
    </div>
    <section className={"dockerLogViewer "+(logsFullscreen?"dockerLogsFullscreen":"")}><div className="dockerLogToolbar"><strong><TerminalSquare size={17}/> Container Logs</strong>
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
        {filteredCatalog.map((row,index)=><tr key={(row.ID||row.Name||row.Repository||"")+index}>
          {catalogColumns[tab].map(key=><td key={key} title={row[key]||""}>{row[key]||"—"}</td>)}
        </tr>)}
      </tbody></table>
      {!p.connected?<div className="workspaceEmpty">Connect to your SSH host to browse Docker resources.</div>:
        displayCatalog&&filteredCatalog.length===0?<div className="workspaceEmpty">No matching {tab}.</div>:
        !displayCatalog&&!catalogBusy?<div className="workspaceEmpty">Select Refresh to load {tab}.</div>:null}
      </div>
      <p className="prefInfo">Read-only {tab} inventory using the connected SSH account. No resource is modified by browsing.</p>
    </section>}
  </div>;
}
