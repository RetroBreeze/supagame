import { init, planInit, type InitOptions } from './init.ts';
import { resolveConnection } from './connection.ts';
import { applyPlan, planFiles, projectRoot, readProjectFile, reportPlan } from '../lib/file-stage.ts';
import { readManifest, projectRef } from '../lib/manifest.ts';
import { selectedRef } from '../lib/project.ts';
import { currentTerminal, log } from '../lib/terminal.ts';
import { type Prompts, Cancelled } from '../lib/prompts.ts';
import { SetupEnvironment, type ProjectChoice } from '../lib/setup-environment.ts';
import { moduleChoices } from '../lib/module-plan.ts';
import { mergeOrigins } from '../lib/origins.ts';
import { CliFailure } from '../lib/cli-error.ts';
import { connectionFile } from '../lib/connection.ts';

export interface GuidedInitOptions extends InitOptions { connectionFile?:string; replace?:boolean; keyId?:string; url?:string }
export async function guidedInit(options:GuidedInitOptions, prompts?:Prompts, environment=new SetupEnvironment()): Promise<void> {
  const root=projectRoot(options.workdir??process.cwd()),existing=readManifest(root);
  const guided=!!prompts && (options.interactive===true || (!options.projectRef && !existing));
  if(!guided && !options.connectionFile) { init(options); return; }
  const terminal=currentTerminal();
  terminal?.event({kind:'progress',message:'Checking Node.js and Supabase CLI…'});
  const version=await environment.check();
  terminal?.values({'Node.js':process.versions.node,'Supabase CLI':version,'Local Supabase':readProjectFile(root,'supabase/config.toml')?'Found':'Will initialize','Supagame':existing?'Installed':'New installation'});
  let ref:string|undefined;
  // Inspect all local target sources before account discovery or questions.
  if(options.projectRef || existing || readProjectFile(root,'supabase/.temp/project-ref') || readProjectFile(root,'supabase/.temp/linked-project.json')) ref=selectedRef(root,options.projectRef,existing?.value.projectRef);
  let projects:ProjectChoice[]=[];
  if(guided) {
    terminal?.event({kind:'progress',message:'Checking Supabase account access…'});
    try { projects=await environment.projects(); }
    catch(error) {
      if(!(error instanceof CliFailure) || error.category!=='authentication') throw error;
      terminal?.event({kind:'warning',message:error.message});
      if(!options.dryRun && await prompts!.confirm('Start the normal Supabase login flow?',false)) {
        await prompts!.external(()=>environment.login());
        projects=await environment.projects();
      } else log('Continuing with local configuration only. Hosted access is unverified.');
    }
    if(!ref && projects.length) {
      const choice=await prompts!.select('Supabase project', [...projects.map(p=>({value:p.ref,label:`${p.name} (${p.ref})`})),{value:'manual',label:'Enter project reference manually'}]);
      if(choice!=='manual') ref=choice;
    }
    if(!ref) ref=await prompts!.text('Supabase project reference', {validate:v=>projectRef(v)?undefined:'Use the 20 lowercase letters/digits from project settings.'});
  }
  ref=selectedRef(root,ref??options.projectRef,existing?.value.projectRef);
  let modules=options.module;
  if(guided && modules===undefined) modules=await prompts!.multiselect('Which Supagame services would you like?',moduleChoices,existing?Object.keys(existing.value.modules).filter(m=>m!=='core'):['leaderboards']);
  if(modules?.length) log('Selected services include their Core and Leaderboards prerequisites. Existing services are preserved. Admin provides operator tools; it does not require a game-client SDK.');
  let origin=options.origin;
  if(guided && origin===undefined && await prompts!.confirm('Configure browser origins? Native engines can skip this.',false)) {
    const value=await prompts!.text('Exact browser origins, separated by commas', {validate:v=>{
      try { mergeOrigins([],v.split(',').map(s=>s.trim())); } catch { return 'Enter exact HTTP(S) origins without paths, credentials or wildcards.'; }
    }});
    origin=value.split(',').map(s=>s.trim());
  }
  let output=options.connectionFile;
  if(guided && output===undefined && await prompts!.confirm('Export public connection information as JSON?',false)) output=await prompts!.text('Connection export file', {default:'supagame.connection.json'});
  const prepared=planInit({...options,projectRef:ref,...(modules===undefined?{}:{module:modules}),...(origin===undefined?{}:{origin})});
  if(output) {
    const info=await resolveConnection(ref,options,environment,guided?prompts:undefined);
    const file=connectionFile(root,output,info,options.replace);
    if(prepared.plan.some(p=>p.path===file.path)) throw new CliFailure('configuration','EXPORT_CONFLICT','Connection export path conflicts with an installation file.');
    prepared.plan.splice(prepared.plan.length-1,0,...planFiles(root,[file]));
  }
  terminal?.heading('Ready to initialize');
  terminal?.values({Project:projects.find(p=>p.ref===ref)?.name??ref,Reference:ref,Modules:Object.keys(prepared.manifest.modules).join(', ')||'None','Browser origins':prepared.manifest.origins?.join(', ')||'Not configured (optional)'});
  reportPlan(prepared.plan,options.dryRun??false);
  if(!options.dryRun) {
    if(guided && !await prompts!.confirm('Apply configuration?',true)) throw new Cancelled();
    selectedRef(root,ref,readManifest(root)?.value.projectRef);
    applyPlan(root,prepared.plan);
  }
  if(terminal) terminal.result={projectRef:ref,modules:prepared.manifest.modules,dryRun:options.dryRun??false};
  log(options.dryRun?'Initialization preview complete; no project files written.':'Local initialization complete. Review and commit the files, then preview deployment with supagame deploy --project-ref '+ref+' --dry-run.');
}
