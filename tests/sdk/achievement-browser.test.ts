import { build } from "esbuild";
import { chromium } from "playwright";
import { expect, it } from "vitest";
it("optional browser helper safely renders, dismisses and removes notifications", async () => {
  const bundle = await build({
    entryPoints: ["packages/sdk-ts/src/browser.ts"],
    bundle: true,
    format: "iife",
    globalName: "SGUI",
    write: false,
    platform: "browser",
  });
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage();
    await page.setContent('<main id="notifications"></main>');
    await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
    await page.evaluate(
      `globalThis.stopped=false;globalThis.view=SGUI.mountAchievementNotifications({onUnlocked(cb){globalThis.emit=cb;return {ready:Promise.resolve(),unsubscribe(){globalThis.stopped=true}}}},{container:document.querySelector('main')});emit({id:'one',title:'<img src=x onerror=alert(1)>',description:'Earned',icon:null,unlocked:true,historical:false});`,
    );
    expect(await page.locator("aside").isVisible()).toBe(true);
    expect(await page.locator("aside strong").textContent()).toContain("<img");
    expect(await page.locator("aside img").count()).toBe(0);
    await page.getByRole("button", { name: "Dismiss" }).click();
    expect(await page.locator("aside").isVisible()).toBe(false);
    await page.evaluate("view.dispose()");
    expect(await page.locator("aside").count()).toBe(0);
    expect(await page.evaluate("globalThis.stopped")).toBe(true);
  } finally {
    await browser.close();
  }
});
