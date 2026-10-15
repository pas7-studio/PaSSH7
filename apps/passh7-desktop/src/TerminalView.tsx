import {useEffect,useRef} from "react";
import {Terminal} from "@xterm/xterm";
import {FitAddon} from "@xterm/addon-fit";
import {listen} from "@tauri-apps/api/event";
import type {SshSessionEvent} from "./backend";
import {readySshSession,resizeSshSession,writeSshSession} from "./backend";
import "@xterm/xterm/css/xterm.css";

type Props={id:string;active:boolean;onClosed:(id:string)=>void};
export default function TerminalView({id,active,onClosed}:Props){
  const container=useRef<HTMLDivElement>(null);
  useEffect(()=>{
    const node=container.current;
    if(!node)return;
    const terminal=new Terminal({
      cursorBlink:true,convertEol:false,scrollback:5000,
      fontFamily:"Cascadia Code, Consolas, monospace",
      fontSize:13,theme:{background:"#0e1420",foreground:"#e5ecf6"}
    });
    const fit=new FitAddon();terminal.loadAddon(fit);terminal.open(node);fit.fit();
    let live=true;
    const disposeInput=terminal.onData(data=>{void writeSshSession(id,data).catch(()=>{})});
    const decoder=new TextDecoder();
    const unlistenPromise=listen<SshSessionEvent>("passh7:ssh-session",event=>{
      if(!live||event.payload.id!==id)return;
      if(event.payload.kind==="closed"){onClosed(id);return}
      if(event.payload.data){
        const bytes=Uint8Array.from(atob(event.payload.data),x=>x.charCodeAt(0));
        terminal.write(decoder.decode(bytes,{stream:true}));
      }
    });
    const resize=new ResizeObserver(()=>{
      if(!live)return;
      fit.fit();
      void resizeSshSession(id,terminal.cols,terminal.rows).catch(()=>{});
    });
    resize.observe(node);
    void unlistenPromise.then(()=>{if(live)return readySshSession(id)}).catch(()=>{});
    return ()=>{
      live=false;resize.disconnect();disposeInput.dispose();
      void unlistenPromise.then(unlisten=>unlisten());
      terminal.dispose();
    };
  },[id,onClosed]);
  useEffect(()=>{
    if(active&&container.current){
      // The terminal's ResizeObserver will propagate PTY dimensions.
      const input=container.current.querySelector("textarea");
      if(input instanceof HTMLElement)input.focus();
    }
  },[active]);
  return <div ref={container} className="liveTerminal" style={{display:active?"block":"none"}} aria-label="Interactive SSH terminal"/>;
}
