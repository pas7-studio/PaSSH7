import {useEffect,useMemo,useState,type ReactNode} from "react";
import {ArrowLeft,ArrowRight,ArrowUp,Clipboard,Download,FileText,FolderClosed,FolderPlus,Home,Pencil,RefreshCw,Search,Trash2,Upload} from "lucide-react";
import type {SftpEntry} from "./backend";
import RemoteDirectoryTree from "./RemoteDirectoryTree";
import PaneResizeHandle from "./PaneResizeHandle";
import {defaultPaneSizes,type PaneSizes} from "./preferences";

const size=(n:number|null)=>n===null?"—":n<1024?n+" B":n<1048576?(n/1024).toFixed(1)+" KiB":(n/1048576).toFixed(2)+" MiB";
const full=(dir:string,name:string)=>dir.replace(/\/$/,"")+"/"+name;
const octalPermissions=(permissions:number|null):string=>
  permissions===null?"—":(permissions&0o7777).toString(8).padStart(4,"0");
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
  onMkdir:(name:string)=>void;onDelete:(name:string,isDirectory:boolean)=>void;
  onRename:(name:string,newName:string,isDirectory:boolean)=>void;mutationBusy:boolean;
  preview:Preview;previewBusy:boolean;
  transferBusy:boolean;transferProgress:Progress;transferResult:string|null;
  cancelTransfer:()=>void;backupPanel:ReactNode;
  paneSizes:PaneSizes;onPaneSize:(key:keyof PaneSizes,value:number)=>void;
};
export default function RemoteFilesWorkspace(p:Props){
  const [selected,setSelected]=useState<string>("");
  const [treeWidth,setTreeWidth]=useState(p.paneSizes.filesTree);
  const [inspectorWidth,setInspectorWidth]=useState(p.paneSizes.filesInspector);
  useEffect(()=>setTreeWidth(p.paneSizes.filesTree),[p.paneSizes.filesTree]);
  useEffect(()=>setInspectorWidth(p.paneSizes.filesInspector),[p.paneSizes.filesInspector]);
  const [visibleLimit,setVisibleLimit]=useState(250);
  const [history,setHistory]=useState<string[]>([]);
  const [historyIndex,setHistoryIndex]=useState(-1);
  const dir=p.entries?.session===p.session?p.entries:null;
  const path=dir?.path||p.pathInput;
  useEffect(()=>{setSelected("");setHistory([]);setHistoryIndex(-1);},[p.session]);
  useEffect(()=>{setVisibleLimit(250);},[p.session,path,p.filter,p.sort,p.showHidden]);
  const open=(next:string)=>{
    setSelected("");
    if(next!==path){
      // Include the initial folder so Back can return to it.
      const previous=historyIndex>=0?history.slice(0,historyIndex+1):[path];
      const chain=previous.at(-1)===path?previous:[...previous,path];
      const nextHistory=[...chain,next].slice(-60);
      setHistory(nextHistory);setHistoryIndex(nextHistory.length-1);
    }
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
  const renderedItems=items.slice(0,visibleLimit);
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
      <button disabled={!p.connected||p.busy||p.mutationBusy} onClick={()=>{
        const name=window.prompt("New folder name (created in "+path+"):");
        if(!name)return;
        p.onMkdir(name);
      }}><FolderPlus size={16}/> New folder</button>
      <button disabled={!p.connected||!selectedItem||p.mutationBusy||p.busy} onClick={()=>{
        if(!selectedItem)return;
        const requested=window.prompt("Rename "+selectedItem.name+" to:",selectedItem.name);
        const next=requested?.trim();
        if(!next||next===selectedItem.name)return;
        if(window.confirm("Rename "+JSON.stringify(selectedItem.name)+" to "+JSON.stringify(next)+"?\n\nExisting destinations are checked, but concurrent server-side changes may race. Ensure nobody else is renaming into the same name.")){
          p.onRename(selectedItem.name,next,selectedItem.isDir);
        }
      }}><Pencil size={16}/> Rename</button>
      <button className="dangerButton" disabled={!p.connected||!selectedItem||p.mutationBusy||p.busy} onClick={()=>{
        if(!selectedItem)return;
        if(window.confirm("Delete "+(selectedItem.isDir?"the empty directory ":"the file ")+
          JSON.stringify(selectedItem.name)+" from "+path+"?\n\nThis cannot be undone. Nonempty directories will not be removed.")){
          p.onDelete(selectedItem.name,selectedItem.isDir);
        }
      }}><Trash2 size={16}/> Delete</button>
      <div className="filesToolbarSpacer"/>
      <label className="filesSearch"><Search size={15}/><input value={p.filter} onChange={e=>p.setFilter(e.target.value)} placeholder="Search in folder" aria-label="Filter files"/></label>
      <select value={p.sort} onChange={e=>p.setSort(e.target.value as Props["sort"])} aria-label="File sorting"><option value="folders">Folders first</option><option value="name">By name</option><option value="size">Largest first</option><option value="modified">Newest first</option></select>
    </div>
    {p.error&&<div className="workspaceError" role="alert">{p.error}</div>}
    <div className="filesGrid resizableFilesGrid" style={{gridTemplateColumns:`minmax(150px,${treeWidth}px) 7px minmax(210px,1fr) 7px minmax(245px,${inspectorWidth}px)`}}>
      <div className="filesFolders"><RemoteDirectoryTree session={p.session} connected={p.connected} currentPath={path} onNavigate={open}/>
        <div className="remoteCurrentFolder"><strong>CURRENT DIRECTORY</strong>
          <button type="button" title={path} disabled={!p.connected} onClick={()=>open(path)}><FolderClosed size={14}/><span>{path}</span></button></div>
      </div>
      <PaneResizeHandle label="Remote folder tree width" direction="vertical" value={treeWidth} min={150} max={360}
        defaultValue={defaultPaneSizes.filesTree} onPreview={setTreeWidth} onCommit={n=>{setTreeWidth(n);p.onPaneSize("filesTree",n)}}/>
      <div className="filesTablePane"><div className="paneTitle">{path} <span>{dir?Math.min(items.length,visibleLimit)+" of "+items.length+" entries":"Not loaded"}</span></div>
        <div className="filesTableWrap"><table className="workspaceTable"><thead><tr><th>Name</th><th>Size</th><th>Modified</th><th>Permissions</th><th>Type</th></tr></thead><tbody>
          {renderedItems.map(item=><tr key={item.name} tabIndex={0} role="row" aria-selected={item.name===selected} className={item.name===selected?"selected":""}
            onClick={()=>setSelected(item.name)}
            onDoubleClick={()=>item.isDir?open(full(path,item.name)):p.readPreview(full(path,item.name))}
            onKeyDown={e=>{
              if(e.key==="Enter"){e.preventDefault();setSelected(item.name);item.isDir?open(full(path,item.name)):p.readPreview(full(path,item.name))}
              else if(e.key===" "){e.preventDefault();setSelected(item.name)}
              else if(e.key==="ArrowDown"||e.key==="ArrowUp"){
                e.preventDefault();
                const offset=e.key==="ArrowDown"?1:-1;
                const next=renderedItems[Math.max(0,Math.min(renderedItems.length-1,renderedItems.indexOf(item)+offset))];
                if(next){
                  setSelected(next.name);
                  const rows=e.currentTarget.closest("tbody")?.querySelectorAll<HTMLTableRowElement>("tr[tabindex]");
                  const target=rows?.[renderedItems.indexOf(next)];
                  target?.focus();target?.scrollIntoView({block:"nearest"});
                }
              }
              else if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="c"){e.preventDefault();void navigator.clipboard.writeText(full(path,item.name))}
            }}>
            <td><span className="fileName">{item.isDir?<FolderClosed size={15}/>:<FileText size={15}/>} {item.name}</span></td>
            <td>{item.isDir?"—":size(item.sizeBytes)}</td>
            <td>{item.modifiedAt!==null?new Date(item.modifiedAt*1000).toLocaleString():"—"}</td>
            <td><code title="Remote POSIX mode (not always supplied by SFTP server)">{octalPermissions(item.unixPermissions)}</code></td>
            <td>{item.isDir?"Folder":(item.name.split(".").at(-1)||"File").toUpperCase()}</td></tr>)}
        </tbody></table>
        {items.length>visibleLimit&&<div className="filesMoreRows"><span>Showing {renderedItems.length.toLocaleString()} of {items.length.toLocaleString()} items. Narrow the search or load more.</span><button type="button" onClick={()=>setVisibleLimit(current=>Math.min(current+250,items.length))}>Load 250 more</button></div>}
        {dir&&items.length===0&&<div className="workspaceEmpty">{p.filter?"No matching files. Clear the search to see the directory.":"This directory is empty."}</div>}
        {!p.connected&&<div className="workspaceEmpty">Connect to <strong>{p.host}</strong> to browse files. Select your host and click Connect.</div>}
        {p.connected&&!dir&&<div className="workspaceEmpty">Choose a directory and click Open to load its contents.</div>}
        </div>
      </div>
      <PaneResizeHandle label="File details inspector width" direction="vertical" value={inspectorWidth} min={245} max={500}
        invert defaultValue={defaultPaneSizes.filesInspector} onPreview={setInspectorWidth}
        onCommit={n=>{setInspectorWidth(n);p.onPaneSize("filesInspector",n)}}/>
      <aside className="filesInspector"><div className="paneTitle">FILE DETAILS</div>
        {selectedItem?<><div className="inspectorFile"><FileText size={28}/><strong>{selectedItem.name}</strong><small>{selectedItem.isDir?"Directory":"Remote file"}</small></div>
          <dl><dt>Size</dt><dd>{size(selectedItem.sizeBytes)}</dd><dt>Modified</dt><dd>{selectedItem.modifiedAt!==null?new Date(selectedItem.modifiedAt*1000).toLocaleString():"Unknown"}</dd><dt>Permissions</dt><dd><code>{octalPermissions(selectedItem.unixPermissions)}</code></dd><dt>Owner ID</dt><dd>{selectedItem.ownerId??"Unknown"}</dd><dt>Group ID</dt><dd>{selectedItem.groupId??"Unknown"}</dd><dt>Path</dt><dd className="filePath">{selectedPath}</dd></dl>
          <div className="inspectorActions"><button onClick={()=>navigator.clipboard.writeText(selectedPath)}><Clipboard size={14}/> Copy path</button>
          {selectedItem.isDir?<button onClick={()=>open(selectedPath)}>Open folder</button>:<><button onClick={()=>p.readPreview(selectedPath)} disabled={p.previewBusy}>Preview</button><button onClick={()=>p.download(selectedPath)} disabled={p.transferBusy}>Download</button></>}</div>
          {!selectedItem.isDir&&<div className="fileCodePreview"><strong>READ-ONLY PREVIEW</strong>{p.previewBusy?<p>Loading preview…</p>:preview?<pre>{preview.body}</pre>:<p>Select Preview to read UTF-8 text. Binary files may not be previewable.</p>}</div>}
        </>:<div className="workspaceEmpty">Select a file to see details and preview its contents.</div>}
      </aside>
    </div>
    <div className="wideTransferQueue"><strong>Transfer queue</strong>
      {p.transferProgress?.session===p.session&&<div className="transferRow"><span>{p.transferProgress.direction==="upload"?"Uploading":"Downloading"} · {p.transferProgress.stage}</span><span>{size(p.transferProgress.bytes)} / {size(p.transferProgress.totalBytes)}</span>
        <progress value={p.transferProgress.bytes} max={Math.max(1,p.transferProgress.totalBytes||1)}/><button onClick={p.cancelTransfer} disabled={p.transferProgress.stage==="cancelling"}>Cancel</button></div>}
      {p.transferResult&&<p role="status">{p.transferResult}</p>}
      {!(p.transferProgress?.session===p.session)&&!p.transferResult&&<p className="transferQueueEmpty">No active transfers. Upload and download activity will appear here.</p>}
    </div>
    <div className="filesVaultSection">{p.backupPanel}</div>
  </div>;
}
