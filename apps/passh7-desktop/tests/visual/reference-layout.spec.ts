import {test,expect} from "@playwright/test";
import {runNativeAppSession} from "./native-app-session.helper";

const screens=[
  {name:"connections",heading:"Connections"},
  {name:"terminal",heading:"dev-server"},
  {name:"files",heading:"Remote Files"},
  {name:"docker",heading:"Docker"},
  {name:"ports",heading:"Port Forwarding"},
  {name:"snippets",heading:"Snippets"},
  {name:"agent",heading:"AI Agents"},
  {name:"settings",heading:"Settings"}
] as const;
const viewports=[
  {name:"desktop-1440",width:1440,height:900},
  {name:"wide-1920",width:1920,height:1080},
  {name:"narrow-900",width:900,height:720}
] as const;

// The npm-packaged Chromium is designed for serverless execution and can
// occasionally fail when Playwright starts a new process for every test.
// One browser/page traverses all fixtures, minimizing runner resource usage.
test("reference layouts: all eight workspaces across three viewports and keyboard interactions",async({page},info)=>{
  test.setTimeout(220000);
  const failures:string[]=[];
  page.on("pageerror",error=>failures.push(error.message));

  for(const screen of screens){
    for(const viewport of viewports){
      await test.step(screen.name+" "+viewport.name,async()=>{
        await page.setViewportSize({width:viewport.width,height:viewport.height});
        await page.goto("/?__reference=1&screen="+screen.name,{waitUntil:"domcontentloaded"});
        await expect(page.locator(".referenceFixtureLabel")).toContainText("NOT A REAL SSH CONNECTION");
        await expect(page.locator(screen.name==="terminal"?".referenceTerminalMain .identity h1":".widePageTitle h1")).toHaveText(screen.heading);
        await expect(page.locator(".topHostIdentity strong")).toHaveText("dev-server");
        if(screen.name==="docker"){
          await expect(page.locator(".dockerMetrics>div")).toHaveCount(6);
          await expect(page.locator(".dockerTableScroll .workspaceTable tbody tr")).toHaveCount(5);
          await expect(page.locator(".dockerInspector")).toBeVisible();
          await expect(page.locator(".dockerLogViewer")).toBeVisible();
        }else if(screen.name==="files"){
          await expect(page.locator(".filesTablePane .workspaceTable tbody tr")).toHaveCount(8);
          await page.locator(".filesTablePane .workspaceTable tbody tr").filter({hasText:"README.md"}).click();
          await expect(page.locator(".fileCodePreview pre")).toContainText("Development-only fixture");
          await expect(page.locator(".transferQueuePanel")).toBeVisible();
        }else if(screen.name==="settings"){
          await expect(page.locator(".settingsNav button")).toHaveCount(12);
          await expect(page.locator(".settingsHelp")).toBeVisible();
        }else if(screen.name==="connections"){
          await expect(page.locator(".connectionsTableWrap tbody tr")).toHaveCount(3);
          await expect(page.locator(".connectionsInspector")).toBeVisible();
        }else if(screen.name==="ports"){
          await expect(page.locator(".forwardTableWrap tbody tr")).toHaveCount(2);
          await expect(page.locator(".forwardRoutePreview")).toBeVisible();
        }else if(screen.name==="snippets"){
          await expect(page.locator(".snippetCard")).toHaveCount(9);
          await expect(page.locator(".snippetsRunner")).toBeVisible();
        }else if(screen.name==="agent"){
          await expect(page.locator(".agentCard")).toHaveCount(3);
          await expect(page.locator(".agentWorkspaceSide")).toBeVisible();
          await expect(page.locator(".agentEmbeddedTerminal")).toBeVisible();
          await expect(page.locator(".agentDevTerminalPreview")).toContainText("Not a live SSH connection");
        }else{
          await expect(page.locator(".referenceTerminalText")).toContainText("docker ps");
        }
        const overflow=await page.evaluate(()=>document.documentElement.scrollWidth-window.innerWidth);
        expect(overflow,"viewport-level horizontal overflow").toBeLessThanOrEqual(2);
        const filename=screen.name+"-"+viewport.name+".png";
        const image=info.outputPath(filename);
        await page.screenshot({path:image,fullPage:true,animations:"disabled"});
        await info.attach(filename,{path:image,contentType:"image/png"});
      });
    }
  }

  await test.step("files keyboard resize/reset",async()=>{
    await page.setViewportSize({width:1440,height:900});
    await page.goto("/?__reference=1&screen=files");
    const separator=page.getByRole("separator",{name:"Remote folder tree width"});
    await separator.focus();
    const start=Number(await separator.getAttribute("aria-valuenow"));
    await page.keyboard.press("ArrowRight");
    await expect(separator).toHaveAttribute("aria-valuenow",String(start+8));
    await page.keyboard.press("Enter");
    await expect(separator).toHaveAttribute("aria-valuenow",String(start));
  });

  await test.step("settings accordion",async()=>{
    await page.goto("/?__reference=1&screen=settings");
    await page.locator(".settingsNav button").filter({hasText:"Terminal"}).click();
    const button=page.getByRole("button",{name:"Terminal font and spacing"});
    await expect(button).toHaveAttribute("aria-expanded","true");
    await button.click();
    await expect(button).toHaveAttribute("aria-expanded","false");
    await button.click();
    await expect(button).toHaveAttribute("aria-expanded","true");
  });

  await test.step("Docker container search",async()=>{
    await page.goto("/?__reference=1&screen=docker");
    await page.getByRole("textbox",{name:"Search containers"}).fill("postgres");
    await expect(page.locator(".dockerTableScroll .workspaceTable tbody tr")).toHaveCount(1);
    await expect(page.locator(".dockerTableScroll .workspaceTable tbody tr")).toContainText("postgres");
  });

  await test.step("real app sidebar preference survives reload",async()=>{
    await page.goto("/",{waitUntil:"domcontentloaded"});
    await page.getByRole("button",{name:"Settings",exact:true}).click();
    await expect(page.locator(".sidebar")).toBeVisible();
    // A prior fixture deliberately selected Terminal, and Settings preserves
    // that category across reloads. Explicitly select General here.
    await page.locator(".settingsNav button").filter({hasText:"General"}).click();
    const sidebarToggle=page.getByRole("checkbox",{name:/Show host sidebar/});
    await expect(sidebarToggle).toBeVisible();
    await sidebarToggle.uncheck();
    await expect(page.locator(".sidebar")).toHaveCount(0);
    await page.reload({waitUntil:"domcontentloaded"});
    await expect(page.locator(".sidebar")).toHaveCount(0);
    await page.getByRole("button",{name:"Expand host sidebar"}).click();
    await expect(page.locator(".sidebar")).toBeVisible();
  });

  await test.step("filter saved Connections and Snippets",async()=>{
    await page.goto("/?__reference=1&screen=connections");
    await page.getByRole("button",{name:/Trusted/}).filter({hasText:"Trusted"}).click();
    await expect(page.locator(".connectionsTableWrap tbody tr")).toHaveCount(2);
    await page.goto("/?__reference=1&screen=snippets");
    await page.getByRole("button",{name:/Docker 3/}).click();
    await expect(page.locator(".snippetCard")).toHaveCount(3);
  });

  await test.step("real offline App command palette: keyboard search and workspace switch",async()=>{
    await page.goto("/",{waitUntil:"domcontentloaded"});
    // Vite serves the HTML before React is mounted; wait for the real shell
    // and its installed shortcut listeners instead of racing initial hydration.
    await expect(page.getByRole("button",{name:"Quick switch"})).toBeVisible();
    await page.keyboard.press("Control+k");
    const palette=page.getByRole("dialog",{name:"Quick switch"});
    await expect(palette).toBeVisible();
    const search=page.getByRole("textbox",{name:"Search hosts and workspaces"});
    await expect(search).toBeFocused();
    await search.fill("docker");
    await expect(palette.getByRole("option")).toHaveCount(1);
    await search.press("Enter");
    await expect(palette).toHaveCount(0);
    await expect(page.locator(".workspaceNav button.active")).toHaveText("Docker");
    await page.getByRole("button",{name:"Quick switch"}).click();
    await expect(palette).toBeVisible();
    // The modal is keyboard-contained: reverse Tab wraps from close to the
    // final option, and Escape uses the native Close handler.
    const close=palette.getByRole("button",{name:"Close"});
    await close.focus();
    await page.keyboard.press("Shift+Tab");
    await expect(palette.getByRole("option").last()).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(palette).toHaveCount(0);
    await expect(page.getByRole("button",{name:"Quick switch"})).toBeFocused();
  });

  await test.step("Appearance light theme reaches terminal and workspace chrome",async()=>{
    await page.goto("/?__reference=1&screen=settings",{waitUntil:"domcontentloaded"});
    await expect(page.locator(".settingsNav")).toBeVisible();
    await page.locator(".settingsNav button").filter({hasText:"Theme and layout"}).click();
    await page.locator(".prefRow").filter({hasText:"Switch between deep navy"}).locator("select").selectOption("light");
    await expect(page.locator(".shell")).toHaveClass(/light/);
    await page.locator(".workspaceNav button").filter({hasText:"Terminal"}).click();
    await expect(page.locator(".referenceTerminalText")).toHaveCSS("background-color","rgb(247, 251, 255)");
    await expect(page.locator(".referenceTerminalText")).toHaveCSS("color","rgb(40, 68, 99)");
  });

  await test.step("Windows SSH agent detection: desktop-only versus CLI",async()=>{
    await page.goto("/?__reference=1&screen=agent",{waitUntil:"domcontentloaded"});
    await expect(page.locator(".agentInstallHelp")).toContainText("Desktop");
    await expect(page.locator(".agentInstallHelp")).toContainText("RDP");
    await expect(page.getByRole("button",{name:/Launch CLI here/})).toBeDisabled();
    await page.getByRole("button",{name:/Prepare RDP tunnel/}).click();
    await expect(page.locator(".widePageTitle h1")).toHaveText("Port Forwarding");
    await page.goto("/?__reference=1&screen=agent",{waitUntil:"domcontentloaded"});
    await page.locator(".agentCard.claude").click();
    await expect(page.locator(".agentDiscovery")).toContainText("User installation outside SSH PATH");
    await expect(page.locator(".agentDevTerminalPreview")).toContainText("Claude Code CLI");
    await page.getByRole("button",{name:"Expand console"}).click();
    await expect(page.locator(".agentTerminalFrame")).toHaveClass(/expanded/);
    await page.getByRole("button",{name:"Compact console"}).click();
    await expect(page.locator(".agentTerminalFrame")).not.toHaveClass(/expanded/);
    await expect(page.locator(".agentDiscovery")).toContainText("claude.cmd");
    await expect(page.getByRole("button",{name:/Launch CLI here/})).toBeEnabled();
    await page.locator(".agentCard.opencode").click();
    await expect(page.locator(".agentInstallHelp")).toContainText("CLI not found");
    await expect(page.locator(".agentInstallHelp code")).toContainText("opencode-ai");
  });

  await test.step("production App via simulated Tauri IPC: persistent SSH tabs and Docker Save As",async()=>{
    await runNativeAppSession(page);
  });

  expect(failures,"uncaught React/browser errors").toEqual([]);
});
