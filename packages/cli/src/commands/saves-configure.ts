import {
  defaultSaveLimits,
  saveLimitsSql,
  saveLimitsSuffix,
  validSaveLimits,
} from "../lib/cloud-saves.ts";
import { executePlan, planFiles } from "../lib/file-stage.ts";
import { MANIFEST, manifestBytes, readManifest } from "../lib/manifest.ts";
import { migrations, nextVersion } from "../lib/migration-generator.ts";
import { readProject, selectedRef, type LocalOptions } from "../lib/project.ts";
export function configureSaves(
  options: LocalOptions & {
    maxSlots?: string;
    maxJsonBytes?: string;
    maxBinaryBytes?: string;
    maxTotalBytes?: string;
  },
) {
  const { root } = readProject(options),
    existing = readManifest(root);
  if (!existing?.value.modules["cloud-saves"])
    throw new Error("Run supagame add cloud-saves first.");
  selectedRef(root, undefined, existing.value.projectRef);
  const previous = existing.value.cloudSaves ?? defaultSaveLimits;
  const value = { ...previous };
  for (const key of Object.keys(value) as (keyof typeof value)[])
    if (options[key] !== undefined) {
      if (!/^\d+$/.test(options[key]!))
        throw new Error("Save limits must be positive integers.");
      value[key] = Number(options[key]);
    }
  if (!validSaveLimits(value))
    throw new Error(
      "Invalid save limits: slots 1–1000, JSON up to 1 MiB, binary up to 5 GiB, total up to 50 GiB.",
    );
  if (JSON.stringify(value) === JSON.stringify(previous)) {
    console.log("Cloud Saves limits unchanged.");
    return;
  }
  const files = migrations(root);
  // Reverting an earlier configuration requires a new ordered migration.
  const path = `supabase/migrations/${nextVersion(files)}${saveLimitsSuffix(value)}`;
  executePlan(
    root,
    planFiles(root, [
      { path, content: saveLimitsSql(value) },
      {
        path: MANIFEST,
        content: manifestBytes({ ...existing.value, cloudSaves: value }),
        replace: existing.bytes,
      },
    ]),
    options.dryRun ?? false,
  );
  console.log(
    "Cloud Saves quotas and private bucket limit staged. Global hosted Storage limits may be lower; doctor reports what can be verified.",
  );
}
