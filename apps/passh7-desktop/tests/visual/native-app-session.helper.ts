import {expect,type Page} from "@playwright/test";

/**
 * Browser-only Tauri IPC simulator; not a live SSH / WebView2 acceptance.
 * Runs at the END of the single-page visual smoke. The npm-packaged
 * Chromium is --single-process and may crash if Playwright opens a second
 * browser/page. Reusing the original page avoids that resource hazard.
 */
export async function runNativeAppSession(page:Page){
  const browserErrors:string[]=[];
  page.on("pageerror",error=>browserErrors.push(error.message));
  await page.addInitScript(()=>{
    type MockEvent={event:string;id:number;payload:unknown};
    type MockInvoke=(cmd:string,args?:Record<string,unknown>)=>Promise<unknown>;
    const callbacks=new Map<number,(data:MockEvent)=>void>();
    const activeListeners=new Map<number,{event:string;callbackId:number}>();
    const writes:Array<{id:string;data:string}>=[];
    const resized:Array<{id:string;cols:number;rows:number}>=[];
    const ready:string[]=[];
    let localTouches=0;
    let vaultLive=true;
    const idlePolicyChanges:number[]=[];
    const delayedWrites:Array<()=>void>=[];
    let dockerListFailure="";
    const exports:Array<{containerName:string;contents:string}>=[];
    const delayedSftp:Array<()=>void>=[];
    const agentProbes:Array<{id:string;agent:string}>=[];
    const localAgentLaunches:Array<{id:string;agent:string}>=[];
    const mockGrants:Array<{id:string;agent:"codex"|"claude"|"opencode";sessionId:string;host:string;ageSeconds:number;status:"active"|"expired"|"disconnected"}>=[];
    const restoredGrants:Array<{id:string;sessionId:string}>=[];
    const localAgentProbes:string[]=[];
    const delayedForwards:Array<()=>void>=[];
    const forwards=new Map<string,Array<{localPort:number;targetHost:string;remotePort:number}>>();
    const file=(name:string)=>({name,isDir:false,sizeBytes:100,modifiedAt:null,
      unixPermissions:null,ownerId:null,groupId:null});
    const sessions=[{id:"session-a",alias:"linux-test"},{id:"session-b",alias:"linux-test"},{id:"session-c",alias:"win-test"}];
    const hosts=[
      {alias:"linux-test",hostname:"192.0.2.10",port:22,username:"tester",identityAlias:"",hostKeyPinned:true,
        hasSavedCredentials:true,savedAuthMode:"password",backupDirectory:null,jumpAlias:null},
      {alias:"win-test",hostname:"192.0.2.11",port:22,username:"tester",identityAlias:"",hostKeyPinned:true,
        hasSavedCredentials:true,savedAuthMode:"password",backupDirectory:null,jumpAlias:null}
    ];
    let callbackId=1;
    let eventId=1;
    const invoke:MockInvoke=async(command,args={})=>{
      switch(command){
        case "vault_exists":return true;
        case "vault_status":return vaultLive;
        case "vault_touch":localTouches++;return vaultLive;
        case "vault_lock":vaultLive=false;return null;
        case "vault_unlock":vaultLive=true;return null;
        case "vault_set_idle_timeout":idlePolicyChanges.push(Number(args.minutes));return Number(args.minutes);
        case "vault_idle_remaining":return idlePolicyChanges.at(-1)===0?null:180;
        case "terminal_clipboard_read":return "clipboard-paste-probe-✓";
        case "vault_list_hosts":return hosts;
        case "vault_list_identities":return [];
        case "ssh_session_list":return sessions;
        case "ssh_session_forward_list":return forwards.get(String(args.id))||[];
        case "ssh_session_forward_start": {
          const id=String(args.id),port=Number(args.localPort);
          if(port===19001)await new Promise<void>(resolve=>delayedForwards.push(resolve));
          forwards.set(id,[...(forwards.get(id)||[]),{localPort:port,
            targetHost:String(args.targetHost),remotePort:Number(args.remotePort)}]);
          return null;
        }
        case "ssh_session_forward_stop": {
          const id=String(args.id);
          forwards.set(id,(forwards.get(id)||[]).filter(item=>item.localPort!==Number(args.localPort)));
          return null;
        }
        case "ssh_session_sftp_list":
          if(args.id==="session-b")return new Promise(resolve=>{
            delayedSftp.push(()=>resolve([file("from-linux.txt")]));
          });
          if(args.id==="session-c")return [file("from-windows.txt")];
          return [file("from-first-terminal.txt")];
        case "ssh_session_close":
          // This session remains alive when the backend rejects its Close.
          if(args.id==="session-b")throw Error("SSH Close rejected by test backend");
          return null;
        case "ssh_session_ready":ready.push(String(args.id));return null;
        case "ssh_session_resize":resized.push({id:String(args.id),cols:Number(args.cols),rows:Number(args.rows)});return null;
        case "ssh_session_write":
          writes.push({id:String(args.id),data:String(args.data)});
          if(args.data==="queue-block")await new Promise<void>(resolve=>delayedWrites.push(resolve));
          return null;
        case "ssh_session_docker_list":
          if(dockerListFailure)throw Error(dockerListFailure);
          return JSON.stringify({
          ID:"aaaaaaaaaaaa",Names:"api-test",Image:"api:latest",State:"running",Status:"Up 1 hour",Ports:""
        });
        case "ssh_session_docker_catalog":return "";
        case "local_agent_probe":
          localAgentProbes.push(String(args.agent));
          return {installed:args.agent==="opencode",path:args.agent==="opencode"?"C:\\Tools\\opencode.cmd":null,
            diagnostic:args.agent==="opencode"?"Local signed-in CLI ready":"Not installed"};
        case "local_agent_launch":
          localAgentLaunches.push({id:String(args.id),agent:String(args.agent)});
          return "Launched local "+String(args.agent)+" with SSH tool access";
        case "local_agent_connections":return mockGrants.map(grant=>({...grant}));
        case "local_agent_reauthorize":{
          const grant=mockGrants.find(g=>g.id===args.id);
          const target=sessions.find(s=>s.id===args.sessionId);
          if(!grant||!target||grant.host!==target.alias)throw Error("Same-host grant only");
          grant.sessionId=target.id;grant.status="active";grant.ageSeconds=0;
          restoredGrants.push({id:grant.id,sessionId:target.id});
          return true;
        }
        case "local_agent_revoke":{
          const i=mockGrants.findIndex(g=>g.id===args.id);
          if(i<0)return false;
          mockGrants.splice(i,1);return true;
        }
        case "ssh_session_agent_probe":
          agentProbes.push({id:String(args.id),agent:String(args.agent)});
          if(args.agent==="codex")return {installed:true,version:"codex test v1",
            platform:"unix",source:"PATH",location:null,desktopApp:null,
            launchCommand:"codex",diagnostic:null};
          if(args.agent==="claude")return {installed:false,version:null,
            platform:"windows",source:null,location:null,desktopApp:"Claude",
            launchCommand:null,diagnostic:"GUI only"};
          return {installed:false,version:null,platform:"unix",
            source:null,location:null,desktopApp:null,
            launchCommand:null,diagnostic:"Not installed"};
        case "ssh_session_docker_inspect":return JSON.stringify({
          image:"api:latest",created:null,startedAt:null,finishedAt:null,restartPolicy:null,mounts:[],networks:[]
        });
        case "ssh_session_docker_logs":
          return args.id==="session-c"?"2026-10-17 INFO Windows container only\n":
            "2026-10-17 INFO hello\n2026-10-17 ERROR warning\n";
        case "docker_save_visible_logs":
          exports.push({containerName:String(args.containerName),contents:String(args.contents)});
          return "Saved filtered logs in native dialog (IPC simulator)";
        case "app_build_info":return {version:"test",publisher:"PAS7 Studio",repository:"pas7-studio/PaSSH7",
          commit:"mocked",builtAt:"test",runNumber:"test",target:"IPC simulator"};
        case "plugin:event|listen":
          activeListeners.set(eventId,{event:String(args.event),callbackId:Number(args.handler)});
          return eventId++;
        case "plugin:event|unlisten":
          activeListeners.delete(Number(args.eventId));
          return null;
        default:throw Error("Unexpected IPC command: "+command);
      }
    };
    const mock={
      invoke,
      transformCallback(callback?: (value:MockEvent)=>void){
        const id=callbackId++;
        if(callback)callbacks.set(id,callback);
        return id;
      },
      convertFileSrc(value:string){return value;}
    };
    const root=window as typeof window&{
      __TAURI_INTERNALS__:typeof mock;
      __TAURI_EVENT_PLUGIN_INTERNALS__:{unregisterListener:(event:string,id:number)=>void};
      __mockSshBridge:unknown;
    };
    root.__TAURI_INTERNALS__=mock;
    root.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
    root.__mockSshBridge={
      writes,resized,ready,exports,agentProbes,localAgentProbes,localAgentLaunches,restoredGrants,idlePolicyChanges,
      addGrant(){mockGrants.push({id:"cccccccccccccccccccccccccccccccc",
        agent:"codex",sessionId:"session-a",host:"linux-test",
        ageSeconds:13*3600,status:"expired"});},
      localTouches(){return localTouches;},
      failDockerList(message:string){dockerListFailure=message;},
      pendingForwards(){return delayedForwards.length;},
      releaseForwards(){for(const done of delayedForwards.splice(0))done();},
      pendingWrites(){return delayedWrites.length;},
      releaseWrites(){for(const done of delayedWrites.splice(0))done();},
      pendingSftp(){return delayedSftp.length;},
      releaseSftp(){for(const done of delayedSftp.splice(0))done();},
      emit(event:string,payload:unknown){
        for(const [id,listener] of activeListeners){
          if(listener.event===event)callbacks.get(listener.callbackId)?.({event,id,payload});
        }
      }
    };
  });
  await page.goto("/",{waitUntil:"domcontentloaded"});
  await expect(page.locator(".workspaceNav")).toBeVisible();
  await page.locator(".workspaceNav button").filter({hasText:"Terminal"}).click();
  await expect.poll(()=>page.evaluate(()=>
    (window as unknown as {__mockSshBridge:{localTouches:()=>number}})
      .__mockSshBridge.localTouches()
  )).toBeGreaterThan(0);
  await expect(page.locator(".sessionStripItem")).toHaveCount(3);
  await expect(page.locator(".terminalDockSlot .xterm")).toHaveCount(1);
  await expect(page.locator(".terminalParked .xterm")).toHaveCount(2);
  await page.evaluate(()=>{
    const terminal=document.querySelector(".terminalDockSlot .xterm");
    if(!terminal)throw Error("No original SSH terminal");
    terminal.setAttribute("data-original-instance","kept");
  });
  await expect.poll(()=>page.evaluate(()=>
    ((window as unknown as {__mockSshBridge:{ready:string[]}}).__mockSshBridge.ready.length)
  )).toBeGreaterThanOrEqual(3);
  const initialReady=await page.evaluate(()=>
    (window as unknown as {__mockSshBridge:{ready:string[]}}).__mockSshBridge.ready.length
  );
  await page.locator(".workspaceNav button").filter({hasText:"AI Agents"}).click();
  await expect(page.locator(".agentTerminalFrame .xterm")).toHaveCount(1);
  await expect(page.locator(".agentTerminalFrame .xterm[data-original-instance='kept']")).toHaveCount(1);
  const chooser=page.getByRole("combobox",{name:"SSH target for AI assistant"});
  await chooser.selectOption("session-b");
  await expect(page.locator(".agentTerminalFrame .terminalSessionSurface")).toHaveAttribute("data-ssh-session","session-b");

  // Migrate the old remote-only agent view: when a remote CLI is absent,
  // Auto uses an already signed-in local CLI and grants access only to the
  // selected native SSH session (not to the SSH identity or account password).
  await page.evaluate(()=>{window.confirm=()=>true;});
  await page.getByRole("combobox",{name:"Coding assistant"}).selectOption("opencode");
  await page.getByRole("button",{name:"Launch OpenCode"}).click();
  await expect(page.locator(".agentQuickLaunch .workspaceNotice")).toContainText("Launched local opencode");
  const launches=await page.evaluate(()=>
    (window as unknown as {__mockSshBridge:{localAgentLaunches:Array<{id:string;agent:string}>}})
      .__mockSshBridge.localAgentLaunches
  );
  expect(launches).toEqual([{id:"session-b",agent:"opencode"}]);
  await page.getByRole("button",{name:"Remote SSH",exact:true}).click();
  await expect(page.getByRole("button",{name:"Run OpenCode over SSH"})).toBeVisible();
  await page.getByRole("button",{name:"Auto",exact:true}).click();
  await page.getByRole("combobox",{name:"Coding assistant"}).selectOption("codex");
  await page.getByRole("button",{name:"Focus console"}).click();
  await page.keyboard.type("echo persistent");
  await page.keyboard.press("Enter");
  // Ctrl+V must read the actual clipboard and paste text, never send ^V.
  await page.keyboard.press("Control+v");
  await expect.poll(()=>page.evaluate(()=>
    (window as unknown as {__mockSshBridge:{writes:Array<{id:string;data:string}>}})
      .__mockSshBridge.writes.some(entry=>entry.id==="session-b"&&entry.data.includes("clipboard-paste-probe-✓"))
  )).toBe(true);
  expect(await page.evaluate(()=>
    (window as unknown as {__mockSshBridge:{writes:Array<{id:string;data:string}>}})
      .__mockSshBridge.writes.some(entry=>entry.data==="\u0016")
  )).toBe(false);
  await expect.poll(()=>page.evaluate(()=>
    (window as unknown as {__mockSshBridge:{writes:Array<{id:string;data:string}>}}).__mockSshBridge.writes.length
  )).toBeGreaterThan(0);
  const writes=await page.evaluate(()=>
    (window as unknown as {__mockSshBridge:{writes:Array<{id:string;data:string}>}}).__mockSshBridge.writes
  );
  expect(writes.every(item=>item.id==="session-b")).toBe(true);
  await page.getByRole("button",{name:"Focus console"}).click();
  await page.keyboard.type("partial-shell-input");
  // Simulate clicking outside xterm immediately before an agent launch.
  // The pending keystrokes must be flushed even without Enter.
  await page.getByRole("heading",{name:"SSH context"}).click();
  await expect.poll(()=>page.evaluate(()=>
    (window as unknown as {__mockSshBridge:{writes:Array<{id:string;data:string}>}})
      .__mockSshBridge.writes.some(item=>item.id==="session-b"&&item.data.includes("partial-shell-input"))
  )).toBe(true);
  await chooser.selectOption("session-a");
  await expect(page.locator(".agentTerminalFrame .xterm[data-original-instance='kept']")).toHaveCount(1);
  await page.getByRole("button",{name:"Expand console"}).click();
  await expect(page.locator(".agentTerminalFrame")).toHaveClass(/expanded/);
  await page.locator(".workspaceNav button").filter({hasText:"Terminal"}).click();
  await expect(page.locator(".terminalDockSlot .xterm[data-original-instance='kept']")).toHaveCount(1);
  await expect(page.locator(".terminalSessionSurface .xterm")).toHaveCount(3);
  const afterReady=await page.evaluate(()=>
    (window as unknown as {__mockSshBridge:{ready:string[]}}).__mockSshBridge.ready.length
  );
  expect(afterReady).toBe(initialReady);

  // Native SSH PTY writes must remain FIFO across xterm, button-triggered
  // agents and snippets. Block one native write, queue the next write for
  // the same session and prove another session is independently writable.
  await page.evaluate(()=>{
    void (async()=>{
      const backend=await import("/src/backend.ts");
      const first=backend.writeSshSession("session-a","queue-block");
      const later=backend.writeSshSession("session-a","queue-later");
      const separate=backend.writeSshSession("session-b","queue-independent");
      (window as unknown as {__sshWriteQueueDone:Promise<void>})
        .__sshWriteQueueDone=Promise.all([first,later,separate]).then(()=>{});
    })();
  });
  await expect.poll(()=>page.evaluate(()=>
    (window as unknown as {__mockSshBridge:{pendingWrites:()=>number}})
      .__mockSshBridge.pendingWrites()
  )).toBe(1);
  const beforeRelease=await page.evaluate(()=>
    (window as unknown as {__mockSshBridge:{writes:Array<{id:string;data:string}>}})
      .__mockSshBridge.writes.filter(x=>x.data.startsWith("queue-"))
  );
  expect(beforeRelease).toEqual([
    {id:"session-a",data:"queue-block"},
    {id:"session-b",data:"queue-independent"}
  ]);
  await page.evaluate(()=>{
    (window as unknown as {__mockSshBridge:{releaseWrites:()=>void}})
      .__mockSshBridge.releaseWrites();
  });
  await page.evaluate(async()=>await (window as unknown as {__sshWriteQueueDone:Promise<void>}).__sshWriteQueueDone);
  const afterRelease=await page.evaluate(()=>
    (window as unknown as {__mockSshBridge:{writes:Array<{id:string;data:string}>}})
      .__mockSshBridge.writes.filter(x=>x.data.startsWith("queue-"))
  );
  expect(afterRelease).toEqual([
    {id:"session-a",data:"queue-block"},
    {id:"session-b",data:"queue-independent"},
    {id:"session-a",data:"queue-later"}
  ]);

  // A host may have several active PTYs. Restore the user's last chosen PTY,
  // rather than switching silently back to session-a on return.
  await page.locator(".workspaceNav button").filter({hasText:"AI Agents"}).click();
  await page.getByRole("combobox",{name:"SSH target for AI assistant"}).selectOption("session-b");
  await page.locator(".sidebar .host").filter({hasText:"win-test"}).click();
  await expect(page.locator(".agentTerminalFrame .terminalSessionSurface"))
    .toHaveAttribute("data-ssh-session","session-c");
  await page.locator(".sidebar .host").filter({hasText:"linux-test"}).click();
  await expect(page.locator(".agentTerminalFrame .terminalSessionSurface"))
    .toHaveAttribute("data-ssh-session","session-b");

  // Reject Close in native IPC and then verify the frontend keeps the live
  // xterm (including its input buffer) instead of claiming disconnection.
  await page.locator(".workspaceNav button").filter({hasText:"Terminal"}).click();
  await page.getByRole("button",{name:"Disconnect linux-test"}).last().click();
  await expect(page.locator(".globalSessionNotice")).toContainText("Could not confirm SSH disconnect");
  await expect(page.locator(".globalSessionNotice").getByRole("button",{name:"Reconnect"})).toHaveCount(0);
  await expect(page.locator(".sessionStripItem")).toHaveCount(3);
  await expect(page.locator(".terminalDockSlot .terminalSessionSurface"))
    .toHaveAttribute("data-ssh-session","session-b");
  await page.getByRole("button",{name:"Dismiss session notice"}).click();

  await page.locator(".workspaceNav button").filter({hasText:"Docker"}).click();
  await expect(page.locator(".dockerTableScroll tbody tr")).toHaveCount(1);
  await page.locator(".dockerTableScroll tbody tr").first().click();
  await page.getByRole("button",{name:"View logs"}).click();
  await expect(page.locator(".dockerLogsBody")).toContainText("ERROR warning");
  await page.getByRole("textbox",{name:"Search Docker logs"}).fill("ERROR");
  await page.getByRole("button",{name:"Save visible logs"}).click();
  await expect(page.locator(".dockerLogViewer .workspaceNotice")).toContainText("Saved filtered logs in native dialog");
  const saved=await page.evaluate(()=>
    (window as unknown as {__mockSshBridge:{exports:Array<{containerName:string;contents:string}>}}).__mockSshBridge.exports
  );
  expect(saved).toEqual([{containerName:"api-test",contents:"2026-10-17 ERROR warning"}]);

  // Directory enumeration can finish after switching SSH accounts. Block
  // Linux SFTP, load the Windows folder, and release Linux responses late.
  // The late directory results must not replace the selected Windows files.
  await page.locator(".workspaceNav button").filter({hasText:"Remote Files"}).click();
  await expect.poll(()=>page.evaluate(()=>
    (window as unknown as {__mockSshBridge:{pendingSftp:()=>number}})
      .__mockSshBridge.pendingSftp()
  )).toBeGreaterThan(0);
  await page.locator(".sidebar .host").filter({hasText:"win-test"}).click();
  await expect(page.locator(".filesTableWrap")).toContainText("from-windows.txt");
  await page.evaluate(()=>{
    (window as unknown as {__mockSshBridge:{releaseSftp:()=>void}})
      .__mockSshBridge.releaseSftp();
  });
  await expect(page.locator(".filesTableWrap")).not.toContainText("from-linux.txt");
  await expect(page.locator(".filesTableWrap")).toContainText("from-windows.txt");

  // Successful directory navigation is retained per PTY, not shared between
  // Linux and Windows SSH hosts. The next switch restores the Linux path.
  await page.locator(".sidebar .host").filter({hasText:"linux-test"}).click();
  const remotePath=page.getByRole("textbox",{name:"Remote path"});
  await remotePath.fill("/srv/code");
  await remotePath.press("Enter");
  await expect.poll(()=>page.evaluate(()=>
    (window as unknown as {__mockSshBridge:{pendingSftp:()=>number}})
      .__mockSshBridge.pendingSftp()
  )).toBeGreaterThan(0);
  await page.evaluate(()=>{
    (window as unknown as {__mockSshBridge:{releaseSftp:()=>void}})
      .__mockSshBridge.releaseSftp();
  });
  await expect(page.locator(".filesTableWrap")).toContainText("from-linux.txt");
  await page.locator(".sidebar .host").filter({hasText:"win-test"}).click();
  await expect(remotePath).toHaveValue(".");
  await page.locator(".sidebar .host").filter({hasText:"linux-test"}).click();
  await expect(remotePath).toHaveValue("/srv/code");
  // SSH tunnel start on Linux can be delayed while Windows starts a separate
  // tunnel. The stale A operation must not disable B, steal B's forwards or
  // show an A-only error on B. Display both Linux PTY tunnels on the same host.
  await page.locator(".workspaceNav button").filter({hasText:"Port Forwarding"}).click();
  await page.getByRole("spinbutton",{name:"Local TCP port"}).fill("19001");
  await page.getByRole("button",{name:"Start forwarding"}).click();
  await expect.poll(()=>page.evaluate(()=>
    (window as unknown as {__mockSshBridge:{pendingForwards:()=>number}})
      .__mockSshBridge.pendingForwards()
  )).toBe(1);
  await page.locator(".sidebar .host").filter({hasText:"win-test"}).click();
  await expect(page.getByRole("button",{name:"Start forwarding"})).toBeEnabled();
  await page.getByRole("spinbutton",{name:"Local TCP port"}).fill("19002");
  await page.getByRole("button",{name:"Start forwarding"}).click();
  await expect(page.locator(".forwardTableWrap")).toContainText("127.0.0.1:19002");
  await page.evaluate(()=>{
    (window as unknown as {__mockSshBridge:{releaseForwards:()=>void}})
      .__mockSshBridge.releaseForwards();
  });
  await page.locator(".sidebar .host").filter({hasText:"linux-test"}).click();
  await expect(page.locator(".forwardTableWrap")).toContainText("127.0.0.1:19001");
  await expect(page.locator(".forwardTableWrap")).not.toContainText("19002");
  await page.locator(".workspaceNav button").filter({hasText:"Terminal"}).click();
  await page.locator(".sessionStripItem").filter({hasText:"linux-test"}).first().click();
  await page.locator(".workspaceNav button").filter({hasText:"Port Forwarding"}).click();
  await page.getByRole("spinbutton",{name:"Local TCP port"}).fill("19003");
  await page.getByRole("button",{name:"Start forwarding"}).click();
  await expect(page.locator(".forwardTableWrap")).toContainText("127.0.0.1:19003");
  await expect(page.locator(".forwardTableWrap")).toContainText("127.0.0.1:19001");
  await page.locator(".workspaceNav button").filter({hasText:"Docker"}).click();

  // Switch host while Docker has logs from the prior host: no cross-host
  // log output, then simulate an unsolicited SSH close from the native event
  // bridge. The recovery action must be visible outside hidden Terminal.
  await page.locator(".sidebar .host").filter({hasText:"win-test"}).click();
  await expect(page.locator(".topHostIdentity strong")).toHaveText("win-test");
  await page.getByRole("tab",{name:"Logs"}).click();
  await expect(page.locator(".dockerLogsBody")).not.toContainText("ERROR warning");
  await page.locator(".workspaceNav button").filter({hasText:"AI Agents"}).click();
  await expect(page.locator(".agentTerminalFrame .terminalSessionSurface")).toHaveAttribute("data-ssh-session","session-c");
  await page.evaluate(()=>{
    const bridge=(window as unknown as {__mockSshBridge:{emit:(event:string,payload:unknown)=>void}}).__mockSshBridge;
    bridge.emit("passh7:ssh-session",{
      id:"session-c",kind:"closed",detail:"Native SSH channel closed unexpectedly"
    });
  });
  await expect(page.locator(".globalSessionNotice")).toContainText("win-test");
  await expect(page.locator(".globalSessionNotice")).toContainText("Native SSH channel closed unexpectedly");
  await expect(page.locator(".agentConnectNotice")).toBeVisible();
  await expect(page.locator(".terminalSessionSurface .xterm")).toHaveCount(2);
  await page.getByRole("button",{name:"Dismiss session notice"}).click();
  await expect(page.locator(".globalSessionNotice")).toHaveCount(0);

  // Diagnose actual native Docker errors instead of presenting an empty host.
  await page.locator(".sidebar .host").filter({hasText:"linux-test"}).click();
  await page.locator(".workspaceNav button").filter({hasText:"Docker"}).click();
  await page.evaluate(()=>{
    (window as unknown as {__mockSshBridge:{failDockerList:(value:string)=>void}})
      .__mockSshBridge.failDockerList("Got permission denied while connecting to Docker daemon");
  });
  await page.getByRole("button",{name:/Refresh/}).first().click();
  await expect(page.locator(".dockerActionableError")).toContainText("Docker inventory unavailable");
  await expect(page.locator(".dockerActionableError")).toContainText("Verify its Docker permissions");
  await page.evaluate(()=>{
    (window as unknown as {__mockSshBridge:{failDockerList:(value:string)=>void}})
      .__mockSshBridge.failDockerList("");
  });
  await page.getByRole("button",{name:"Retry inventory"}).click();
  await expect(page.locator(".dockerTableScroll tbody tr")).toHaveCount(1);
  await expect(page.locator(".dockerActionableError")).toHaveCount(0);

  // One-click, scoped, read-only diagnostics: real React Settings UI with
  // simulated native SSH/SFTP/Docker/CLI IPC and no agent launch or mutation.
  await page.locator(".workspaceNav button").filter({hasText:"Terminal"}).click();
  await page.locator(".sessionStripItem").filter({hasText:"linux-test"}).first().click();
  await page.locator(".workspaceNav button").filter({hasText:"Settings"}).click();
  await page.locator(".settingsNav button").filter({hasText:"About & Diagnostics"}).click();
  await expect(page.getByLabel("Remote host health check")).toBeVisible();
  await page.getByRole("button",{name:"Run host checks"}).click();
  await expect(page.getByLabel("Remote host health check")).toContainText("Docker inventory works");
  await expect(page.getByLabel("Remote host health check")).toContainText("SFTP directory access works");
  await expect(page.getByLabel("Remote host health check")).toContainText("Remote terminal CLI available");
  await expect(page.getByLabel("Remote host health check")).toContainText("Windows desktop application detected");
  await expect(page.getByLabel("Remote host health check")).toContainText("No usable CLI found");
  await expect.poll(()=>page.evaluate(()=>
    (window as unknown as {__mockSshBridge:{agentProbes:Array<{id:string;agent:string}>}})
      .__mockSshBridge.agentProbes.filter(item=>item.id==="session-a").length
  )).toBe(3);
  const probes=await page.evaluate(()=>
    (window as unknown as {__mockSshBridge:{agentProbes:Array<{id:string;agent:string}>}})
      .__mockSshBridge.agentProbes.filter(item=>item.id==="session-a")
  );
  expect(probes.map(item=>item.agent).sort()).toEqual(["claude","codex","opencode"]);
  await page.locator(".sidebar .host").filter({hasText:"win-test"}).click();
  await expect(page.getByLabel("Remote host health check")).toContainText("Not checked yet");
  await expect(page.getByLabel("Remote host health check")).not.toContainText("codex test v1");
  // The real connection editor protects unsaved profile changes. Escape and
  // Close must use the same discard guard rather than silently losing edits.
  await page.locator(".workspaceNav button").filter({hasText:"Connections"}).click();
  await page.locator(".connectionsTableWrap").getByRole("button",{name:"Edit linux-test"}).click();
  const editor=page.getByRole("dialog",{name:"Edit SSH connection"});
  await expect(editor).toBeVisible();
  await editor.getByRole("textbox",{name:"Display name"}).fill("Changed but not saved");
  await expect(editor.getByText("Unsaved changes")).toBeVisible();
  await page.evaluate(()=>{window.confirm=()=>false;});
  await editor.getByRole("button",{name:"Close",exact:true}).click();
  await expect(editor).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(editor).toBeVisible();
  await page.evaluate(()=>{window.confirm=()=>true;});
  await page.keyboard.press("Escape");
  await expect(editor).not.toBeVisible();
  await page.locator(".connectionsTableWrap").getByRole("button",{name:"Edit linux-test"}).click();
  await expect(page.getByRole("dialog",{name:"Edit SSH connection"})
    .getByRole("textbox",{name:"Display name"})).toHaveValue("linux-test");
  await page.getByRole("dialog",{name:"Edit SSH connection"})
    .getByRole("button",{name:"Close",exact:true}).click();
  await expect(editor).not.toBeVisible();
  // Recovery is an explicit user action; wrong-host SSH never inherits it.
  await page.evaluate(()=>{
    (window as unknown as {__mockSshBridge:{addGrant:()=>void}}).__mockSshBridge.addGrant();
  });
  await page.locator(".sidebar .host").filter({hasText:"linux-test"}).click();
  await page.locator(".workspaceNav button").filter({hasText:"AI Agents"}).click();
  const grants=page.getByRole("region",{name:"Local CLI SSH grants"});
  await expect(grants).toContainText("GRANT EXPIRED");
  await expect(grants.getByRole("button",{name:"Restore SSH access"})).toBeVisible();
  await page.evaluate(()=>{window.confirm=()=>false;});
  await grants.getByRole("button",{name:"Restore SSH access"}).click();
  await expect(grants).toContainText("GRANT EXPIRED");
  await page.evaluate(()=>{window.confirm=()=>true;});
  await grants.getByRole("button",{name:"Restore SSH access"}).click();
  await expect(grants).toContainText("SSH TOOLS ACTIVE");
  await expect.poll(()=>page.evaluate(()=>
    (window as unknown as {__mockSshBridge:{restoredGrants:Array<{id:string;sessionId:string}>}})
      .__mockSshBridge.restoredGrants.length
  )).toBe(1);
  await page.locator(".sidebar .host").filter({hasText:"win-test"}).click();
  await expect(grants.getByRole("button",{name:"Extend access"})).toHaveCount(0);
  await expect(grants.getByRole("button",{name:/Select linux-test SSH/})).toBeVisible();
  await page.locator(".sidebar .host").filter({hasText:"linux-test"}).click();
  await grants.getByRole("button",{name:"Revoke SSH access"}).click();
  await expect(grants).toContainText("No recoverable local CLI grant");
  await expect(grants.getByRole("button",{name:"Restore SSH access"})).toHaveCount(0);
  // "Never" is a deliberate native setting, not a reset to 15 minutes.
  await page.locator(".workspaceNav button").filter({hasText:"Settings"}).click();
  await page.locator(".settingsNav button").filter({hasText:"Vault & Security"}).click();
  await page.getByRole("combobox",{name:"Vault auto-lock duration"}).selectOption("0");
  await expect(page.getByText("Automatic idle lock is OFF.")).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>
    (window as unknown as {__mockSshBridge:{idlePolicyChanges:number[]}})
      .__mockSshBridge.idlePolicyChanges.at(-1)
  )).toBe(0);
  // Locking deliberately closes SSH but should preserve a safe, non-secret
  // recovery choice after re-unlocking, not silently replay PTY commands.
  await page.getByRole("button",{name:"Lock Vault now"}).first().click();
  await expect(page.locator(".vaultResumeNotice")).toContainText("Vault locked");
  await expect(page.locator(".vaultResumeNotice").getByRole("button",{name:"Unlock & resume"})).toBeVisible();
  await page.locator(".vaultResumeNotice").getByRole("button",{name:"Unlock & resume"}).click();
  const unlock=page.getByRole("dialog",{name:"Unlock encrypted vault"});
  await unlock.getByLabel("Master password").fill("test-password-is-not-secret");
  await unlock.getByRole("button",{name:"Unlock",exact:true}).click();
  await expect(page.locator(".vaultResumeNotice")).toContainText("Resume your SSH workspace");
  await expect(page.locator(".vaultResumeNotice")).toContainText("Reconnect");
  await page.getByRole("button",{name:"Dismiss Vault recovery"}).click();
  await expect(page.locator(".vaultResumeNotice")).toHaveCount(0);
  expect(browserErrors).toEqual([]);
}
