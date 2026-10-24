import {useRef,type PointerEvent as ReactPointerEvent,type KeyboardEvent as ReactKeyboardEvent} from "react";

type Props={
  label:string;
  direction:"horizontal"|"vertical";
  value:number;
  min:number;
  max:number;
  defaultValue:number;
  onPreview:(next:number)=>void;
  onCommit:(next:number)=>void;
  invert?:boolean;
  className?:string;
};

const clamp=(n:number,min:number,max:number)=>Math.max(min,Math.min(max,Math.round(n)));

/** Resize split panels via captured pointer and keyboard; persist only on commit. */
export default function PaneResizeHandle(p:Props){
  const gesture=useRef<{pointerId:number;start:number;initial:number;current:number}|null>(null);
  const axis=p.direction==="vertical"?"clientX":"clientY";
  const move=(e:ReactPointerEvent<HTMLDivElement>)=>{
    const active=gesture.current;
    if(!active||e.pointerId!==active.pointerId)return;
    const delta=((e[axis] as number)-active.start)*(p.invert?-1:1);
    const next=clamp(active.initial+delta,p.min,p.max);
    if(next===active.current)return;
    active.current=next;p.onPreview(next);
  };
  const finish=(e:ReactPointerEvent<HTMLDivElement>)=>{
    const active=gesture.current;
    if(!active||e.pointerId!==active.pointerId)return;
    gesture.current=null;
    if(e.currentTarget.hasPointerCapture(e.pointerId))e.currentTarget.releasePointerCapture(e.pointerId);
    p.onCommit(active.current);
  };
  const onKeyDown=(e:ReactKeyboardEvent<HTMLDivElement>)=>{
    const horizontalKey=p.direction==="vertical";
    const amount=e.shiftKey?32:8;
    let change=0;
    if(horizontalKey){
      if(e.key==="ArrowLeft")change=-amount;
      else if(e.key==="ArrowRight")change=amount;
    } else {
      if(e.key==="ArrowUp")change=-amount;
      else if(e.key==="ArrowDown")change=amount;
    }
    if(e.key==="Home"){e.preventDefault();p.onCommit(p.min);return}
    if(e.key==="End"){e.preventDefault();p.onCommit(p.max);return}
    if(e.key==="Enter"){e.preventDefault();p.onCommit(p.defaultValue);return}
    if(!change)return;
    e.preventDefault();
    const next=clamp(p.value+(p.invert?-change:change),p.min,p.max);
    p.onCommit(next);
  };
  return <div className={"paneResizeHandle "+(p.direction==="vertical"?"vertical":"horizontal")+" "+(p.className||"")}
    role="separator" tabIndex={0} aria-label={p.label} aria-orientation={p.direction}
    aria-valuenow={p.value} aria-valuemin={p.min} aria-valuemax={p.max}
    title={"Drag to resize "+p.label+". Arrow keys: 8px, Shift+arrow: 32px; Enter: reset."}
    onPointerDown={e=>{
      if(e.button!==0)return;
      e.preventDefault();
      gesture.current={pointerId:e.pointerId,start:e[axis] as number,initial:p.value,current:p.value};
      e.currentTarget.setPointerCapture(e.pointerId);
    }}
    onPointerMove={move}
    onPointerUp={finish}
    onPointerCancel={finish}
    onDoubleClick={()=>p.onCommit(p.defaultValue)}
    onKeyDown={onKeyDown}
  ><span className="paneResizeHandleGrip" aria-hidden="true"/></div>;
}
