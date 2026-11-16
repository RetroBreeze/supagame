/* global console, process, setTimeout, fetch, URL, window, document, innerWidth, innerHeight */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const server = spawn(process.execPath, [fileURLToPath(new URL('./bin/vite.js', import.meta.resolve('vite/package.json'))), '--host', '127.0.0.1', '--port', '5198', '--strictPort'], {stdio:'pipe', env: {...process.env, VITE_SUPABASE_URL:'http://127.0.0.1:54321', VITE_SUPABASE_PUBLISHABLE_KEY:'sb_publishable_browser_test'}});
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
    const requests=[];
    const playerId='00000000-0000-4000-8000-000000000001';
    const user={id:playerId,aud:'authenticated',role:'authenticated',app_metadata:{},user_metadata:{},created_at:'2026-11-09T12:00:00Z',is_anonymous:true};
    let displayName='Player', bestScore=0, failProfile=false, failScores=false, failReads=false;
    await page.route('http://127.0.0.1:54321/**',async route=>{
      const request=route.request(),url=new URL(request.url());
      requests.push({path:url.pathname,method:request.method(),body:request.postDataJSON(),headers:request.headers()});
      if((failProfile && url.pathname.endsWith('/players/me')) || (failScores && url.pathname.endsWith('/scores')) || (failReads && url.pathname.endsWith('/entries'))) {
        await route.fulfill({status:403,json:{code:'FORBIDDEN',message:'Synthetic rejection'}});
        return;
      }
      let body;
      if(url.pathname==='/auth/v1/signup') body={user,access_token:'test-user-token',refresh_token:'test-refresh-token',expires_in:3600,token_type:'bearer'};
      else if(url.pathname==='/auth/v1/user') body=user;
      else if(url.pathname.endsWith('/entries')) {
        assert.equal(url.searchParams.get('limit'),'10');
        body={entries:Array.from({length:10},(_,i)=>({playerId,displayName:i===0?'<b>Champion</b>':`Player ${i+1}`,score:1000-i*10,rank:i<2?1:i+1,achievedAt:'2026-11-09T12:00:00Z'})),nextCursor:null};
      } else if(url.pathname.endsWith('/players/me')) {
        displayName=request.postDataJSON().displayName;
        body={playerId,displayName,createdAt:'2026-11-09T12:00:00Z'};
      } else if(url.pathname.endsWith('/scores')) {
        const score=request.postDataJSON().score;
        const outcome=score>bestScore?'best':'not_best';
        bestScore=Math.max(bestScore,score);
        body={outcome,score,bestScore};
      } else throw new Error(`Unexpected request: ${request.url()}`);
      await route.fulfill({json:body});
    });
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
    await page.waitForFunction(()=>document.querySelectorAll('#leaderboard-entries tr').length===10,{},{timeout:5000});
    assert.equal(await page.locator('#leaderboard-entries tr').first().textContent(),'1<b>Champion</b>1000');
    assert.equal(await page.locator('#leaderboard-entries b').count(),0,'names must be rendered as text');
    assert.equal(requests.some(r=>r.path.startsWith('/auth/')),false,'public leaderboard needs no sign-in');
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
    await page.getByLabel('Player name').fill('ab');
    await page.getByRole('button',{name:'Start',exact:true}).click();
    assert.equal(await page.locator('#intro').isVisible(),true,'invalid names must not start a round');
    assert.equal(requests.some(r=>r.method==='POST'),false);
    await page.getByLabel('Player name').fill('  Ada  ');
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
    await page.waitForFunction(()=>document.querySelector('#submission-status')?.textContent.includes('Best: 10'));
    const writes=requests.filter(r=>r.path.endsWith('/players/me')||r.path.endsWith('/scores'));
    assert.deepEqual(writes.map(r=>r.method),['PATCH','POST']);
    assert.deepEqual(writes[0].body,{displayName:'Ada'});
    assert.equal(writes[1].path,'/functions/v1/supagame/v1/leaderboards/target-rush/scores');
    assert.equal(writes[1].body.score,10);
    assert.match(writes[1].body.submissionKey,/^[0-9a-f-]{36}$/);
    assert.equal(writes[1].headers.authorization,'Bearer test-user-token');
    await assertFits();
    await page.screenshot({path:`/tmp/target-rush-${label}-results.png`});
    await page.getByRole('button',{name:'Play again',exact:true}).click();
    assert.equal(await page.locator('#intro').isVisible(),true);
    await page.getByRole('button',{name:'Start',exact:true}).click();
    await page.clock.runFor(20);
    assert.equal(await page.locator('#results').isVisible(),false);
    assert.equal(await page.locator('#score').textContent(),'0');
    await page.clock.fastForward(30000);
    assert.equal(await page.evaluate(()=>window.roundResults.length),2);
    assert.equal(await page.locator('#final-score').textContent(),'0');
    await page.waitForFunction(()=>document.querySelector('#submission-status')?.textContent.includes('Best: 10'));
    assert.equal(requests.filter(r=>r.path==='/auth/v1/signup').length,1,'replay reuses the existing session');
    assert.deepEqual(requests.filter(r=>r.path.endsWith('/scores')).map(r=>r.body.score),[10,0]);
    assert.deepEqual(errors,[]);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    if(!mobile) {
      const submitted=requests.filter(r=>r.path.endsWith('/scores')).length;
      failProfile=true;
      await page.getByRole('button',{name:'Play again',exact:true}).click();
      await page.getByRole('button',{name:'Start',exact:true}).click();
      await page.clock.fastForward(30000);
      await page.locator('#submission-status').filter({hasText:'Could not save score'}).waitFor();
      assert.equal(requests.filter(r=>r.path.endsWith('/scores')).length,submitted,'failed name save prevents score submission');
      failProfile=false; failScores=true;
      await page.getByRole('button',{name:'Play again',exact:true}).click();
      await page.getByRole('button',{name:'Start',exact:true}).click();
      await page.clock.fastForward(30000);
      await page.locator('#submission-status').filter({hasText:'Could not save score'}).waitFor();
      assert.equal(await page.locator('#results').isVisible(),true,'failed score save leaves results usable');
      assert.equal(requests.filter(r=>r.path.endsWith('/scores')).length,submitted+1);
      failReads=true;
      await page.getByRole('button',{name:'Play again',exact:true}).click();
      await page.locator('#leaderboard-status').filter({hasText:'Could not load scores'}).waitFor();
      assert.equal(await page.getByRole('button',{name:'Start',exact:true}).isEnabled(),true);
    }
    console.log(`${label} ${mobile?'touch':'mouse'}: gameplay, top 10, name/score submission, session reuse and layout PASS`);
    await context.close();
  }
} finally {
  await browser?.close();
  server.kill();
}
