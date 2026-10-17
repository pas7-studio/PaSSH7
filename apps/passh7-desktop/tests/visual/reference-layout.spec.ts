import {test,expect} from "@playwright/test";

const screens=[
  {name:"settings",heading:"Settings"},
  {name:"files",heading:"Remote Files"},
  {name:"docker",heading:"Docker"}
] as const;
const viewports=[
  {name:"desktop-1440",width:1440,height:900},
  {name:"wide-1920",width:1920,height:1080},
  {name:"narrow-900",width:900,height:720}
] as const;

for(const screen of screens){
  for(const viewport of viewports){
    test(screen.name+" "+viewport.name+" fixture screenshot",async({page},info)=>{
      await page.setViewportSize({width:viewport.width,height:viewport.height});
      const failures:string[]=[];
      page.on("pageerror",error=>failures.push(error.message));
      await page.goto("/?__reference=1&screen="+screen.name,{waitUntil:"networkidle"});
      await expect(page.locator(".referenceFixtureLabel")).toContainText("NOT A REAL SSH CONNECTION");
      await expect(page.locator(".widePageTitle h1")).toHaveText(screen.heading);
      await expect(page.locator(".topHostIdentity strong")).toHaveText("dev-server");
      if(screen.name==="docker"){
        await expect(page.locator(".dockerMetrics>div")).toHaveCount(6);
        await expect(page.locator(".dockerTableScroll .workspaceTable tbody tr")).toHaveCount(5);
        await expect(page.locator(".dockerInspector")).toBeVisible();
        await expect(page.locator(".dockerLogViewer")).toBeVisible();
      }
      if(screen.name==="files"){
        await expect(page.locator(".filesTablePane .workspaceTable tbody tr")).toHaveCount(8);
        await page.locator(".filesTablePane .workspaceTable tbody tr").filter({hasText:"README.md"}).click();
        await expect(page.locator(".fileCodePreview pre")).toContainText("Development-only fixture");
        await expect(page.locator(".transferQueuePanel")).toBeVisible();
      }
      if(screen.name==="settings"){
        await expect(page.locator(".settingsNav button")).toHaveCount(12);
        await expect(page.locator(".settingsHelp")).toBeVisible();
      }
      // The screenshot is from the actual production components, not static HTML.
      // Detect accidental viewport-level overflow while allowing scrollable tables.
      const overflow=await page.evaluate(()=>document.documentElement.scrollWidth-window.innerWidth);
      expect(overflow,"viewport horizontal overflow").toBeLessThanOrEqual(2);
      expect(failures,"React uncaught errors").toEqual([]);
      const filename=screen.name+"-"+viewport.name+".png";
      const image=info.outputPath(filename);
      await page.screenshot({path:image,fullPage:true,animations:"disabled"});
      await info.attach(filename,{path:image,contentType:"image/png"});
    });
  }
}

test("Files keyboard resize can be reset",async({page})=>{
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

test("Settings category accordion changes visible forms",async({page})=>{
  await page.goto("/?__reference=1&screen=settings");
  await page.locator(".settingsNav button").filter({hasText:"Terminal"}).click();
  const button=page.getByRole("button",{name:"Terminal font and spacing"});
  await expect(button).toHaveAttribute("aria-expanded","true");
  await button.click();
  await expect(button).toHaveAttribute("aria-expanded","false");
  await button.click();
  await expect(button).toHaveAttribute("aria-expanded","true");
});

test("Docker search filters actual fixture table",async({page})=>{
  await page.goto("/?__reference=1&screen=docker");
  await page.getByRole("textbox",{name:"Search containers"}).fill("postgres");
  await expect(page.locator(".dockerTableScroll .workspaceTable tbody tr")).toHaveCount(1);
  await expect(page.locator(".dockerTableScroll .workspaceTable tbody tr")).toContainText("postgres");
});
