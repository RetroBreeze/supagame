import { localOrigins } from '../lib/local-origins.ts';
import { executePlan, planFiles } from '../lib/file-stage.ts';
import { MANIFEST, manifestBytes, object, readManifest } from '../lib/manifest.ts';
import { mergeOrigins } from '../lib/origins.ts';
import { readProject, selectedRef } from '../lib/project.ts';
import type { LocalOptions } from '../lib/project.ts';
export function addOrigins(additions: string[], options: LocalOptions): void {
  const { root, config } = readProject(options);
  const existing = readManifest(root);
  if (!existing) {
    throw new Error('Run supagame init before configuring origins.');
  }
  selectedRef(root, undefined, existing.value.projectRef);
  const runtime = localOrigins(
    root,
    mergeOrigins(existing.value.origins ?? [], additions),
    object(config.api) ? Number(config.api.port ?? 54321) : 54321,
  );
  const origins = runtime.origins;
  const content = JSON.stringify(origins) === JSON.stringify(existing.value.origins)
    ? existing.bytes
    : manifestBytes({ ...existing.value, origins });
  executePlan(
    root,
    planFiles(root, [...runtime.files, {
      path: MANIFEST,
      content,
      replace: existing.bytes,
    }]),
    options.dryRun ?? false,
  );
  console.log(
    `${origins.length} browser origins configured locally. Run supagame deploy to preview and authorize hosted configuration.`,
  );
}
