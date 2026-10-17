import {test,expect} from "@playwright/test";

/**
 * A browser-only IPC simulator, NOT a real SSH/Windows acceptance test.
 * Unlike the screenshot fixtures, this mounts the actual production App,
 * its real xterm.js and its real Tauri IPC/frontend event routing.
 */
test("production App retains one xterm per SSH session while docking and exports logs natively",async({page})=>{
  test.setTimeout(100000);
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
    const exports:Array<{containerName:string;contents:string}>=[];
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
        case "vault_exists":case "vault_status":return true;
        case "vault_list_hosts":return hosts;
        case "vault_list_identities":return [];
        case "ssh_session_list":return sessions;
        case "ssh_session_forward_list":return [];
        case "ssh_session_ready":ready.push(String(args.id));return null;
        case "ssh_session_resize":resized.push({id:String(args.id),cols:Number(args.cols),rows:Number(args.rows)});return null;
        case "ssh_session_write":writes.push({id:String(args.id),data:String(args.data)});return null;
        case "ssh_session_docker_list":return JSON.stringify({
          ID:"aaaaaaaaaaaa",Names:"api-test",Image:"api:latest",State:"running",Status:"Up 1 hour",Ports:""
        });
        case "ssh_session_docker_catalog":return "";
        case "ssh_session_docker_inspect":return JSON.stringify({
          image:"api:latest",created:null,startedAt:null,finishedAt:null,restartPolicy:null,mounts:[],networks:[]
        });
        case "ssh_session_docker_logs":return "2026-10-17 INFO hello\\n2026-10-17 ERROR warning\\n";
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
      writes,resized,ready,exports,
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
  await expect(page.locator(".sshTab")).toHaveCount(3);
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
  const chooser=page.getByRole("combobox",{name:"Choose SSH terminal for agent"});
  await chooser.selectOption("session-b");
  await expect(page.locator(".agentTerminalFrame .terminalSessionSurface")).toHaveAttribute("data-ssh-session","session-b");
  await page.getByRole("button",{name:"Focus console"}).click();
  await page.keyboard.type("echo persistent");
  await page.keyboard.press("Enter");
  await expect.poll(()=>page.evaluate(()=>
    (window as unknown as {__mockSshBridge:{writes:Array<{id:string;data:string}>}}).__mockSshBridge.writes.length)
  )).toBeGreaterThan(0);
  const writes=await page.evaluate(()=>
    (window as unknown as {__mockSshBridge:{writes:Array<{id:string;data:string}>}}).__mockSshBridge.writes
  );
  expect(writes.every(item=>item.id==="session-b")).toBe(true);
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

  await page.locator(".workspaceNav button").filter({hasText:"Docker"}).click();
  await expect(page.locator(".dockerTableScroll tbody tr")).toHaveCount(1);
  await page.locator(".dockerTableScroll tbody tr").first().click();
  await page.getByRole("button",{name:"View logs"}).click();
  await expect(page.locator(".dockerLogsBody")).toContainText("ERROR warning");
  await page.getByRole("textbox",{name:"Search Docker logs"}).fill("ERROR");
  await page.getByRole("button",{name:"Save visible logs"}).click();
  await expect(page.getByRole("status")).toContainText("Saved filtered logs in native dialog");
  const saved=await page.evaluate(()=>
    (window as unknown as {__mockSshBridge:{exports:Array<{containerName:string;contents:string}>}}).__mockSshBridge.exports
  );
  expect(saved).toEqual([{containerName:"api-test",contents:"2026-10-17 ERROR warning"}]);
  expect(browserErrors).toEqual([]);
});
