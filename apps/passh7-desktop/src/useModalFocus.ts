import {useEffect,useRef} from "react";

const FOCUSABLE=[
  'a[href]', 'button:not([disabled])', 'input:not([disabled])',
  'select:not([disabled])', 'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(",");

function visibleFocusTargets(dialog:HTMLElement):HTMLElement[]{
  return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE))
    .filter(item=>item.getClientRects().length>0
      &&item.getAttribute("aria-hidden")!=="true");
}

/**
 * All native-app HTML dialogs share focus containment and keyboard dismissal.
 * Escape dispatches the dialog's own Close/Cancel handler so in-flight SSH,
 * Vault or import tasks still honor disabled close buttons.
 */
export default function useModalFocus(activeDialog:string|null){
  const previousOutsideFocus=useRef<HTMLElement|null>(null);
  // Capture the opener BEFORE React autoFocus moves focus into a new dialog.
  useEffect(()=>{
    const track=(event:FocusEvent)=>{
      const target=event.target;
      if(target instanceof HTMLElement&&!target.closest(".overlay"))
        previousOutsideFocus.current=target;
    };
    document.addEventListener("focusin",track,true);
    return()=>document.removeEventListener("focusin",track,true);
  },[]);
  useEffect(()=>{
    if(!activeDialog)return;
    const dialogs=Array.from(document.querySelectorAll<HTMLElement>(".overlay [role='dialog']"));
    const dialog=dialogs.at(-1);
    if(!dialog)return;
    const active=document.activeElement;
    const previous=previousOutsideFocus.current?.isConnected?previousOutsideFocus.current:
      active instanceof HTMLElement&&!dialog.contains(active)?active:null;
    if(!dialog.hasAttribute("tabindex"))dialog.setAttribute("tabindex","-1");

    // Let children with React autoFocus run before selecting the initial focus.
    const frame=window.requestAnimationFrame(()=>{
      if(!document.contains(dialog))return;
      if(dialog.contains(document.activeElement))return;
      const initial=dialog.querySelector<HTMLElement>("[autofocus]:not([disabled])");
      const targets=visibleFocusTargets(dialog);
      (initial&&initial.getClientRects().length>0?initial:targets[0]||dialog).focus();
    });
    const onKeyDown=(event:KeyboardEvent)=>{
      if(!document.contains(dialog))return;
      // Never allow shortcuts beneath the active modal (including xterm).
      if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==="k"){
        event.preventDefault();event.stopPropagation();return;
      }
      if(event.key==="Escape"){
        const dismiss=dialog.querySelector<HTMLButtonElement>(
          'button[aria-label="Close"]:not([disabled]),button[aria-label="Cancel"]:not([disabled])'
        );
        // Do not close a dialog while its operation is in flight.
        if(dismiss){
          event.preventDefault();event.stopPropagation();
          dismiss.click();
        }else{
          event.preventDefault();event.stopPropagation();
        }
        return;
      }
      if(event.key!=="Tab")return;
      const targets=visibleFocusTargets(dialog);
      if(targets.length===0){event.preventDefault();dialog.focus();return}
      const current=document.activeElement;
      const first=targets[0],last=targets[targets.length-1];
      if(event.shiftKey&&(current===first||!dialog.contains(current))){
        event.preventDefault();last.focus();
      }else if(!event.shiftKey&&(current===last||!dialog.contains(current))){
        event.preventDefault();first.focus();
      }
    };
    document.addEventListener("keydown",onKeyDown,true);
    return()=>{
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown",onKeyDown,true);
      if(previous?.isConnected&&document.querySelectorAll(".overlay [role='dialog']").length===0){
        previous.focus({preventScroll:true});
      }
    };
  },[activeDialog]);
}
