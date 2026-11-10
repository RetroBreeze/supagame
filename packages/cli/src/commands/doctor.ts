import { existsSync } from 'node:fs';
import { projectRoot, readProjectFile, safePath } from '../lib/file-stage.ts';
import { object, readManifest } from '../lib/manifest.ts';
import { leaderboardSql, migrations } from '../lib/migration-generator.ts';
import { functionConfig, readProject, selectedRef } from '../lib/project.ts';
import type { LocalOptions } from '../lib/project.ts';
import { templateFiles } from '../lib/templates.ts';
import { currentInventory, latestRelease, releaseFor, validateInventory } from '../lib/versions.ts';
import type { Inventory, ModuleName, ModuleRelease } from '../lib/versions.ts';
import { runSupabase } from '../lib/supabase-cli.ts';
import type { ProcessRunner } from '../lib/supabase-cli.ts';
import { inspectLive } from '../lib/doctor-live.ts';
import { readState } from '../lib/deployment-state.ts';

export type DiagnosticStatus = 'healthy' | 'warning' | 'error' | 'cannot verify';
export interface Diagnostic {
  scope: 'local' | 'database' | 'remote';
  id: string;
  status: DiagnosticStatus;
  message: string;
}
export interface DoctorOptions extends LocalOptions {
  local?: boolean;
  remote?: boolean;
}
export interface DoctorDependencies {
  run: ProcessRunner;
  log: (message: string) => void;
  inventory: Inventory;
}
export async function doctor(
  options: DoctorOptions,
  dependencies: DoctorDependencies = {
    run: runSupabase,
    log: console.log,
    inventory: currentInventory(templateFiles()),
  },
): Promise<Diagnostic[]> {
  const findings: Diagnostic[] = [];
  const report = (
    scope: Diagnostic['scope'],
    id: string,
    status: DiagnosticStatus,
    message: string,
  ) => {
    findings.push({ scope, id, status, message });
  };
  const local = (id: string, status: DiagnosticStatus, message: string) =>
    report('local', id, status, message);
  const attempt = <T>(id: string, operation: () => T): T | undefined => {
    try {
      return operation();
    } catch (error) {
      local(
        id,
        'error',
        error instanceof Error ? error.message : 'Inspection failed. Review project files.',
      );
      return undefined;
    }
  };
  const finish = () => {
    for (const f of findings) {
      dependencies.log(`${f.status.toUpperCase()} [${f.scope}:${f.id}] ${f.message}`);
    }
    return findings;
  };
  if (options.local && options.remote) {
    local('target', 'error', 'Choose --local or --remote, not both.');
    return finish();
  }
  const root = attempt('project', () => projectRoot(options.workdir ?? process.cwd()));
  if (!root) return finish();
  const project = attempt('configuration', () => readProject({ workdir: root }));
  const manifest = attempt('manifest', () => {
    const m = readManifest(root);
    if (!m) throw new Error('Missing manifest. Run supagame init and add leaderboards.');
    return m;
  });
  if (project) {
    local(
      'configuration',
      'healthy',
      `Supabase project configuration found (${String(project.config.project_id)}).`,
    );
  }
  if (manifest) local('manifest', 'healthy', 'Manifest formatVersion 1 is valid.');
  const ref = attempt('project-reference', () => {
    if (options.remote && !options.projectRef) {
      throw new Error(
        'Remote doctor requires --remote --project-ref <ref>; no hosted target is inferred.',
      );
    }
    return selectedRef(root, options.projectRef, manifest?.value.projectRef);
  });
  if (ref) local('project-reference', 'healthy', `Selected project reference: ${ref}.`);
  for (const path of ['supabase/config.json', '.env', '.env.local', 'supabase/.env']) {
    attempt('overrides', () => {
      if (existsSync(safePath(root, path))) {
        local(
          'overrides',
          'warning',
          `${path} exists. Effective overrides are not evaluated; inspect configuration precedence manually. The override file contents were not read.`,
        );
      }
    });
  }
  if (project) {
    local(
      'anonymous-auth',
      object(project.config.auth) && project.config.auth.enable_anonymous_sign_ins === true
        ? 'healthy'
        : 'warning',
      'Anonymous authentication: ' +
        (object(project.config.auth) && project.config.auth.enable_anonymous_sign_ins === true
          ? 'enabled in local TOML.'
          : 'enable auth.enable_anonymous_sign_ins for anonymous players. Hosted settings are separate.'),
    );
    if (project.config.remotes !== undefined) {
      local(
        'overrides',
        'warning',
        'Remote-specific configuration exists. Doctor checks the base TOML; inspect target overrides manually.',
      );
    }
  }
  if (manifest?.value.modules['live-leaderboards']) local('live-realtime-settings', 'warning', 'Verify Realtime is enabled and private channels are supported in the target project. Public-channel settings and WebSocket delivery require a separate runtime check.');
  const releases: ModuleRelease[] = [];
  if (
    !attempt('inventory', () => {
      validateInventory(dependencies.inventory);
      return true;
    })
  ) return finish();
  if (manifest) {
    for (const [module, version] of Object.entries(manifest.value.modules)) {
      const r = attempt(
        `module:${module}`,
        () => releaseFor(dependencies.inventory, module as ModuleName, version),
      );
      if (r) {
        releases.push(r);
        const latest = latestRelease(dependencies.inventory, r.module);
        local(
          `module:${module}`,
          r.version === latest.version ? 'healthy' : 'warning',
          `${module} ${version}; available ${latest.version}. ${
            r.version === latest.version ? 'Current.' : 'Review supagame upgrade --dry-run.'
          }`,
        );
      }
    }
  }
  if (manifest && !releases.length) {
    local(
      'modules',
      'warning',
      'No known installed modules; run supagame add leaderboards or use the matching CLI.',
    );
  }
  for (const r of releases) {
    if (r.requiresCore && r.requiresCore !== manifest?.value.modules.core) {
      local(
        'module-dependencies',
        'error',
        'Incompatible core/leaderboards versions. Restore the matching release pair.',
      );
    }
    for (const file of [...r.migrations, ...r.assets]) {
      attempt(`file:${file.path}`, () => {
        const actual = readProjectFile(root, file.path);
        local(
          `file:${file.path}`,
          actual?.equals(file.content) ? 'healthy' : 'error',
          actual?.equals(file.content)
            ? `${file.path} matches ${r.version}.`
            : `Missing or modified ${file.path}; restore the original version from Git or the matching CLI. Doctor does not repair files.`,
        );
      });
    }
  }
  if (project && manifest?.value.modules.leaderboards) {
    attempt('function-configuration', () => {
      if (!functionConfig(project.bytes, project.config).equals(project.bytes)) {
        throw new Error(
          'Missing function configuration; restore [functions.supagame] with verify_jwt = false and the staged entrypoint/import_map.',
        );
      }
      local(
        'function-configuration',
        'healthy',
        'Edge Function configuration matches route-specific authentication.',
      );
    });
  }
  const files = attempt('migrations', () => migrations(root));
  if (files && manifest) {
    for (const board of manifest.value.leaderboards) {
      const found = files.filter((f) => f.name.endsWith(`_supagame_board_${board.id}.sql`));
      local(
        `board:${board.id}`,
        found.length === 1 && found[0]!.content.equals(leaderboardSql(board)) ? 'healthy' : 'error',
        `Leaderboard ${board.id}: ${
          found.length === 1 && found[0]!.content.equals(leaderboardSql(board))
            ? 'manifest and SQL agree.'
            : 'restore its original migration and reconcile the manifest.'
        }`,
      );
    }
    for (const file of files) {
      if (
        file.name.includes('_supagame_board_') &&
        !manifest.value.leaderboards.some((b) => file.name.endsWith(`_supagame_board_${b.id}.sql`))
      ) {
        local(
          'manifest-drift',
          'error',
          `Unrecorded board migration ${file.name}; reconcile using its original create command.`,
        );
      }
    }
  }
  attempt('deployment', () => {
    if (existsSync(safePath(root, '.supagame-deploy-lock'))) {
      local(
        'deployment',
        'warning',
        'Deployment lock exists; inspect the running/interrupted operation before maintenance.',
      );
    }
  });
  const receipt = ref ? attempt('deployment-journal', () => readState(root, ref)) : undefined;
  if (receipt && receipt.phase !== 'complete') {
    local(
      'deployment',
      'warning',
      'Previous deployment is incomplete. Inspect remote progress; do not discard its journal or retry blindly.',
    );
  }
  if (!options.local && !options.remote) {
    report(
      'database',
      'live',
      'cannot verify',
      'Live schema versions, RLS and grants were not inspected. Use doctor --local, or --remote --project-ref <ref>.',
    );
    report(
      'remote',
      'live',
      'cannot verify',
      'Hosted Auth and Edge health require explicit remote inspection.',
    );
    return finish();
  }
  if (
    !project || !manifest || !ref || !files ||
    releases.length !== Object.keys(manifest.value.modules).length || !releases.length
  ) {
    report(
      'database',
      'live',
      'cannot verify',
      'Resolve local configuration/manifest/target errors before live inspection.',
    );
    return finish();
  }
  const port = object(project.config.db) ? project.config.db.port ?? 54322 : 54322;
  if (!Number.isInteger(port) || Number(port) < 1 || Number(port) > 65535) {
    local('port', 'error', 'Invalid db.port; select a valid local Supabase port.');
    return finish();
  }
  await inspectLive({
    root,
    ref,
    files,
    releases,
    receipt,
    report,
    projectId: String(project.config.project_id),
    port: Number(port),
    remote: options.remote ?? false,
    localAnonymous: object(project.config.auth) &&
      project.config.auth.enable_anonymous_sign_ins === true,
    run: dependencies.run,
    inventory: dependencies.inventory,
  });
  return finish();
}
export function doctorExitCode(findings: readonly Diagnostic[], live: boolean): number {
  if (findings.some((f) => f.status === 'error')) return 1;
  return live &&
      findings.some((f) => f.status === 'cannot verify' && f.id !== 'http')
    ? 2
    : 0;
}
