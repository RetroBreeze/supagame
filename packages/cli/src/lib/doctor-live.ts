import { adminDoctorSql } from './admin.ts';
import { inspectHostedConfiguration } from './doctor-hosted.ts';
import type { Diagnostic } from '../commands/doctor.ts';
import type { DeploymentState } from './deployment-state.ts';
import type { Inventory, ModuleRelease } from './versions.ts';
import type { MigrationFile } from './migration-generator.ts';
import type { ProcessRunner } from './supabase-cli.ts';
import { DoctorInspector, inspectionWorkspace } from './doctor-inspect.ts';
import { securityChecks, securityQuery } from './doctor-security.ts';
import { deploymentFiles } from './deployment-files.ts';
import { compareVersions } from './versions.ts';
import { object } from './manifest.ts';

export interface LiveInspection {
  root: string;
  projectId: string;
  port: number;
  ref: string;
  remote: boolean;
  localAnonymous: boolean;
  origins: string[] | undefined;
  files: MigrationFile[];
  releases: ModuleRelease[];
  inventory: Inventory;
  receipt: DeploymentState | null | undefined;
  run: ProcessRunner;
  report: (
    scope: Diagnostic['scope'],
    id: string,
    status: Diagnostic['status'],
    message: string,
  ) => void;
}
export async function inspectLive(context: LiveInspection): Promise<void> {
  const { root, ref, files, releases, receipt, report } = context;
  const workspace = inspectionWorkspace({
    projectId: String(context.projectId),
    port: context.port,
  }, files);
  try {
    const inspector = new DoctorInspector(context.run, workspace.root, {
      projectId: String(context.projectId),
      port: context.port,
      ...(context.remote ? { ref } : {}),
    });
    await inspector.version();
    if (releases.some(r => r.module === 'admin')) {
      const admin = await inspector.query(adminDoctorSql);
      const healthy = Array.isArray(admin) && admin.length === 1 && object(admin[0]) && Object.entries(admin[0]).every(([key,value]) => key === 'module' || value === true);
      report('database','admin-security',healthy ? 'healthy' : 'error','Admin private execution grants and RLS inspection.');
    }
    const history = await inspector.json(['migration', 'list']);
    if (
      !object(history) || !Array.isArray(history.migrations) ||
      history.migrations.some((r) =>
        !object(r) || typeof r.local !== 'string' || typeof r.remote !== 'string'
      )
    ) throw new Error('Migration history has an unsupported shape; cannot verify schema versions.');
    const rows = history.migrations as { local: string; remote: string }[];
    const listedLocal = rows.filter((row) => row.local).map((row) => row.local);
    const listedRemote = rows.filter((row) => row.remote).map((row) => row.remote);
    if (
      rows.some((row) =>
        (!row.local && !row.remote) || (row.local && !/^\d{14}$/.test(row.local)) ||
        (row.remote && !/^\d+$/.test(row.remote)) ||
        (row.local && row.remote && row.local !== row.remote)
      ) || new Set(listedLocal).size !== listedLocal.length ||
      new Set(listedRemote).size !== listedRemote.length || listedLocal.length !== files.length ||
      files.some((file) => !listedLocal.includes(file.version))
    ) {
      throw new Error(
        'Migration inventory is incomplete or contradictory; cannot verify schema versions.',
      );
    }

    for (const r of releases) {
      const pending = r.migrations.filter((f) =>
        !rows.some((row) => row.remote === f.path.split('/').at(-1)!.slice(0, 14))
      );
      const detected = context.inventory.filter((candidate) =>
        candidate.module === r.module && candidate.migrations.length > 0 &&
        candidate.migrations.every((f) =>
          rows.some((row) => row.remote === f.path.split('/').at(-1)!.slice(0, 14))
        )
      ).sort((a, b) => compareVersions(a.version, b.version)).at(-1);
      report(
        'database',
        `schema:${r.module}`,
        detected?.version === r.version && !pending.length ? 'healthy' : 'warning',
        `${r.module} schema ${
          detected?.version ?? 'not installed/partial'
        }; expected ${r.version}. ${
          pending.length
            ? `Incomplete/outdated; pending: ${
              pending.map((f) => f.path).join(', ')
            }. Review deployment separately.`
            : 'Migration ledger evidence only, not a content checksum.'
        }`,
      );
    }
    for (const row of rows) {
      if (row.remote && !files.some((f) => f.version === row.remote)) {
        report(
          'database',
          'history-drift',
          'error',
          `Remote/applied migration ${
            JSON.stringify(row.remote)
          } is missing locally; restore history from Git.`,
        );
      }
      if (row.local && !row.remote) {
        report(
          'database',
          'pending',
          'warning',
          `Pending migration ${JSON.stringify(row.local)}; doctor never applies it.`,
        );
      }
    }
    const checks = securityChecks(releases.map((r) => r.module));
    try {
      const result = await inspector.query(securityQuery(checks));
      if (
        !Array.isArray(result) || result.length !== checks.length || result.some((row) =>
          !object(row) || typeof row.check !== 'string' || typeof row.ok !== 'boolean'
        ) || new Set(result.map((row) =>
            row.check
          )).size !== checks.length ||
        checks.some((c) => !result.some((row) => row.check === c.id))
      ) throw new Error('Unexpected catalog query response.');
      for (const check of checks) {
        const row = result.find((row) => row.check === check.id)!;
        report(
          'database',
          check.id,
          row.ok ? 'healthy' : 'error',
          row.ok ? 'Expected catalog security setting verified.' : check.remedy,
        );
      }
    } catch {
      report(
        'database',
        'security',
        'cannot verify',
        'Catalog security inspection unavailable or incomplete. Check read permissions and run local security regressions; no security success is assumed.',
      );
    }
    if (context.remote) {
      await inspectHostedConfiguration(context);
      if (releases.some((r) => r.module === 'leaderboards')) {
        try {
          const data = await inspector.json(['functions', 'list']);
          if (!object(data) || !Array.isArray(data.functions)) {
            throw new Error('Unsupported function list.');
          }
          const matches = data.functions.filter((f) => object(f) && f.slug === 'supagame');
          if (matches.length !== 1) {
            report(
              'remote',
              'function',
              'error',
              'Missing or ambiguous hosted supagame function. Review a separate deployment.',
            );
          } else {
            const fn = matches[0];
            report(
              'remote',
              'function',
              fn.status === 'ACTIVE' && fn.verify_jwt === false ? 'healthy' : 'error',
              'Hosted supagame must be ACTIVE with verify_jwt = false; verify configuration before a separate deployment.',
            );
            let matchesReceipt = false;
            try {
              const localFiles = deploymentFiles(root, ref);
              matchesReceipt = !!receipt && receipt.phase === 'complete' &&
                receipt.functionHash === localFiles.functionHash &&
                typeof receipt.remoteFunction?.hash === 'string' &&
                receipt.remoteFunction?.hash === fn.ezbr_sha256 &&
                receipt.remoteFunction?.version === fn.version &&
                receipt.remoteFunction?.verifyJwt === fn.verify_jwt;
            } catch { /* Local drift has separate findings. */ }
            report(
              'remote',
              'function-content',
              matchesReceipt ? 'healthy' : receipt?.phase === 'complete' &&
                  typeof receipt.remoteFunction?.hash === 'string' &&
                  typeof fn.ezbr_sha256 === 'string'
                ? 'warning'
                : 'cannot verify',
              matchesReceipt
                ? 'Remote version/hash and local assets match the verified deployment receipt.'
                : 'Deployed code could not be matched to local assets and the deployment receipt. Inspect local/remote version or hash drift; function status alone is not a code audit.',
            );
          }
        } catch {
          report(
            'remote',
            'function',
            'cannot verify',
            'Hosted function inspection unavailable. Check read permissions and service reachability.',
          );
        }
      }
      report(
        'remote',
        'http',
        'cannot verify',
        'Runtime HTTP/CORS and secret values are not probed. Run the authenticated integration suite separately; doctor does not obtain player sessions.',
      );
    }
  } catch {
    report(
      context.remote ? 'remote' : 'database',
      'connection',
      'cannot verify',
      'Inspection unavailable or target unverified. Check Supabase CLI 3.0.0 or 3.1.0, the local stack or selected remote project read access/network. Raw errors are withheld.',
    );
  } finally {
    workspace.remove();
  }
}
