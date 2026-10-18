import {Ban,CheckCircle2,ChevronDown,ChevronUp,Download,Pause,Play,RefreshCw,Trash2,Upload,X} from "lucide-react";
import {useEffect,useState} from "react";
import type {TransferJob} from "./useSftpTransferQueue";

type Filter="all"|"pending"|"failed"|"finished";
type Props={
  jobs:TransferJob[];paused:boolean;focusToken?:number;
  onPause:(value:boolean)=>void;onCancel:(id:string)=>void;
  onRetry:(id:string)=>void;onClear:()=>void;
};
const human=(bytes:number)=>{
  if(bytes<1024)return bytes+" B";
  if(bytes<1024*1024)return (bytes/1024).toFixed(1)+" KiB";
  return (bytes/1024/1024).toFixed(1)+" MiB";
};
const inProgress=(job:TransferJob)=>["queued","selecting","running","cancelling"].includes(job.status);
const finished=(job:TransferJob)=>["completed","cancelled"].includes(job.status);

/** Queue state and real transfer progress are owned by the parent/native SFTP bridge.
 * Filtering and collapsing here never cancel, retry, or start file pickers. */
export default function TransferQueuePanel(p:Props){
  const [expanded,setExpanded]=useState(true);
  const [filter,setFilter]=useState<Filter>("all");
  // A click on the global SFTP indicator must reveal the actual queue,
  // even if the user previously collapsed or filtered it.
  useEffect(()=>{
    if((p.focusToken??0)>0){setExpanded(true);setFilter("all")}
  },[p.focusToken]);
  const active=p.jobs.filter(job=>["selecting","running","cancelling"].includes(job.status)).length;
  const waiting=p.jobs.filter(job=>job.status==="queued").length;
  const failed=p.jobs.filter(job=>job.status==="failed").length;
  const done=p.jobs.filter(finished).length;
  const filters:{id:Filter;label:string;count:number}[]=[
    {id:"all",label:"All",count:p.jobs.length},
    {id:"pending",label:"Pending",count:active+waiting},
    {id:"failed",label:"Failed",count:failed},
    {id:"finished",label:"Finished",count:done}
  ];
  const shown=p.jobs.filter(job=>filter==="all"||
    (filter==="pending"&&inProgress(job))||
    (filter==="failed"&&job.status==="failed")||
    (filter==="finished"&&finished(job)));
  const cancelQueued=()=>{
    if(!waiting)return;
    // The native picker and the currently streaming transfer are intentionally
    // left alone; only not-yet-started jobs are removed.
    if(!window.confirm("Cancel "+waiting+" queued SFTP transfer"+(waiting===1?"":"s")+
      "?\n\nActive transfers and operating-system file dialogs will continue."))return;
    for(const job of p.jobs){
      if(job.status==="queued")p.onCancel(job.id);
    }
  };
  return <section className="wideTransferQueue transferQueuePanel" aria-label="SFTP transfer manager">
    <div className="transferQueueHeader">
      <button type="button" aria-expanded={expanded} className="transferQueueTitle" onClick={()=>setExpanded(value=>!value)}>
        {expanded?<ChevronUp size={15}/>:<ChevronDown size={15}/>}
        <strong>Transfer Manager</strong>
        <span>{active} active · {waiting} queued · {failed} failed · {done} finished</span>
      </button>
      <div className="transferQueueControls">
        <button type="button" disabled={!waiting&&!p.paused}
          title={p.paused?"Resume queued transfers":"Pause after the active transfer"}
          onClick={()=>p.onPause(!p.paused)}>
          {p.paused?<Play size={14}/>:<Pause size={14}/>} {p.paused?"Resume":"Pause queue"}
        </button>
        <button type="button" disabled={!waiting} title="Cancel only transfers that have not started"
          onClick={cancelQueued}><X size={14}/> Cancel pending</button>
        <button type="button" disabled={!p.jobs.some(job=>finished(job)||job.status==="failed")}
          onClick={p.onClear}><Trash2 size={14}/> Clear finished</button>
      </div>
    </div>
    {expanded&&<>
      <div className="transferQueueFilters" role="group" aria-label="Filter SFTP transfer history">
        {filters.map(option=><button type="button" key={option.id}
          aria-pressed={filter===option.id}
          className={filter===option.id?"selected":""}
          onClick={()=>setFilter(option.id)}>
          {option.label} <span>{option.count}</span>
        </button>)}
      </div>
      <div className="transferQueueBody">
        <p className="transferQueueDescription">Transfers run one at a time over native SFTP. Download/Upload requires an operating-system file picker; files are never silently overwritten. Limit: 64 MiB per file. Pause affects queued work only.</p>
        {!shown.length&&<div className="transferQueueEmpty" role="status">
          {p.jobs.length===0?"No transfers yet. Select files above to queue downloads, or choose Upload file.":
            filter==="failed"?"No failed transfers.":
            filter==="pending"?"No active or queued transfers.":
            filter==="finished"?"No finished transfers.":"No transfers in this view."}
        </div>}
        {shown.slice().reverse().map(job=>{
          const current=["selecting","running","cancelling"].includes(job.status);
          const cancellable=job.status==="queued"||job.status==="running";
          const pct=job.totalBytes&&job.totalBytes>0?Math.min(100,Math.round(job.bytes*100/job.totalBytes)):null;
          return <div className={"transferQueueItem "+job.status} key={job.id}>
            <span className={"transferQueueGlyph "+job.status}>{job.direction==="upload"?<Upload size={17}/>:<Download size={17}/>}</span>
            <div className="transferQueueItemMain">
              <div className="transferQueueItemHeading"><strong title={job.path}>{job.name}</strong><span>{job.host} · {job.direction}</span></div>
              <p className="transferQueueItemStatus">{job.status==="completed"?<CheckCircle2 size={12}/>:job.status==="cancelled"?<Ban size={12}/>:null}
                {job.status}{job.result?" · "+job.result:""}{current&&job.bytes>0?" · "+human(job.bytes)+(job.totalBytes?" / "+human(job.totalBytes):""):""}</p>
              {(job.status==="running"||job.status==="cancelling")&&<progress className="transferQueueProgress"
                value={pct===null?undefined:pct} max={100} aria-label={"Transfer progress for "+job.name}/>}
            </div>
            <div className="transferQueueItemActions">
              {cancellable&&<button type="button" aria-label={"Cancel "+job.name} title="Cancel transfer" onClick={()=>p.onCancel(job.id)}><X size={15}/></button>}
              {["failed","cancelled"].includes(job.status)&&<button type="button"
                title="Retry (a new file dialog may be required)" aria-label={"Retry "+job.name}
                onClick={()=>p.onRetry(job.id)}><RefreshCw size={15}/></button>}
            </div>
          </div>;
        })}
      </div>
    </>}
  </section>;
}
