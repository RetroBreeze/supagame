import { log } from '../lib/terminal.ts';
import { modulePlan } from '../lib/module-plan.ts';
import { executePlan, planFiles } from '../lib/file-stage.ts';
import { MANIFEST, manifestBytes, object, readManifest } from '../lib/manifest.ts';
import { readProject, selectedRef } from '../lib/project.ts';
import type { LocalOptions } from '../lib/project.ts';
import { MODULE_VERSION } from '../lib/templates.ts';

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
  const { value, config, files } = modulePlan(project, existing.value, [module]);
  const unchanged = JSON.stringify(value) === JSON.stringify(existing.value);
  const plan = planFiles(project.root, [
    ...files,
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
  log(
    `Project reference: ${ref}; ${Object.keys(value.modules).join(', ')} ${MODULE_VERSION} (local staging only).`,
  );
  executePlan(project.root, plan, options.dryRun ?? false);
  if (
    !object(project.config.auth) ||
    project.config.auth.enable_anonymous_sign_ins !== true
  ) {
    log(
      'Anonymous sign-in is not enabled in local config. Enable auth.enable_anonymous_sign_ins for anonymous players; deploy previews and enables the hosted prerequisite after authorization. Existing settings were preserved.',
    );
  }
  log(
    value.origins ? 'Browser origins are configured; deploy will inspect hosted configuration. No hosted changes were made.' : 'For browser games, run supagame config origins add <origin>. No database migrations or function deployments were executed.',
  );
}
