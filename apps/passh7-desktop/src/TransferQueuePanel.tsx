import {Ban,CheckCircle2,ChevronDown,ChevronUp,Download,Pause,Play,RefreshCw,Trash2,Upload,X} from "lucide-react";
import {useState} from "react";
import type {TransferJob} from "./useSftpTransferQueue";
type Props={jobs:TransferJob[];paused:boolean;onPause:(value:boolean)=>void;onCancel:(id:string)=>void;onRetry:(id:string)=>void;onClear:()=>void};
const human=(bytes:number)=>{
  if(bytes<1024)return bytes+" B";
  if(bytes<1024*1024)return (bytes/1024).toFixed(1)+" KiB";
  return (bytes/1024/1024).toFixed(1)+" MiB";
};
export default function TransferQueuePanel(p:Props){
  const [expanded,setExpanded]=useState(true);
  const active=p.jobs.filter(job=>["selecting","running","cancelling"].includes(job.status)).length;
  const waiting=p.jobs.filter(job=>job.status==="queued").length;
  const completed=p.jobs.filter(job=>job.status==="completed").length;
  return <section className="wideTransferQueue transferQueuePanel" aria-label="SFTP transfer manager">
    <div className="transferQueueHeader">
      <button type="button" aria-expanded={expanded} className="transferQueueTitle" onClick={()=>setExpanded(value=>!value)}>
        {expanded?<ChevronUp size={15}/>:<ChevronDown size={15}/>}
        <strong>Transfer Manager</strong><span>{active} active · {waiting} queued · {completed} completed</span>
      </button>
      <div className="transferQueueControls">
        <button type="button" disabled={!waiting} title={p.paused?"Resume queued transfers":"Pause after the active transfer"}
          onClick={()=>p.onPause(!p.paused)}>{p.paused?<Play size={14}/>:<Pause size={14}/>} {p.paused?"Resume":"Pause queue"}</button>
        <button type="button" disabled={!p.jobs.some(job=>["completed","cancelled","failed"].includes(job.status))}
          onClick={p.onClear}><Trash2 size={14}/> Clear finished</button>
      </div>
    </div>
    {expanded&&<div className="transferQueueBody">
      <p className="transferQueueDescription">Native SSH/SFTP transfers are processed one at a time. Each download opens a system Save dialog and each upload opens a system file picker. No destination is silently overwritten. Transfers are capped at 64 MiB each.</p>
      {!p.jobs.length&&<div className="transferQueueEmpty">No transfers yet. Select multiple files above to queue downloads, or choose Upload file.</div>}
      {p.jobs.slice().reverse().map(job=>{
        const current=["selecting","running","cancelling"].includes(job.status);
        const cancellable=job.status==="queued"||job.status==="running";
        const pct=job.totalBytes&&job.totalBytes>0?Math.min(100,Math.round(job.bytes*100/job.totalBytes)):null;
        return <div className={"transferQueueItem "+job.status} key={job.id}>
          <span className={"transferQueueGlyph "+job.status}>{job.direction==="upload"?<Upload size={17}/>:<Download size={17}/>}</span>
          <div className="transferQueueItemMain">
            <div className="transferQueueItemHeading"><strong title={job.path}>{job.name}</strong><span>{job.host} · {job.direction}</span></div>
            <p className="transferQueueItemStatus">{job.status==="completed"?<CheckCircle2 size={12}/>:job.status==="cancelled"?<Ban size={12}/>:null}
              {job.status}{job.result?" · "+job.result:""}{current&&job.bytes>0?" · "+human(job.bytes)+(job.totalBytes?" / "+human(job.totalBytes):""):""}</p>
            {(job.status==="running"||job.status==="cancelling")&&<progress className="transferQueueProgress" value={pct===null?undefined:pct} max={100} aria-label={"Transfer progress for "+job.name}/>}
          </div>
          <div className="transferQueueItemActions">
            {cancellable&&<button type="button" aria-label={"Cancel "+job.name} title="Cancel transfer" onClick={()=>p.onCancel(job.id)}><X size={15}/></button>}
            {["failed","cancelled"].includes(job.status)&&<button type="button" title="Retry (a new file dialog may be required)" aria-label={"Retry "+job.name} onClick={()=>p.onRetry(job.id)}><RefreshCw size={15}/></button>}
          </div>
        </div>
      })}
    </div>}
  </section>;
}
