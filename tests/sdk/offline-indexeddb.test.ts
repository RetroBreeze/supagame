import { build } from 'esbuild';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
it('serializes two browser tabs and rejects a stale conflict after another tab acknowledges the save', async () => {
  const bundle = await build({ stdin: { contents: `export { createOfflineSaves, SaveConflictError } from './packages/sdk-ts/src/index.ts'; export { createIndexedDbStore } from './packages/sdk-ts/src/browser.ts';`, resolveDir: process.cwd() },
    bundle: true, platform: 'browser', format: 'iife', globalName: 'SDK', write: false });
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext();
    await context.route('http://127.0.0.1:41999/**', r => r.fulfill({ contentType: 'text/html', body: '<title>Offline concurrency</title>' }));
    const first = await context.newPage(), second = await context.newPage();
    for (const page of [first, second]) {
      await page.goto('http://127.0.0.1:41999/');
      await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
      await page.evaluate(`globalThis.record = { slot:'profile',revision:4,schemaVersion:1,kind:'json',metadata:{},sizeBytes:2,deleted:false,objectPath:null,createdAt:'2026-11-12T00:00:00Z',updatedAt:'2026-11-12T00:00:00Z',data:{coins:10} };
        globalThis.store = SDK.createIndexedDbStore('shared-concurrency');
        globalThis.saves = { save: async()=>record };
        globalThis.offline = SDK.createOfflineSaves({saves,store,namespace:'project',playerId:async()=>'one'});`);
    }
    await first.evaluate(`(async()=>{
      await offline.stage('profile',{coins:1});
      saves.save = async()=>{globalThis.started=true;return new Promise((_,reject)=>globalThis.rejectOld=reject);};
      globalThis.pending=offline.sync('profile').catch(e=>e.code);
    })()`);
    await first.waitForFunction('globalThis.started');
    await second.evaluate(`(async()=>{await offline.resolve('profile',{coins:10},3);await offline.sync('profile');})()`);
    await first.evaluate(`rejectOld(new SDK.SaveConflictError({...record,revision:3}));pending`);
    expect(await second.evaluate(`offline.local('profile').then(s=>({revision:s.cloud.revision,pending:s.pending.length,conflict:Object.hasOwn(s,'conflict')}))`))
      .toEqual({ revision: 4, pending: 0, conflict: false });
  } finally { await browser.close(); }
});
