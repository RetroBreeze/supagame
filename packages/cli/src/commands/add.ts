import { storageConfig } from '../lib/cloud-saves.ts';
import { executePlan, planFiles } from '../lib/file-stage.ts';
import { MANIFEST, manifestBytes, object, readManifest } from '../lib/manifest.ts';
import { functionConfig, readProject, selectedRef } from '../lib/project.ts';
import type { LocalOptions } from '../lib/project.ts';
import { checkMigrationVersions, MODULE_VERSION, templateFiles, migrationModule } from '../lib/templates.ts';

export function add(module: string, options: LocalOptions): void {
  if (module !== 'leaderboards' && module !== 'live-leaderboards' && module !== 'achievements' && module !== 'cloud-saves' && module !== 'admin') {
    throw new Error(
      `Unknown module '${module}'. Available modules: leaderboards, live-leaderboards, achievements, cloud-saves, admin.`,
    );
  }
  const project = readProject(options);
  const existing = readManifest(project.root);
  if (!existing) throw new Error('Run supagame init before adding a module.');
  const ref = selectedRef(project.root, undefined, existing.value.projectRef);
  for (const [name, version] of Object.entries(existing.value.modules)) {
    if (version !== MODULE_VERSION) {
      throw new Error(
        `Installed ${name} version ${version} differs from CLI templates ${MODULE_VERSION}. Use a matching CLI version, or inspect known forward-only paths with supagame upgrade --dry-run.`,
      );
    }
  }
  checkMigrationVersions(project.root);
  const functionBytes = functionConfig(project.bytes, project.config);
  const config = module === 'cloud-saves' ? storageConfig(functionBytes) : functionBytes;
  const value = {
    ...existing.value,
    modules: {
      ...existing.value.modules,
      ...(module === 'admin' ? { admin: MODULE_VERSION } : {}),
      core: MODULE_VERSION,
      leaderboards: MODULE_VERSION,
      ...(module === 'cloud-saves' ? { 'cloud-saves': MODULE_VERSION } : {}),
      ...(module === 'achievements' ? { achievements: MODULE_VERSION } : {}),
      ...(module === 'live-leaderboards' ? { 'live-leaderboards': MODULE_VERSION } : {}),
    },
  };
  const unchanged = (module !== 'admin' || existing.value.modules.admin === MODULE_VERSION) && (module !== 'cloud-saves' || existing.value.modules['cloud-saves'] === MODULE_VERSION) && (module !== 'achievements' || existing.value.modules.achievements === MODULE_VERSION) && (module !== 'live-leaderboards' || existing.value.modules[module] === MODULE_VERSION) && existing.value.modules.core === MODULE_VERSION &&
    existing.value.modules.leaderboards === MODULE_VERSION;
  const plan = planFiles(project.root, [
    ...templateFiles().filter(f => { const module = migrationModule(f.path); return !module || !!value.modules[module]; }),
    {
      path: 'supabase/config.toml',
      content: config,
      replace: project.bytes,
    }, // The manifest is the final commit marker, after all required assets/config.
    {
      path: MANIFEST,
      content: unchanged ? existing.bytes : manifestBytes(value),
      replace: existing.bytes,
    },
  ]);
  console.log(
    `Project reference: ${ref}; ${Object.keys(value.modules).join(', ')} ${MODULE_VERSION} (local staging only).`,
  );
  executePlan(project.root, plan, options.dryRun ?? false);
  if (
    !object(project.config.auth) ||
    project.config.auth.enable_anonymous_sign_ins !== true
  ) {
    console.log(
      'Anonymous sign-in is not enabled in local config. Enable auth.enable_anonymous_sign_ins for anonymous players; deploy previews and enables the hosted prerequisite after authorization. Existing settings were preserved.',
    );
  }
  console.log(
    value.origins ? 'Browser origins are configured; deploy will inspect hosted configuration. No hosted changes were made.' : 'For browser games, run supagame config origins add <origin>. No database migrations or function deployments were executed.',
  );
}
