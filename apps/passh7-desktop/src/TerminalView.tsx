import {useEffect,useRef} from "react";
import {Terminal} from "@xterm/xterm";
import {FitAddon} from "@xterm/addon-fit";
import {subscribeSshSession} from "./sshEventBus";
import {closeSshSession,readySshSession,resizeSshSession,writeSshSession} from "./backend";
import "@xterm/xterm/css/xterm.css";

type Props={id:string;active:boolean;onClosed:(id:string,detail?:string)=>void};

const INPUT_BATCH_MS=3;
const OUTPUT_BATCH_MS=4;
const MAX_INPUT_CHARS=4096;
const MAX_OUTPUT_BATCH_BYTES=64*1024;

// A serial input stream is essential: concurrent Tauri invoke() calls can
// complete out of order even when onData() events were delivered in order.
function createInputSender(id:string,terminal:Terminal,isLive:()=>boolean){
  let inputBuffer="";
  let timer:number|undefined;
  let chain:Promise<void>=Promise.resolve();
  let errorShown=false;
  const flush=()=>{
    if(timer!==undefined){window.clearTimeout(timer);timer=undefined;}
    if(!inputBuffer||errorShown)return;
    const payload=inputBuffer;
    inputBuffer="";
    chain=chain.then(()=>writeSshSession(id,payload)).catch(error=>{
      if(!isLive()||errorShown)return;
      errorShown=true;
      terminal.writeln("\r\n[PaSSH7: terminal input failed: "+String(error)+"]");
    });
  };
  const accept=(data:string)=>{
    if(!data||errorShown)return;
    // Large pasted text is split on Unicode code point boundaries to respect
    // the native 64 KiB input cap without corrupting surrogate pairs.
    if(data.length>MAX_INPUT_CHARS){
      flush();
      let part="";
      for(const codePoint of data){
        if(part.length+codePoint.length>MAX_INPUT_CHARS){
          inputBuffer=part;
          flush();
          part="";
        }
        part+=codePoint;
      }
      data=part;
    }
    inputBuffer+=data;
    // Treat a whole xterm event as one unit: escape sequences (arrows, F-keys)
    // may have multiple bytes which must not be separated by a delay.
    if(inputBuffer.length>=MAX_INPUT_CHARS || /[\r\n\x00-\x1f\x7f]/.test(data)){
      flush();
    }else if(timer===undefined){
      timer=window.setTimeout(flush,INPUT_BATCH_MS);
    }
  };
  return {accept,flush,dispose:()=>{
    // Send what was already typed before a React unmount/remount.
    flush();
    if(timer!==undefined)window.clearTimeout(timer);
  }};
}

export default function TerminalView({id,active,onClosed}:Props){
  const container=useRef<HTMLDivElement>(null);
  const fitRef=useRef<FitAddon|null>(null);
  const termRef=useRef<Terminal|null>(null);
  useEffect(()=>{
    const node=container.current;
    if(!node)return;
    const terminal=new Terminal({
      cursorBlink:true,convertEol:false,scrollback:5000,
      fontFamily:"Cascadia Code, Consolas, monospace",
      fontSize:13,theme:{background:"#0e1420",foreground:"#e5ecf6"}
    });
    const fit=new FitAddon();terminal.loadAddon(fit);terminal.open(node);
    fitRef.current=fit;termRef.current=terminal;
    if(node.clientWidth>40&&node.clientHeight>40)fit.fit();
    let live=true;
    const input=createInputSender(id,terminal,()=>live);
    const disposeInput=terminal.onData(input.accept);

    // The SSH event stream is base64 because it contains arbitrary PTY bytes,
    // including non-UTF-8 data and ANSI controls. xterm parses Uint8Array
    // directly; avoiding TextDecoder and one write() per network packet keeps
    // the renderer responsive when a process streams lots of output.
    const outputChunks:Uint8Array[]=[];
    let outputLength=0;
    let outputTimer:number|undefined;
    const flushOutput=()=>{
      if(outputTimer!==undefined){window.clearTimeout(outputTimer);outputTimer=undefined;}
      if(outputLength===0)return;
      const bytes=new Uint8Array(outputLength);
      let offset=0;
      for(const chunk of outputChunks){bytes.set(chunk,offset);offset+=chunk.length;}
      outputChunks.length=0;outputLength=0;
      terminal.write(bytes);
    };
    let lastOutputAt=0;
    const receiveOutput=(encoded:string)=>{
      const raw=atob(encoded);
      const chunk=new Uint8Array(raw.length);
      for(let i=0;i<raw.length;i++)chunk[i]=raw.charCodeAt(i);
      const now=performance.now();
      const inBurst=lastOutputAt>0&&now-lastOutputAt<=12;
      lastOutputAt=now;
      outputChunks.push(chunk);
      outputLength+=chunk.length;
      // Shell echo and short prompts render immediately. Burst output from
      // ls, logs and coding agents is coalesced to minimize xterm layout work.
      if(outputLength>=MAX_OUTPUT_BATCH_BYTES||!inBurst)flushOutput();
      else if(outputTimer===undefined)outputTimer=window.setTimeout(flushOutput,OUTPUT_BATCH_MS);
    };
    const unsubscribePromise=subscribeSshSession(id,event=>{
      if(!live||event.id!==id)return;
      if(event.kind==="closed"){
        flushOutput();
        onClosed(id,event.detail);
        return;
      }
      if(event.data)receiveOutput(event.data);
    });

    let previousSize="";
    const resize=new ResizeObserver(()=>{
      if(!live||node.clientWidth<=40||node.clientHeight<=40)return;
      fit.fit();
      const dimensions=terminal.cols+"x"+terminal.rows;
      if(previousSize===dimensions)return;
      previousSize=dimensions;
      if(terminal.cols>=20&&terminal.rows>=5){
        void resizeSshSession(id,terminal.cols,terminal.rows).catch(()=>{});
      }
    });
    resize.observe(node);
    // Subscribe before signalling Ready to release buffered remote PTY output.
    void unsubscribePromise.then(async ()=>{
      if(!live)return;
      try { await readySshSession(id); }
      catch(error) {
        if(live){
          flushOutput();
          terminal.writeln("\r\n[PaSSH7: SSH terminal initialization failed: "+String(error)+"]");
          void closeSshSession(id).catch(()=>{});
          onClosed(id,"Terminal event handshake failed");
        }
      }
    }).catch(error=>{
      if(live){
        flushOutput();
        terminal.writeln("\r\n[PaSSH7: event listener failed: "+String(error)+"]");
        void closeSshSession(id).catch(()=>{});
        onClosed(id,"Could not subscribe to terminal events");
      }
    });
    return ()=>{
      input.dispose();
      live=false;
      flushOutput();
      resize.disconnect();disposeInput.dispose();
      if(outputTimer!==undefined)window.clearTimeout(outputTimer);
      void unsubscribePromise.then(unsubscribe=>unsubscribe());
      terminal.dispose();fitRef.current=null;termRef.current=null;
    };
  },[id,onClosed]);
  useEffect(()=>{
    if(active&&container.current){
      if(container.current.clientWidth>40&&container.current.clientHeight>40){
        fitRef.current?.fit();
        const term=termRef.current;
        if(term&&term.cols>=20&&term.rows>=5)void resizeSshSession(id,term.cols,term.rows).catch(()=>{});
      }
      const input=container.current.querySelector("textarea");
      if(input instanceof HTMLElement)input.focus();
    }
  },[active,id]);
  return <div ref={container} className="liveTerminal" style={{display:active?"block":"none"}} aria-label="Interactive SSH terminal"/>;
}
