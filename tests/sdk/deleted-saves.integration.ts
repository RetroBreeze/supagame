import { execFileSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
import { expect, it } from 'vitest';
import { query } from '../db/local-sessions.ts';
import { cleanupLocalUsers } from './cleanup-local-users.ts';

const status = JSON.parse(execFileSync('node_modules/.bin/supabase', ['status', '--workdir', 'tests/fixtures/local', '--output', 'json'], {encoding:'utf8',stdio:['ignore','pipe','pipe']}));
if (status.API_URL !== 'http://127.0.0.1:55431') throw new Error('Dedicated local fixture required');

it('retained real JWT cannot reserve or upload after hard deletion', async () => {
  const client = createClient(status.API_URL, status.PUBLISHABLE_KEY, {auth:{persistSession:false,autoRefreshToken:false}});
  const signed = await client.auth.signInAnonymously();
  expect(signed.error).toBeNull();
  const user = signed.data.user!.id, token = signed.data.session!.access_token;
  const headers = {apikey:status.PUBLISHABLE_KEY,Authorization:`Bearer ${token}`,'Content-Type':'application/json'};
  const rpc = async (action:string, request:Record<string,unknown>) => {
    const response = await fetch(`${status.API_URL}/rest/v1/rpc/sg_cloud_save`,{method:'POST',headers,body:JSON.stringify({p_action:action,p_slot:'slot',p_request:request})});
    return {status:response.status,body:await response.json()};
  };
  let path: string | undefined;
  try {
    const context = await rpc('list',{});
    const payload = {operationId:crypto.randomUUID(),expectedRevision:0,schemaVersion:1,metadata:{},sizeBytes:8,checksum:'a'.repeat(64),...(context.body.generation ? {generation:context.body.generation} : {})};
    const prepared = await rpc('prepare',payload);
    expect(prepared.status).toBe(200);
    path = prepared.body.upload.path;
    // No owned Storage object exists: this is a supported hard deletion case.
    const admin = createClient(status.API_URL,status.SECRET_KEY ?? status.SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
    expect((await admin.auth.admin.deleteUser(user)).error).toBeNull();
    const reserved = await rpc('prepare',{...payload,operationId:crypto.randomUUID()});
    const uploaded = await fetch(`${status.API_URL}/storage/v1/object/supagame-saves/${path}`,{method:'POST',headers:{apikey:status.PUBLISHABLE_KEY,Authorization:`Bearer ${token}`,'Content-Type':'application/octet-stream'},body:new Uint8Array(8)});
    // Both results are checked; reservation acceptance does not imply upload success.
    expect({reservation:reserved.status,upload:uploaded.status}).toEqual({reservation:403,upload:400});
    expect(reserved.body.message).toBe('UNAUTHORIZED');
    expect(query(`select count(*) from sg_private.save_objects where path='${path}'`)).toBe('1');
  } finally {
    await cleanupLocalUsers([user]);
    if(path) query(`delete from sg_private.save_objects where user_id='${user}'`);
  }
});

it.each([false,true])('revokes Storage reads/deletes after supported Auth deletion (soft: %s)',async soft=>{
 const client=createClient(status.API_URL,status.PUBLISHABLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
 const signed=await client.auth.signInAnonymously();expect(signed.error).toBeNull();
 const user=signed.data.user!.id,token=signed.data.session!.access_token;
 const admin=createClient(status.API_URL,status.SECRET_KEY??status.SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
 const headers={apikey:status.PUBLISHABLE_KEY,Authorization:`Bearer ${token}`};
 try{
  const context=await client.rpc('sg_cloud_save',{p_action:'list'});expect(context.error).toBeNull();
  const prepared=await client.rpc('sg_cloud_save',{p_action:'prepare',p_slot:'owned',p_request:{generation:context.data.generation,operationId:crypto.randomUUID(),expectedRevision:0,schemaVersion:1,metadata:{},sizeBytes:8,checksum:'a'.repeat(64)}});
  expect(prepared.error).toBeNull();const path=prepared.data.upload.path as string;
  expect((await client.storage.from('supagame-saves').upload(path,new Uint8Array(8))).error).toBeNull();
  // This pinned local Auth/Storage build permits deleting an owner through the
  // Auth API. Exercise that actual behavior, without inventing a reassignment.
  expect(query(`select owner_id from storage.objects where bucket_id='supagame-saves' and name='${path}'`)).toBe(user);
  expect((await client.rpc('sg_cloud_save',{p_action:'save',p_slot:'json',p_request:{generation:context.data.generation,operationId:crypto.randomUUID(),expectedRevision:0,schemaVersion:1,metadata:{},data:{private:true}}})).error).toBeNull();
  expect((await admin.auth.admin.deleteUser(user,soft)).error).toBeNull();
  const direct=await fetch(`${status.API_URL}/rest/v1/game_saves?select=*`,{headers});
  expect(direct.status).toBe(200);expect(await direct.json()).toEqual([]);
  expect(query(`select count(*) from auth.users where id='${user}' and deleted_at is null`)).toBe('0');
  const read=await fetch(`${status.API_URL}/storage/v1/object/authenticated/supagame-saves/${path}`,{headers});
  expect(read.ok).toBe(false);await read.body?.cancel();
  query(`update sg_private.save_objects set state='garbage' where path='${path}'`);
  const removed=await fetch(`${status.API_URL}/storage/v1/object/supagame-saves`,{method:'DELETE',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({prefixes:[path]})});
  if(removed.ok)expect(await removed.json()).toEqual([]);else await removed.body?.cancel();
  expect(query(`select count(*) from storage.objects where bucket_id='supagame-saves' and name='${path}'`)).toBe('1');
  expect(query(`select count(*) from sg_private.save_objects where path='${path}'`)).toBe('1');
 }finally{await cleanupLocalUsers([user]);}
});
