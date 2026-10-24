import {useEffect,useRef,useState,type ReactNode} from "react";
import {ChevronDown,ChevronRight,FolderClosed,FolderOpen,RefreshCw} from "lucide-react";
import {listSftpDirectory,type SftpEntry} from "./backend";

type Props={session:string;connected:boolean;currentPath:string;onNavigate:(path:string)=>void};
const join=(base:string,name:string)=>base.replace(/\/$/,"")+"/"+name;
const rootFor=(path:string)=>path.startsWith("/")?"/":".";
const MAX_DEPTH=10;
/** A truly lazy SFTP directory tree. Each directory is only read when expanded. */
export default function RemoteDirectoryTree({session,connected,currentPath,onNavigate}:Props){
  const [expanded,setExpanded]=useState<string[]>([]);
  const [children,setChildren]=useState<Record<string,SftpEntry[]>>({});
  const [busy,setBusy]=useState<string[]>([]);
  const [errors,setErrors]=useState<Record<string,string>>({});
  const sessionRef=useRef(session);sessionRef.current=session;
  const loadedRef=useRef<Set<string>>(new Set());
  useEffect(()=>{loadedRef.current.clear();setExpanded([]);setChildren({});setBusy([]);setErrors({})},[session]);
  const load=async(path:string)=>{
    if(!connected||!session||busy.includes(path)||loadedRef.current.has(path))return;
    loadedRef.current.add(path);
    const origin=session;setBusy(previous=>[...previous,path]);setErrors(previous=>({...previous,[path]:""}));
    try{
      const entries=await listSftpDirectory(origin,path);
      if(sessionRef.current!==origin)return;
      setChildren(previous=>({...previous,[path]:entries.filter(item=>item.isDir).slice(0,600)}));
    }catch(error){
      loadedRef.current.delete(path);
      if(sessionRef.current===origin)setErrors(previous=>({...previous,[path]:String(error)}));
    }finally{
      if(sessionRef.current===origin)setBusy(previous=>previous.filter(p=>p!==path));
    }
  };
  const toggle=(path:string)=>{
    if(!connected)return;
    if(expanded.includes(path)){setExpanded(current=>current.filter(p=>p!==path));return}
    setExpanded(current=>[...current,path]);
    if(!children[path])void load(path);
  };
  // Reveal the currently navigated directory within the tree. The tree stays
  // lazy: each parent is loaded once and no unrelated subtree is crawled.
  useEffect(()=>{
    if(!connected||!session||!currentPath.trim())return;
    let cancelled=false;
    const canonical=currentPath.replaceAll("\\","/").replace(/\/+$/,"")||"/";
    const parts=canonical.split("/").filter(Boolean);
    const chain:string[]=[rootFor(canonical)];
    for(const part of parts.slice(0,MAX_DEPTH)){
      const parent=chain[chain.length-1];
      chain.push(join(parent,part));
    }
    setExpanded(previous=>[...new Set([...previous,...chain])]);
    void (async()=>{
      for(const path of chain){
        if(cancelled||sessionRef.current!==session)return;
        await load(path);
      }
    })();
    return()=>{cancelled=true};
  },[connected,session,currentPath]);

  const node=(path:string,label:string,depth:number):ReactNode=>{
    const isExpanded=expanded.includes(path);
    const isLoading=busy.includes(path);
    const folderChildren=children[path];
    return <div key={path} className="remoteTreeBranch">
      <div className={"remoteTreeRow "+(path===currentPath?"selected":"")} style={{paddingLeft:Math.min(depth,10)*13}}>
        <button type="button" className="remoteTreeToggle" aria-label={(isExpanded?"Collapse ":"Expand ")+path}
          aria-expanded={isExpanded} disabled={!connected||depth>=MAX_DEPTH} onClick={()=>toggle(path)}>
          {isLoading?<RefreshCw size={13} className="treeLoading"/>:isExpanded?<ChevronDown size={14}/>:<ChevronRight size={14}/>}
        </button>
        <button type="button" className="remoteTreeFolder" title={path} disabled={!connected}
          onClick={()=>onNavigate(path)}>{isExpanded?<FolderOpen size={15}/>:<FolderClosed size={15}/>}<span>{label}</span></button>
      </div>
      {isExpanded&&errors[path]&&<div className="remoteTreeMessage" role="alert">{errors[path]} <button onClick={()=>void load(path)}>Retry</button></div>}
      {isExpanded&&folderChildren?.length===0&&<div className="remoteTreeMessage">No subfolders</div>}
      {isExpanded&&folderChildren?.map(item=>node(join(path,item.name),item.name,depth+1))}
      {isExpanded&&folderChildren?.length===600&&<div className="remoteTreeMessage">Showing first 600 folders. Open the folder to browse further.</div>}
    </div>;
  };
  return <nav className="remoteTree" aria-label="Remote SFTP directory tree">
    <div className="paneTitle">REMOTE FOLDERS</div>
    {!connected?<p className="remoteTreeMessage">Connect to browse directories.</p>:node(rootFor(currentPath),rootFor(currentPath),0)}
    <div className="remoteTreeFoot">Folders are loaded on demand over the active authenticated SSH session.</div>
  </nav>;
}
