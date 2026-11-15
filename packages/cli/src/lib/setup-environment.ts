import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { object, projectRef } from './manifest.ts';
import { assertSupabaseVersion, createSupabaseRunner, processEnvironment, type ProcessRunner } from './supabase-cli.ts';
import { CliFailure } from './cli-error.ts';
import { publicKey } from './connection.ts';

export interface ProjectChoice { ref:string; name:string }
export interface PublicKey { id:string; name:string; key:string }
async function isolated<T>(operation:(directory:string)=>Promise<T>): Promise<T> {
  const directory=mkdtempSync(join(tmpdir(),'supagame-setup-'));
  try {
    mkdirSync(join(directory,'supabase'));
    writeFileSync(join(directory,'supabase/config.toml'),'project_id = "supagame-setup"\n');
    return await operation(directory);
  } finally { rmSync(directory,{recursive:true,force:true}); }
}
export class SetupEnvironment {
  private readonly run: ProcessRunner;
  constructor(run:ProcessRunner=createSupabaseRunner(30_000)) { this.run=run; }
  async check(nodeVersion=process.versions.node): Promise<string> {
    if (!/^(24|26)\./.test(nodeVersion)) throw new CliFailure('configuration','UNSUPPORTED_NODE','Use Node.js 24 or 26 for Supagame.');
    return isolated(async directory=>{
      const result=await this.run(['--version'],directory);
      if(result.code!==0) throw new CliFailure('configuration','SUPABASE_UNAVAILABLE','Supabase CLI is unavailable. Install the pinned local dependency: npm install -D --save-exact supabase@3.1.0, then run through npx.');
      assertSupabaseVersion(result.stdout);
      return result.stdout.trim();
    });
  }
  private async json(args:string[],ref?:string): Promise<Record<string,unknown>> {
    return isolated(async directory=>{
      let result;
      try { result=await this.run([...args,...(ref ? [`--remote=${ref}`]:[]),'--workdir',directory,'--output-format','json'],directory); }
      catch { throw new CliFailure('configuration','SUBPROCESS_FAILED','Could not start Supabase CLI. Check executable availability and permissions.'); }
      if(result.code!==0) throw new CliFailure('authentication','SUPABASE_ACCESS_FAILED','Could not inspect Supabase account/project information. Run supabase login and check network access and account permissions. Raw subprocess output is withheld.');
      let value:unknown;
      try { value=JSON.parse(result.stdout); } catch { throw new CliFailure('configuration','MALFORMED_PROJECT_INFO','Supabase returned malformed project information; raw output is withheld.'); }
      if(!object(value)) throw new CliFailure('configuration','MALFORMED_PROJECT_INFO','Supabase returned invalid project information.');
      if(ref && (!object(value.target)||value.target.kind!=='linked'||value.target.project_ref!==ref)) throw new CliFailure('configuration','TARGET_MISMATCH','Supabase response target does not match the selected project.');
      return value;
    });
  }
  async projects(): Promise<ProjectChoice[]> {
    const value=await this.json(['projects','list']);
    if(!Array.isArray(value.projects)) throw new CliFailure('configuration','MALFORMED_PROJECT_INFO','Supabase project inventory is missing. Enter a project reference manually or repair CLI access.');
    const seen=new Set<string>();
    return value.projects.map(row=>{
      if(!object(row)||!projectRef(row.id)|| (row.ref!==undefined && row.ref!==row.id)||typeof row.name!=='string'||!row.name.trim()||row.name.length>256||seen.has(row.id)) throw new CliFailure('configuration','MALFORMED_PROJECT_INFO','Supabase project inventory is malformed or ambiguous.');
      seen.add(row.id);return {ref:row.id,name:row.name};
    });
  }
  async keys(ref:string): Promise<PublicKey[]> {
    if(!projectRef(ref)) throw new CliFailure('validation','INVALID_PROJECT_REF','Invalid project reference.');
    const value=await this.json(['projects','api-keys'],ref);
    if(!Array.isArray(value.keys)) throw new CliFailure('configuration','MALFORMED_KEYS','Supabase public key inventory is missing.');
    const keys:PublicKey[]=[];
    for(const row of value.keys) {
      if(!object(row)) throw new CliFailure('configuration','MALFORMED_KEYS','Supabase key inventory is malformed.');
      // Discard all privileged and legacy keys without rendering their fields.
      if(row.type!=='publishable') continue;
      if(typeof row.id!=='string'||!row.id||typeof row.name!=='string'||!publicKey(row.api_key)||keys.some(k=>k.id===row.id)) throw new CliFailure('configuration','MALFORMED_KEYS','Supabase public key inventory is malformed or ambiguous.');
      keys.push({id:row.id,name:row.name,key:row.api_key});
    }
    if(!keys.length) throw new CliFailure('configuration','NO_PUBLIC_KEY','No modern publishable key is available. Create one in Supabase project settings, then retry connection export.');
    return keys;
  }
  async customDomain(ref:string): Promise<string> {
    const value=await this.json(['domains','get'],ref);
    // Only an active project-bound hostname may replace the canonical API URL.
    const data=object(value.data)?value.data:undefined;
    const domain=data && object(data.result)?data.result:undefined;
    if(value.status!=='5_services_reconfigured'||typeof value.custom_hostname!=='string'||data?.success!==true||!domain||domain.hostname!==value.custom_hostname||domain.status!=='active'||!object(domain.ssl)||domain.ssl.status!=='active') throw new CliFailure('configuration','CUSTOM_URL_UNVERIFIED','An active custom domain could not be verified for this project. Use the canonical Supabase URL.');
    return value.custom_hostname;
  }
  async login(): Promise<void> {
    await isolated(directory=>new Promise<void>((resolve,reject)=>{
      // The official login owns its interactive browser/token flow. Never read credential files.
      const child=spawn('supabase',['login','--workdir',directory],{cwd:directory,env:processEnvironment(process.env),stdio:'inherit'});
      child.once('error',()=>reject(new CliFailure('authentication','LOGIN_FAILED','Could not start supabase login.')));
      child.once('exit',code=>code===0?resolve():reject(new CliFailure('authentication','LOGIN_FAILED','Supabase login did not complete. No project configuration was written.')));
    }));
  }
}
