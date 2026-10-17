import {useRef,useState} from "react";
import {listen} from "@tauri-apps/api/event";
import {cancelSftpTransfer,downloadSftpFile,uploadSftpFile,type SftpTransferEvent} from "./backend";

export type TransferStatus="queued"|"selecting"|"running"|"cancelling"|"completed"|"failed"|"cancelled";
export type TransferJob={
  id:string;session:string;host:string;direction:"upload"|"download";path:string;
  name:string;status:TransferStatus;bytes:number;totalBytes:number|null;
  result:string;createdAt:number;
};
type Input={session:string;host:string;direction:"upload"|"download";paths:string[]};
const MAX_JOBS=100;
const PENDING_LIMIT=40;
/**
 * UI serializes system-dialog transfers, while the Rust transport streams bytes,
 * prevents overwrites, and owns cancellation. Jobs are UI history only: no local
 * absolute upload/download paths, credentials, file content or secrets are saved.
 */
export default function useSftpTransferQueue(onUploadComplete:(session:string,directory:string)=>void){
  const jobsRef=useRef<TransferJob[]>([]);
  const [jobs,setJobs]=useState<TransferJob[]>([]);
  const [paused,setPaused]=useState(false);
  const pausedRef=useRef(false);
  const busyRef=useRef(false);
  const publish=()=>setJobs([...jobsRef.current]);
  const update=(id:string,partial:Partial<TransferJob>)=>{
    jobsRef.current=jobsRef.current.map(job=>job.id===id?{...job,...partial}:job);publish();
  };
  const processNext=async()=>{
    if(busyRef.current||pausedRef.current)return;
    const next=jobsRef.current.find(job=>job.status==="queued");
    if(!next)return;
    busyRef.current=true;
    update(next.id,{status:"selecting",result:"Waiting for operating-system file picker…"});
    let unlisten:(()=>void)|undefined;
    try{
      unlisten=await listen<SftpTransferEvent>("passh7:sftp-transfer",event=>{
        const p=event.payload;
        if(p.sessionId!==next.session||p.transferId!==next.id)return;
        const current=jobsRef.current.find(job=>job.id===next.id);
        if(!current||current.status==="cancelling")return;
        update(next.id,{status:"running",bytes:p.bytes,totalBytes:p.totalBytes,result:"Streaming over SFTP"});
      });
      const result=next.direction==="download"
        ?await downloadSftpFile(next.session,next.path,next.id)
        :await uploadSftpFile(next.session,next.path,next.id);
      if(result===null){
        update(next.id,{status:"cancelled",result:"File picker dismissed; nothing transferred."});
      }else{
        update(next.id,{status:"completed",result});
        if(next.direction==="upload")onUploadComplete(next.session,next.path);
      }
    }catch(error){
      const message=String(error);
      const cancelled=/cancelled|canceled/i.test(message);
      update(next.id,{status:cancelled?"cancelled":"failed",result:message});
    }finally{
      unlisten?.();busyRef.current=false;
      // Schedule the next picker only after the previous native command settles.
      // Limit UI updates by moving to the next transfer in the microtask queue.
      void processNext();
    }
  };
  const enqueue=(input:Input)=>{
    if(!input.session||!input.paths.length)return 0;
    const unique=[...new Set(input.paths.filter(Boolean))].slice(0,PENDING_LIMIT);
    const pending=jobsRef.current.filter(j=>["queued","selecting","running","cancelling"].includes(j.status)).length;
    const allowed=Math.max(0,Math.min(unique.length,PENDING_LIMIT-pending,MAX_JOBS-jobsRef.current.length));
    if(!allowed)return 0;
    const fresh=unique.slice(0,allowed).map(path=>({
      id:crypto.randomUUID(),session:input.session,host:input.host,direction:input.direction,path,
      name:input.direction==="download"?path.split("/").at(-1)||path:"Local file via picker",
      status:"queued" as const,bytes:0,totalBytes:null,result:"",createdAt:Date.now()
    }));
    jobsRef.current=[...jobsRef.current,...fresh];publish();
    void processNext();
    return allowed;
  };
  const cancel=async(id:string)=>{
    const job=jobsRef.current.find(j=>j.id===id);
    if(!job)return;
    if(job.status==="queued"){update(id,{status:"cancelled",result:"Removed from pending queue."});return}
    if(job.status!=="running")return;
    update(id,{status:"cancelling",result:"Requesting transfer cancellation…"});
    try{await cancelSftpTransfer(job.session,job.id)}
    catch(error){update(id,{status:"running",result:"Cancellation failed: "+String(error)})}
  };
  const retry=(id:string)=>{
    const job=jobsRef.current.find(j=>j.id===id);
    if(!job||!["failed","cancelled"].includes(job.status))return;
    // New transfer ID is required: native SFTP transfer IDs are single-use.
    enqueue({session:job.session,host:job.host,direction:job.direction,paths:[job.path]});
  };
  const clearFinished=()=>{
    jobsRef.current=jobsRef.current.filter(job=>!["completed","failed","cancelled"].includes(job.status));
    publish();
  };
  const setQueuePaused=(value:boolean)=>{
    pausedRef.current=value;setPaused(value);
    if(!value)void processNext();
  };
  return {jobs,paused,enqueue,cancel,retry,clearFinished,setQueuePaused,
    active:jobs.some(j=>["selecting","running","cancelling"].includes(j.status))};
}
