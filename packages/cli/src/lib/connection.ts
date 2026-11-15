import { type DesiredFile, readProjectFile } from './file-stage.ts';
import { object, projectRef } from './manifest.ts';
import { CliFailure } from './cli-error.ts';
export interface ConnectionInfo { schemaVersion:1; projectRef:string; supabaseUrl:string; publishableKey:string; apiBaseUrl:string }
export function publicKey(value:unknown): value is string { return typeof value==='string' && /^sb_publishable_[A-Za-z0-9_-]{12,512}$/.test(value); }
export function connectionInfo(ref:string,key:string,url?:string,verifiedHostname?:string): ConnectionInfo {
  if(!projectRef(ref)) throw new CliFailure('validation','INVALID_PROJECT_REF','Invalid project reference.');
  if(!publicKey(key)) throw new CliFailure('validation','INVALID_PUBLIC_KEY','A modern Supabase publishable key is required. Privileged credentials and JWTs are not accepted.');
  const canonical=`https://${ref}.supabase.co`;
  let parsed:URL;
  try { parsed=new URL(url??canonical); } catch { throw new CliFailure('validation','INVALID_PROJECT_URL','Invalid Supabase project URL.'); }
  if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.search||parsed.hash||parsed.pathname!=='/'||parsed.port||
    (parsed.origin!==canonical && parsed.hostname!==verifiedHostname)) throw new CliFailure('validation','PROJECT_URL_MISMATCH','Supabase URL must match this project or its verified active custom domain, with HTTPS and no path, credentials or query.');
  return {schemaVersion:1,projectRef:ref,supabaseUrl:parsed.origin,publishableKey:key,apiBaseUrl:`${parsed.origin}/functions/v1/supagame/v1`};
}
export function connectionFile(root:string,path:string,info:ConnectionInfo,replace=false): DesiredFile {
  if(!path.endsWith('.json')||path==='supagame.config.json'||path.split('/').some(part=>['.git','supabase','node_modules'].includes(part)||part.startsWith('.supagame-'))) throw new CliFailure('validation','RESERVED_EXPORT_PATH','Choose a .json export path outside reserved Git, Supabase, dependency and installer paths.');
  const content=Buffer.from(JSON.stringify(info,null,2)+'\n'),before=readProjectFile(root,path);
  if(!before || before.equals(content)) return {path,content};
  if(!replace) throw new CliFailure('configuration','EXPORT_EXISTS','Connection export already exists with different values. Review it, then explicitly use --replace.');
  let previous:unknown;
  try { previous=JSON.parse(before.toString()); } catch { throw new CliFailure('configuration','EXPORT_CONFLICT','Refusing to replace an unrecognized connection export.'); }
  if(!object(previous)||Object.keys(previous).sort().join()!=='apiBaseUrl,projectRef,publishableKey,schemaVersion,supabaseUrl'||previous.schemaVersion!==1||previous.projectRef!==info.projectRef||!publicKey(previous.publishableKey)||typeof previous.supabaseUrl!=='string'||previous.apiBaseUrl!==`${previous.supabaseUrl}/functions/v1/supagame/v1`) throw new CliFailure('configuration','EXPORT_CONFLICT','Refusing to replace a foreign file or connection export for another project.');
  return {path,content,replace:before};
}
