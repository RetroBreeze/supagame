import { expect, it } from 'vitest';
import { createGameServices } from '../../packages/sdk-ts/src/index.js';
import { fixture } from './fixtures.js';
import { createOfflineSaves, type OfflineEntry, type SaveStore } from '../../packages/sdk-ts/src/offline-saves.js';
import type { Saves } from '../../packages/sdk-ts/src/saves.js';
import { vi } from 'vitest';

const id='10000000-0000-4000-8000-000000000001';
const save={slot:'profile',revision:1,schemaVersion:1,kind:'json',metadata:{},sizeBytes:2,deleted:false,objectPath:null,createdAt:'2026-11-16T00:00:00Z',updatedAt:'2026-11-16T00:00:00Z',generation:'7'};
it('sends the observed generation with a durable operation ID',async()=>{
 const f=fixture(); f.fetcher.mockResolvedValue(Response.json({generation:'7',save}));
 await createGameServices({supabase:f.supabase}).saves.save('profile',{}, {operationId:id,expectedRevision:0,...{generation:'7'}});
 expect(JSON.parse(f.fetcher.mock.calls[0]![1]!.body as string)).toMatchObject({generation:'7',operationId:id});
});
it('preserves an unbound legacy offline intent without sending or rebasing it',async()=>{
 let value:OfflineEntry={cloud:null,pending:[{data:{coins:12},options:{operationId:id,expectedRevision:0}}]};
 const store:SaveStore={async read(){return structuredClone(value);},async update(_key,change){value=change(value);return structuredClone(value);}};
 const send=vi.fn().mockResolvedValue({...save,data:{coins:12}});
 const saves={save:send,context:vi.fn().mockResolvedValue({generation:'8'})} as unknown as Saves;
 const offline=createOfflineSaves({saves,store,playerId:async()=>'player',namespace:'local'});
 await expect(offline.sync('profile')).rejects.toMatchObject({code:'SAVE_CONFLICT'});
 expect(send).not.toHaveBeenCalled();
 expect(value.pending[0]?.data).toEqual({coins:12});
 expect(saves.context).not.toHaveBeenCalled();
});
it('does not attach fresh context to an unbound durable retry',async()=>{
 const f=fixture(); f.fetcher.mockResolvedValue(Response.json({save}));
 await expect(createGameServices({supabase:f.supabase}).saves.save('profile',{coins:9},{operationId:id,expectedRevision:0})).rejects.toMatchObject({code:'SAVE_CONFLICT'});
 expect(f.fetcher).not.toHaveBeenCalled();
});
it('keeps the current conflict generation separate from the original retry context',async()=>{
 const f=fixture();f.fetcher.mockResolvedValue(Response.json({code:'SAVE_CONFLICT',message:'Reconcile',current:null,generation:'8'},{status:409}));
 await expect(createGameServices({supabase:f.supabase}).saves.save('profile',{coins:9},{operationId:id,...{generation:'7'}})).rejects.toMatchObject({code:'SAVE_CONFLICT',generation:'8',operationGeneration:'7',operationId:id});
});
it.each(['binary','delete'] as const)('explicitly reconciles a stale offline %s without losing its old queue',async kind=>{
 const original=new Blob(['local bytes']);
 let value:OfflineEntry={cloud:null,pending:[{kind,data:kind==='binary'?original:null,options:{generation:'7',operationId:id,expectedRevision:0}}],conflict:null,conflictGeneration:'8'};
 const store:SaveStore={async read(){return structuredClone(value);},async update(_key,change){value=change(value);return structuredClone(value);}};
 const send=vi.fn().mockResolvedValue({...save,generation:'8',kind:kind==='binary'?'binary':'json',deleted:kind==='delete'});
 const saves={saveBinary:send,delete:send,context:vi.fn().mockResolvedValue({generation:'8'})} as unknown as Saves;
 const offline=createOfflineSaves({saves,store,playerId:async()=>'player',namespace:'local'});
 if(kind==='binary')await offline.resolveBinary('profile',original,0);
 else await offline.resolveDelete('profile',0);
 expect(value.pending[0]?.kind).toBe(kind);
 expect(value.pending[0]?.options).toMatchObject({generation:'8',expectedRevision:0});
 expect(value.pending[0]?.options.operationId).not.toBe(id);
 expect(value.history?.[0]?.[0]?.options).toMatchObject({generation:'7',operationId:id});
 if(kind==='binary')expect(await(value.history![0]![0]!.data as Blob).text()).toBe('local bytes');
 await offline.sync('profile');expect(send).toHaveBeenCalledTimes(1);expect(value.pending).toEqual([]);
});
it('invalidates cached binary bytes when a recreated slot reuses a revision in a new generation',async()=>{
 let value:OfflineEntry={cloud:{...save,kind:'binary',objectPath:'player/old'},binary:new Blob(['old bytes']),pending:[]};
 const store:SaveStore={async read(){return structuredClone(value);},async update(_key,change){value=change(value);return structuredClone(value);}};
 const saves={load:vi.fn().mockResolvedValue({...save,generation:'8',kind:'binary',objectPath:'player/new'})} as unknown as Saves;
 const offline=createOfflineSaves({saves,store,playerId:async()=>'player',namespace:'local'});
 await offline.load('profile');
 expect(value.cloud?.generation).toBe('8');expect(value.binary).toBeUndefined();
});
