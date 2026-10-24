/** Development-only visual representation of the native SSH terminal.
 * Actual PTY content is rendered by TerminalView in the production App.
 */
import {Server,ShieldCheck,TerminalSquare} from "lucide-react";
export default function TerminalReference(){
  return <main className="main referenceTerminalMain">
    <div className="identity"><div>
      <div className="eyebrow">WORKSPACE / PRODUCTION</div><h1>dev-server</h1>
      <div className="identityMeta"><span><Server size={14}/> deploy@192.0.2.10</span>
        <span>Port 22</span><span>Direct SSH</span>
        <span className="pin ok"><ShieldCheck size={14}/> Fingerprint pinned</span></div>
    </div><div className="identityActions"><button className="primary" disabled>Connect</button>
      <button disabled>Test SSH port</button></div></div>
    <div className="terminal"><div className="terminalbar"><span><TerminalSquare size={15}/> Terminal</span>
      <small>Visual fixture · no SSH connection</small><div className="terminalbarSpacer"/>
      <button className="terminalInfoToggle" disabled>Session details</button></div>
      <div className="sshTabBar"><div className="sshTab active">
        <button type="button" className="sshTabSelect"><span className="sshTabConnectionDot"/> dev-server</button>
      </div></div>
      <div className="referenceTerminalText" aria-label="Illustrative SSH terminal output">
        <div>Welcome to Ubuntu 24.04 LTS</div><div>Last login: Sat Oct 17 12:20:04 2026</div>
        <div className="referenceTerminalPrompt">deploy@dev-server:~$ <span>docker ps</span></div>
        <div>NAMES             IMAGE                 STATUS</div>
        <div>api-server        api:2.4.1             Up 3 days</div>
        <div>postgres          postgres:16           Up 6 days</div>
        <div>redis             redis:7               Up 6 days</div>
        <div className="referenceTerminalPrompt">deploy@dev-server:~$ <span className="terminalCaret">▌</span></div>
      </div>
    </div>
    <footer><span className="footerBrand">DEV-only fixture · No real SSH</span><span>dev-server · visual sample</span>
      <span>PAS7 Studio</span></footer>
  </main>;
}
