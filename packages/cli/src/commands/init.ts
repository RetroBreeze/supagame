import { parse } from 'smol-toml';
import { modulePlan } from '../lib/module-plan.ts';
import { log } from '../lib/terminal.ts';
import { installationIgnore, localOrigins } from '../lib/local-origins.ts';
import { mergeOrigins } from '../lib/origins.ts';
import { executePlan, planFiles, projectRoot, readProjectFile } from '../lib/file-stage.ts';
import { MANIFEST, manifestBytes, object, readManifest } from '../lib/manifest.ts';
import { readProject, selectedRef } from '../lib/project.ts';
import type { LocalOptions } from '../lib/project.ts';

export interface InitOptions extends LocalOptions {
  origin?: string[];
  module?: string[];
}
export function planInit(options: InitOptions) {
  const root = projectRoot(options.workdir ?? process.cwd());
  const previousConfig = readProjectFile(root, 'supabase/config.toml');
  if (!previousConfig && ['json', 'jsonc'].some((extension) => readProjectFile(root, `supabase/config.${extension}`))) {
    throw new Error(
      'Existing supabase/config.json or config.jsonc takes precedence over TOML. Review conversion to config.toml before initialization; existing configuration was preserved.',
    );
  }
  const project = previousConfig ? readProject(options) : {
    root,
    config: {} as Record<string, unknown>,
    bytes: Buffer.alloc(0),
  };
  const existing = readManifest(project.root);
  const projectRef = selectedRef(
    project.root,
    options.projectRef,
    existing?.value.projectRef,
  );
  if (!previousConfig) {
    project.bytes = Buffer.from(
      `project_id = "supagame-${projectRef}"\n[auth]\nenable_anonymous_sign_ins = true\n[realtime]\nenabled = true\n`,
    );
  }
  const desired = options.origin
    ? mergeOrigins(existing?.value.origins ?? [], options.origin)
    : existing?.value.origins;
  const runtime = options.origin
    ? localOrigins(
      root,
      desired!,
      object(project.config.api) ? Number(project.config.api.port ?? 54321) : 54321,
    )
    : undefined;
  const origins = runtime?.origins ?? desired;
  let value = existing?.value ?? {
    formatVersion: 1 as const,
    projectRef,
    modules: {},
    leaderboards: [],
  };
  value = { ...value, ...(origins ? { origins } : {}) };
  const selected = options.module?.length ? modulePlan({...project, config:parse(project.bytes.toString())}, value, options.module) : undefined;
  value = selected?.value ?? value;
  const content = existing && JSON.stringify(value) === JSON.stringify(existing.value) ? existing.bytes : manifestBytes(value);
  const plan = planFiles(project.root, [
    ...(selected?.files ?? []),
    { path: 'supabase/config.toml', content: selected?.config ?? project.bytes, ...(previousConfig ? {replace:previousConfig} : {}) },
    ...(runtime?.files ?? (!previousConfig ? [installationIgnore(root)] : [])),
    { path: MANIFEST, content, ...(existing ? {replace:existing.bytes} : {}) },
  ]);
  return {root,plan,manifest:value};
}
export function init(options: InitOptions): void {
  const prepared = planInit(options);
  log(`Project reference: ${prepared.manifest.projectRef} (local record only; no remote operation).`);
  executePlan(prepared.root,prepared.plan,options.dryRun ?? false);

}
