import {listen,type UnlistenFn} from "@tauri-apps/api/event";
import type {SshSessionEvent} from "./backend";

// A single native event listener serves all open terminal tabs. Each SSH
// payload is dispatched only to handlers for its session ID, avoiding O(N)
// event decoding/processing as users open more simultaneous terminals.
const subscribers=new Map<string,Set<(event:SshSessionEvent)=>void>>();
let bridge:Promise<UnlistenFn>|undefined;

function removeSubscriber(id:string,handler:(event:SshSessionEvent)=>void){
  const handlers=subscribers.get(id);
  if(!handlers)return;
  handlers.delete(handler);
  if(handlers.size===0)subscribers.delete(id);
}

export async function subscribeSshSession(
  id:string,
  handler:(event:SshSessionEvent)=>void
):Promise<()=>void>{
  let handlers=subscribers.get(id);
  if(!handlers){
    handlers=new Set();
    subscribers.set(id,handlers);
  }
  handlers.add(handler);

  if(!bridge){
    bridge=listen<SshSessionEvent>("passh7:ssh-session",message=>{
      const targets=subscribers.get(message.payload.id);
      if(!targets)return;
      for(const callback of targets){
        // A failed renderer must not prevent events reaching other terminals.
        try{callback(message.payload)}catch{/* Isolate terminal render failures. */}
      }
    }).catch(error=>{
      bridge=undefined;
      throw error;
    });
  }

  try{await bridge}
  catch(error){
    removeSubscriber(id,handler);
    throw error;
  }
  // Keep one native listener open for the app's lifetime to eliminate
  // unsubscribe/re-subscribe races during rapid terminal tab switches.
  return ()=>removeSubscriber(id,handler);
}
