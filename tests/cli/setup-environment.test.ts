import { expect, it } from 'vitest';
import { SetupEnvironment } from '../../packages/cli/src/lib/setup-environment.ts';
import type { ProcessRunner } from '../../packages/cli/src/lib/supabase-cli.ts';
const ref='abcdefghijklmnopqrst';
const response = (body:unknown): ProcessRunner => async () => ({code:0,stdout:JSON.stringify(body),stderr:''});
it('validates discovery records rather than trusting a successful subprocess', async () => {
  expect(await new SetupEnvironment(response({projects:[{id:ref,ref,name:'Arcade'}]})).projects()).toEqual([{ref,name:'Arcade'}]);
  for (const body of [{}, {projects:[{id:'bad',name:'broken'}]}, {projects:[{id:ref,ref:'zzzzzzzzzzzzzzzzzzzz',name:'wrong'}]}]) {
    await expect(new SetupEnvironment(response(body)).projects()).rejects.toThrow(/project/i);
  }
});
it('withholds arbitrary auth and subprocess output, including success-shaped malformed JSON', async () => {
  const run: ProcessRunner=async()=>({code:1,stdout:'sb_secret_NEVER_PRINT',stderr:'token=NEVER_PRINT'});
  await expect(new SetupEnvironment(run).projects()).rejects.toMatchObject({category:'authentication'});
  await expect(new SetupEnvironment(run).projects()).rejects.not.toThrow('NEVER_PRINT');
});
it('checks supported Node and CLI versions without starting a login or remote mutation', async () => {
  await expect(new SetupEnvironment(async()=>({code:0,stdout:'3.1.0',stderr:''})).check('24.22.3')).resolves.toBe('3.1.0');
  await expect(new SetupEnvironment(async()=>({code:0,stdout:'3.2.0',stderr:''})).check('26.13.0')).rejects.toThrow(/unsupported/i);
  await expect(new SetupEnvironment(response({})).check('22.0.0')).rejects.toThrow(/Node/);
});
it('extracts only public keys from the verified selected project', async () => {
  const keys={target:{kind:'linked',project_ref:ref},keys:[{id:'public',type:'publishable',name:'default',api_key:'sb_publishable_synthetic_public_key'},{id:'secret',type:'secret',api_key:'sb_secret_NEVER_PRINT'}]};
  expect(await new SetupEnvironment(response(keys)).keys(ref)).toEqual([{id:'public',name:'default',key:'sb_publishable_synthetic_public_key'}]);
  await expect(new SetupEnvironment(response({...keys,target:{kind:'linked',project_ref:'zzzzzzzzzzzzzzzzzzzz'}})).keys(ref)).rejects.toThrow(/target|project/i);
});
