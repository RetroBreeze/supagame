import { executePlan, planFiles } from '../lib/file-stage.ts';
import { MANIFEST, manifestBytes, readManifest } from '../lib/manifest.ts';
import { readProject, selectedRef } from '../lib/project.ts';
import type { LocalOptions } from '../lib/project.ts';

export function init(options: LocalOptions): void {
  const project = readProject(options);
  const existing = readManifest(project.root);
  const projectRef = selectedRef(
    project.root,
    options.projectRef,
    existing?.value.projectRef,
  );
  const content = existing?.bytes ??
    manifestBytes({
      formatVersion: 1,
      projectRef,
      modules: {},
      leaderboards: [],
    });
  console.log(
    `Project reference: ${projectRef} (local record only; no remote operation).`,
  );
  executePlan(
    project.root,
    planFiles(project.root, [
      { path: 'supabase/config.toml', content: project.bytes },
      { path: MANIFEST, content },
    ]),
    options.dryRun ?? false,
  );
}
