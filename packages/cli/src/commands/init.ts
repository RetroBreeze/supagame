import { installationIgnore, localOrigins } from '../lib/local-origins.ts';
import { mergeOrigins } from '../lib/origins.ts';
import { executePlan, planFiles, projectRoot, readProjectFile } from '../lib/file-stage.ts';
import { MANIFEST, manifestBytes, object, readManifest } from '../lib/manifest.ts';
import { readProject, selectedRef } from '../lib/project.ts';
import type { LocalOptions } from '../lib/project.ts';

export interface InitOptions extends LocalOptions {
  origin?: string[];
}
export function init(options: InitOptions): void {
  const root = projectRoot(options.workdir ?? process.cwd());
  const previousConfig = readProjectFile(root, 'supabase/config.toml');
  if (!previousConfig && readProjectFile(root, 'supabase/config.json')) {
    throw new Error(
      'Existing supabase/config.json takes precedence over TOML. Review conversion to config.toml before initialization; existing configuration was preserved.',
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
  const value = existing?.value ?? {
    formatVersion: 1 as const,
    projectRef,
    modules: {},
    leaderboards: [],
  };
  const content = existing &&
      JSON.stringify(origins) === JSON.stringify(existing.value.origins)
    ? existing.bytes
    : manifestBytes({ ...value, ...(origins ? { origins } : {}) });
  console.log(
    `Project reference: ${projectRef} (local record only; no remote operation).`,
  );
  executePlan(
    project.root,
    planFiles(project.root, [
      { path: 'supabase/config.toml', content: project.bytes },
      ...(runtime?.files ??
        (!previousConfig ? [installationIgnore(root)] : [])),
      {
        path: MANIFEST,
        content,
        ...(existing ? { replace: existing.bytes } : {}),
      },
    ]),
    options.dryRun ?? false,
  );
}
