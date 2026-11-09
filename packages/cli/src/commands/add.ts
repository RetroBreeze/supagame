import { executePlan, planFiles } from '../lib/file-stage.ts';
import { MANIFEST, manifestBytes, object, readManifest } from '../lib/manifest.ts';
import { functionConfig, readProject, selectedRef } from '../lib/project.ts';
import type { LocalOptions } from '../lib/project.ts';
import { checkMigrationVersions, MODULE_VERSION, templateFiles } from '../lib/templates.ts';

export function add(module: string, options: LocalOptions): void {
  if (module !== 'leaderboards') {
    throw new Error(
      `Unknown module '${module}'. Available module: leaderboards.`,
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
  const config = functionConfig(project.bytes, project.config);
  const value = {
    ...existing.value,
    modules: {
      ...existing.value.modules,
      core: MODULE_VERSION,
      leaderboards: MODULE_VERSION,
    },
  };
  const unchanged = existing.value.modules.core === MODULE_VERSION &&
    existing.value.modules.leaderboards === MODULE_VERSION;
  const plan = planFiles(project.root, [
    ...templateFiles(),
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
    `Project reference: ${ref}; core and leaderboards ${MODULE_VERSION} (local staging only).`,
  );
  executePlan(project.root, plan, options.dryRun ?? false);
  if (
    !object(project.config.auth) ||
    project.config.auth.enable_anonymous_sign_ins !== true
  ) {
    console.log(
      'Anonymous sign-in is not enabled in local config. Enable auth.enable_anonymous_sign_ins for anonymous players; hosted Auth settings must be checked separately. Existing settings were preserved.',
    );
  }
  console.log(
    'Configure SG_ALLOWED_ORIGINS for browser clients. No database migrations or function deployments were executed.',
  );
}
