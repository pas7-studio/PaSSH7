import type {LucideIcon} from "lucide-react";
import type {ReactNode} from "react";

export type WorkspaceStatusKind="connected"|"offline"|"trusted"|"warning";

/** One title/status hierarchy for every first-class workspace. */
export function WorkspaceHeader(p:{
  icon:LucideIcon;title:string;description:string;
  status?:WorkspaceStatusKind;statusText?:string;trailing?:ReactNode
}){
  const Icon=p.icon;
  return <header className="widePageTitle workspacePageHeader">
    <div className="workspacePageIcon" aria-hidden="true"><Icon size={24}/></div>
    <div className="workspacePageHeading"><h1>{p.title}</h1><p>{p.description}</p></div>
    {(p.statusText||p.trailing)&&<div className="workspacePageMeta">
      {p.statusText&&<WorkspaceStatus kind={p.status||"offline"}>{p.statusText}</WorkspaceStatus>}
      {p.trailing}
    </div>}
  </header>;
}

/** Shared status scale: not every trusted host is connected. */
export function WorkspaceStatus(p:{kind:WorkspaceStatusKind;children:ReactNode}){
  return <span className={"workspaceStatus workspaceStatus--"+p.kind} role="status">
    <span className="workspaceStatusDot" aria-hidden="true"/>{p.children}
  </span>;
}

export function WorkspaceEmpty(p:{
  icon:LucideIcon;title:string;description:string;action?:ReactNode
}){
  const Icon=p.icon;
  return <div className="workspaceEmptyState">
    <div className="workspaceEmptyIcon"><Icon size={22}/></div>
    <strong>{p.title}</strong><p>{p.description}</p>
    {p.action&&<div className="workspaceEmptyActions">{p.action}</div>}
  </div>;
}

/** Unified count/label metric used by Connections and Port Forwarding. */
export function WorkspaceMetric(p:{
  icon:LucideIcon;label:string;value:ReactNode;detail?:string;intent?:"primary"|"good"|"warning"
}){
  const Icon=p.icon;
  return <div className={"workspaceMetric "+(p.intent?"workspaceMetric--"+p.intent:"")}>
    <div className="workspaceMetricHeading"><Icon size={18}/><span>{p.label}</span></div>
    <strong>{p.value}</strong>
    {p.detail&&<small>{p.detail}</small>}
  </div>;
}
