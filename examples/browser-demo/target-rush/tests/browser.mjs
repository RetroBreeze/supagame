/* global console, process, setTimeout, fetch, URL, window, document, innerWidth, innerHeight */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const server = spawn(process.execPath, [fileURLToPath(new URL('./bin/vite.js', import.meta.resolve('vite/package.json'))), '--host', '127.0.0.1', '--port', '5198', '--strictPort'], {stdio:'pipe'});
let browser;
try {
  for(let i=0;i<100;i++) {
    try { if((await fetch('http://127.0.0.1:5198')).ok) break; } catch { /* Wait for Vite. */ }
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  browser=await chromium.launch({headless:true});
  for(const viewport of [{width:1280,height:960},{width:390,height:844},{width:320,height:480},{width:568,height:320}]) {
    const mobile=viewport.width<600;
    const label=`${viewport.width}x${viewport.height}`;
    const context=await browser.newContext({viewport,isMobile:mobile,hasTouch:mobile,deviceScaleFactor:mobile?2:1});
    const page=await context.newPage();
    const errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
    await page.clock.install();
    await page.addInitScript(()=>{
      Math.random=()=>.5;
      window.roundResults=[];
      window.addEventListener('targetrush:roundend',event=>window.roundResults.push(event.detail));
    });
    await page.goto('http://127.0.0.1:5198');
    const assertFits=async()=>{
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth && document.documentElement.scrollHeight<=innerHeight),true,`${label}: game must fit without scrolling`);
      const arena=await page.locator('.arena').boundingBox();
      assert.ok(arena.width<=560 && arena.height<=420,`${label}: playfield must remain compact`);
      for(const button of await page.getByRole('button').all()) {
        if(!await button.isVisible())continue;
        const bounds=await button.boundingBox();
        assert.ok(bounds.y>=0 && bounds.y+bounds.height<=viewport.height,`${label}: controls must stay on screen`);
      }
    };
    await assertFits();
    await page.screenshot({path:`/tmp/target-rush-${label}-title.png`});
    await page.getByRole('button',{name:'Start',exact:true}).click();
    await page.clock.runFor(200);
    const box=await page.locator('canvas').boundingBox();
    // Seeded RNG selects cell 10: (90, 350/560 * logical height).
    const x=box.x+box.width*.1,y=box.y+box.height*350/560;
    if(mobile)await page.touchscreen.tap(x,y);else await page.mouse.click(x,y);
    await page.clock.runFor(20);
    assert.equal(await page.locator('#score').textContent(),'10');
    await assertFits();
    await page.screenshot({path:`/tmp/target-rush-${label}-playing.png`});
    await page.getByRole('button',{name:'Mute sound',exact:true}).click();
    assert.equal(await page.locator('#mute').getAttribute('aria-pressed'),'true');
    await page.clock.fastForward(30000);
    assert.equal(await page.locator('#results').isVisible(),true);
    assert.equal(await page.locator('#final-score').textContent(),'10');
    assert.equal(await page.evaluate(()=>window.roundResults.length),1);
    assert.equal(await page.evaluate(()=>window.roundResults[0].score),10);
    await assertFits();
    await page.screenshot({path:`/tmp/target-rush-${label}-results.png`});
    await page.getByRole('button',{name:'Play again',exact:true}).click();
    await page.clock.runFor(20);
    assert.equal(await page.locator('#results').isVisible(),false);
    assert.equal(await page.locator('#score').textContent(),'0');
    await page.clock.fastForward(30000);
    assert.equal(await page.evaluate(()=>window.roundResults.length),2);
    assert.equal(await page.locator('#final-score').textContent(),'0');
    assert.deepEqual(errors,[]);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    console.log(`${label} ${mobile?'touch':'mouse'}: scoring, timer, round event, mute, restart, layout and console PASS`);
    await context.close();
  }
} finally {
  await browser?.close();
  server.kill();
}
