import {useMemo,useState,type ReactNode} from "react";
import {ArrowLeft,ArrowRight,ArrowUp,Clipboard,Download,FileText,FolderClosed,Home,RefreshCw,Search,Upload} from "lucide-react";
import type {SftpEntry} from "./backend";

const size=(n:number|null)=>n===null?"—":n<1024?n+" B":n<1048576?(n/1024).toFixed(1)+" KiB":(n/1048576).toFixed(2)+" MiB";
const full=(dir:string,name:string)=>dir.replace(/\/$/,"")+"/"+name;
const crumbs=(path:string)=>{
  const parts=path.replaceAll("\\","/").split("/").filter(Boolean);
  const absolute=path.startsWith("/");
  return [{label:absolute?"/":".",path:absolute?"/":"."},...parts.map((name,index)=>({
    label:name,path:(absolute?"/":"")+parts.slice(0,index+1).join("/")
  }))];
};
type Entries={session:string;path:string;items:SftpEntry[]}|null;
type Preview={session:string;path:string;body:string}|null;
type Progress={session:string;id:string;direction:"upload"|"download";stage:string;bytes:number;totalBytes:number|null}|null;
type Props={
  session:string;host:string;connected:boolean;
  pathInput:string;setPathInput:(value:string)=>void;
  entries:Entries;busy:boolean;error:string;
  filter:string;setFilter:(s:string)=>void;
  sort:"folders"|"name"|"size"|"modified";setSort:(s:Props["sort"])=>void;
  showHidden:boolean;navigate:(path:string)=>void;
  upload:()=>void;download:(path:string)=>void;readPreview:(path:string)=>void;
  preview:Preview;previewBusy:boolean;
  transferBusy:boolean;transferProgress:Progress;transferResult:string|null;
  cancelTransfer:()=>void;backupPanel:ReactNode;
};
export default function RemoteFilesWorkspace(p:Props){
  const [selected,setSelected]=useState<string>("");
  const [history,setHistory]=useState<string[]>([]);
  const [historyIndex,setHistoryIndex]=useState(-1);
  const dir=p.entries?.session===p.session?p.entries:null;
  const path=dir?.path||p.pathInput;
  const open=(next:string)=>{
    setSelected("");
    if(next!==path){const nextHistory=[...history.slice(0,historyIndex+1),next].slice(-60);
      setHistory(nextHistory);setHistoryIndex(nextHistory.length-1);}
    p.navigate(next);
  };
  const items=useMemo(()=>[...(dir?.items||[])].filter(item=>
    (p.showHidden||!item.name.startsWith(".")) &&
    (!p.filter||item.name.toLocaleLowerCase().includes(p.filter.toLocaleLowerCase()))
  ).sort((a,b)=>{
    if(p.sort==="folders"&&a.isDir!==b.isDir)return a.isDir?-1:1;
    if(p.sort==="size"&&a.sizeBytes!==b.sizeBytes)return (b.sizeBytes??-1)-(a.sizeBytes??-1);
    if(p.sort==="modified"&&a.modifiedAt!==b.modifiedAt)return (b.modifiedAt??-1)-(a.modifiedAt??-1);
    return a.name.localeCompare(b.name,undefined,{numeric:true,sensitivity:"base"});
  }),[dir,p.showHidden,p.filter,p.sort]);
  const selectedItem=items.find(item=>item.name===selected);
  const selectedPath=selected?full(path,selected):"";
  const preview=p.preview?.session===p.session&&p.preview.path===selectedPath?p.preview:null;
  return <div className="widePage remoteFilesPage">
    <div className="widePageTitle"><FolderClosed size={25}/><div><h1>Remote Files</h1><p>Browse, preview and transfer files securely over SFTP · {p.host}</p></div>
      <span className={p.connected?"workspaceConnected":"workspaceOffline"}>{p.connected?"● Connected":"○ Disconnected"}</span></div>
    <div className="filesPathBar">
      <button title="Back" disabled={!p.connected||historyIndex<=0} onClick={()=>{const index=historyIndex-1;setHistoryIndex(index);p.navigate(history[index])}}><ArrowLeft size={16}/></button>
      <button title="Forward" disabled={!p.connected||historyIndex<0||historyIndex>=history.length-1} onClick={()=>{const index=historyIndex+1;setHistoryIndex(index);p.navigate(history[index])}}><ArrowRight size={16}/></button>
      <button title="Parent directory" disabled={!p.connected||p.busy} onClick={()=>open(crumbs(path).at(-2)?.path||".")}><ArrowUp size={16}/></button>
      <div className="filesCrumbs" aria-label="Current remote path">{crumbs(path).map((c,i)=><button key={i} disabled={!p.connected||p.busy} onClick={()=>open(c.path)}>{c.label}</button>)}</div>
      <input aria-label="Remote path" title="Enter a remote directory" value={p.pathInput} onChange={e=>p.setPathInput(e.target.value)}
        onKeyDown={e=>{if(e.key==="Enter")open(p.pathInput)}} placeholder="/home/user"/>
      <button onClick={()=>open(p.pathInput)} disabled={!p.connected||p.busy} title="Open directory"><Home size={16}/></button>
      <button onClick={()=>navigator.clipboard.writeText(path)} title="Copy current path"><Clipboard size={16}/></button>
    </div>
    <div className="filesActions">
      <button className="workspacePrimary" disabled={!p.connected||p.busy||p.transferBusy} onClick={p.upload}><Upload size={16}/> Upload file</button>
      <button disabled={!p.connected||!selectedItem||selectedItem.isDir||p.transferBusy} onClick={()=>p.download(selectedPath)}><Download size={16}/> Download</button>
      <button disabled={!p.connected||p.busy} onClick={()=>open(path)}><RefreshCw size={16}/> {p.busy?"Loading…":"Refresh"}</button>
      <div className="filesToolbarSpacer"/>
      <label className="filesSearch"><Search size={15}/><input value={p.filter} onChange={e=>p.setFilter(e.target.value)} placeholder="Search in folder" aria-label="Filter files"/></label>
      <select value={p.sort} onChange={e=>p.setSort(e.target.value as Props["sort"])} aria-label="File sorting"><option value="folders">Folders first</option><option value="name">By name</option><option value="size">Largest first</option><option value="modified">Newest first</option></select>
    </div>
    {p.error&&<div className="workspaceError" role="alert">{p.error}</div>}
    <div className="filesGrid">
      <nav className="filesFolders" aria-label="Remote folder navigation"><div className="paneTitle">FOLDERS</div>
        <button onClick={()=>open("/")} disabled={!p.connected}>/ Root</button>
        {crumbs(path).slice(1).map((c,i)=><button key={c.path} className={i===crumbs(path).length-2?"selected":""} onClick={()=>open(c.path)}>↳ <FolderClosed size={14}/> {c.label}</button>)}
        <div className="paneTitle">SUBFOLDERS</div>
        {dir?.items.filter(item=>item.isDir).map(item=><button key={item.name} onClick={()=>open(full(path,item.name))}><FolderClosed size={14}/> {item.name}</button>)}
        {!dir&&<p>Connect and browse to load remote folders.</p>}
      </nav>
      <div className="filesTablePane"><div className="paneTitle">{path} <span>{dir?items.length+" entries":"Not loaded"}</span></div>
        <div className="filesTableWrap"><table className="workspaceTable"><thead><tr><th>Name</th><th>Size</th><th>Modified</th><th>Type</th></tr></thead><tbody>
          {items.map(item=><tr key={item.name} className={item.name===selected?"selected":""}
            onClick={()=>setSelected(item.name)}
            onDoubleClick={()=>item.isDir?open(full(path,item.name)):p.readPreview(full(path,item.name))}>
            <td><span className="fileName">{item.isDir?<FolderClosed size={15}/>:<FileText size={15}/>} {item.name}</span></td>
            <td>{item.isDir?"—":size(item.sizeBytes)}</td>
            <td>{item.modifiedAt!==null?new Date(item.modifiedAt*1000).toLocaleString():"—"}</td>
            <td>{item.isDir?"Folder":(item.name.split(".").at(-1)||"File").toUpperCase()}</td></tr>)}
        </tbody></table>
        {dir&&items.length===0&&<div className="workspaceEmpty">{p.filter?"No matching files. Clear the search to see the directory.":"This directory is empty."}</div>}
        {!p.connected&&<div className="workspaceEmpty">Connect to <strong>{p.host}</strong> to browse files. Select your host and click Connect.</div>}
        {p.connected&&!dir&&<div className="workspaceEmpty">Choose a directory and click Open to load its contents.</div>}
        </div>
      </div>
      <aside className="filesInspector"><div className="paneTitle">FILE DETAILS</div>
        {selectedItem?<><div className="inspectorFile"><FileText size={28}/><strong>{selectedItem.name}</strong><small>{selectedItem.isDir?"Directory":"Remote file"}</small></div>
          <dl><dt>Size</dt><dd>{size(selectedItem.sizeBytes)}</dd><dt>Modified</dt><dd>{selectedItem.modifiedAt!==null?new Date(selectedItem.modifiedAt*1000).toLocaleString():"Unknown"}</dd><dt>Path</dt><dd className="filePath">{selectedPath}</dd></dl>
          <div className="inspectorActions"><button onClick={()=>navigator.clipboard.writeText(selectedPath)}><Clipboard size={14}/> Copy path</button>
          {selectedItem.isDir?<button onClick={()=>open(selectedPath)}>Open folder</button>:<><button onClick={()=>p.readPreview(selectedPath)} disabled={p.previewBusy}>Preview</button><button onClick={()=>p.download(selectedPath)} disabled={p.transferBusy}>Download</button></>}</div>
          {!selectedItem.isDir&&<div className="fileCodePreview"><strong>READ-ONLY PREVIEW</strong>{p.previewBusy?<p>Loading preview…</p>:preview?<pre>{preview.body}</pre>:<p>Select Preview to read UTF-8 text. Binary files may not be previewable.</p>}</div>}
        </>:<div className="workspaceEmpty">Select a file to see details and preview its contents.</div>}
      </aside>
    </div>
    {(p.transferProgress?.session===p.session||p.transferResult)&&<div className="wideTransferQueue"><strong>Transfer queue</strong>
      {p.transferProgress?.session===p.session&&<div className="transferRow"><span>{p.transferProgress.direction==="upload"?"Uploading":"Downloading"} · {p.transferProgress.stage}</span><span>{size(p.transferProgress.bytes)} / {size(p.transferProgress.totalBytes)}</span>
        <progress value={p.transferProgress.bytes} max={Math.max(1,p.transferProgress.totalBytes||1)}/><button onClick={p.cancelTransfer} disabled={p.transferProgress.stage==="cancelling"}>Cancel</button></div>}
      {p.transferResult&&<p role="status">{p.transferResult}</p>}
    </div>}
    <div className="filesVaultSection">{p.backupPanel}</div>
  </div>;
}
