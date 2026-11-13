import { rawDeploymentLog } from '../lib/raw-deployment-log.ts';
import { DeploymentDiagnostic } from '../lib/deployment-diagnostic.ts';
import { inspectRealtime } from '../lib/realtime-inspection.ts';
import { HostedConfiguration, planOrigins } from '../lib/hosted-config.ts';
import { readOriginReceipt, writeOriginReceipt } from '../lib/origin-receipt.ts';
import { createInterface } from 'node:readline/promises';
import {
  deploymentFiles,
  deploymentLock,
  digest,
  isolatedProject,
} from '../lib/deployment-files.ts';
import { readState, writeState } from '../lib/deployment-state.ts';
import type { DeploymentState } from '../lib/deployment-state.ts';
import { readManifest } from '../lib/manifest.ts';
import { readProject, selectedRef } from '../lib/project.ts';
import type { LocalOptions } from '../lib/project.ts';
import { runSupabase, SupabaseCli } from '../lib/supabase-cli.ts';
import type { ProcessRunner } from '../lib/supabase-cli.ts';

export interface DeployOptions extends LocalOptions {
  allowRemote?: boolean;
  replaceOrigins?: boolean;
  diagnosticLog?: string;
}
export interface DeployDependencies {
  run: ProcessRunner;
  interactive: boolean;
  confirm: (ref: string) => Promise<string>;
  log: (line: string) => void;
}
function defaults(): DeployDependencies {
  return {
    run: runSupabase,
    interactive: Boolean(
      process.stdin.isTTY && process.stdout.isTTY && !process.env.CI,
    ),
    log: console.log,
    confirm: async (ref) => {
      const prompt = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      try {
        return await prompt.question(
          `Type "deploy ${ref}" to authorize the displayed hosted changes: `,
        );
      } finally {
        prompt.close();
      }
    },
  };
}
export async function deploy(
  options: DeployOptions,
  dependencies = defaults(),
): Promise<void> {
  const { root } = readProject(options);
  if (!options.projectRef) {
    throw new Error(
      'Deployment requires an explicit --project-ref <ref>. No destination is inferred.',
    );
  }
  const ref = selectedRef(
    root,
    options.projectRef,
    readManifest(root)?.value.projectRef,
  );
  if (options.dryRun && options.allowRemote) {
    throw new Error(
      'Use either --dry-run or --allow-remote; preview and authorization are distinct.',
    );
  }
  if (!options.dryRun && !dependencies.interactive && !options.allowRemote) {
    throw new Error(
      'Noninteractive deployment requires --allow-remote and an explicit --project-ref. Environment variables are not consent.',
    );
  }
  const files = deploymentFiles(root, ref);
  const manifest = readManifest(root)!.value;
  const release = deploymentLock(root);
  let hosted: HostedConfiguration | undefined;
  let isolated: ReturnType<typeof isolatedProject> | undefined;
  let diagnostic: ReturnType<typeof rawDeploymentLog> | undefined;
  try {
    if (options.diagnosticLog !== undefined) {
      dependencies.log('WARNING: Raw diagnostic logs may contain credentials. Keep the selected local file private; never share it without review and redaction.');
      diagnostic = rawDeploymentLog(options.diagnosticLog, dependencies.run);
    }
    const run = diagnostic?.run ?? dependencies.run;
    const previous = readState(root, ref);
    isolated = isolatedProject(files);
    const cli = new SupabaseCli(run, isolated.directory, ref);
    await cli.checkVersion();
    await cli.checkCapabilities();
    const plan = await cli.inspect(files.sql);
    hosted = new HostedConfiguration(run, ref);
    const configuration = await hosted.inspect();
    const realtimeIssues = manifest.modules['live-leaderboards']
      ? await hosted.realtimePrerequisites()
      : [];
    const realtime = manifest.modules['live-leaderboards'] ? await inspectRealtime(ref) : null;
    const originReceipt = readOriginReceipt(root, ref);
    const origins = planOrigins(
      manifest.origins,
      configuration.originDigest,
      originReceipt,
      options.replaceOrigins ?? false,
    );
    const originWrite = ['create', 'update', 'replace'].includes(
      origins.action,
    );
    const configurationWrite = !configuration.anonymous || originWrite;
    if (previous) {
      for (const attempted of previous.attempted) {
        const current = files.sql.find((f) => f.name === attempted.name);
        if (!current || digest(current.content) !== attempted.hash) {
          throw new Error(
            'Previously attempted migration changed or disappeared. Restore its original bytes and reconcile remote history.',
          );
        }
      }
      if (
        previous.phase === 'database_started' &&
        previous.attempted.some((f) => !plan.applied.includes(f.name.slice(0, 14)))
      ) {
        throw new Error(
          'Previous database attempt is uncertain: unapplied migrations may have partial effects. Inspect and reconcile the remote database and deployment journal before retrying.',
        );
      }
    }
    const unchanged = previous?.phase === 'complete' &&
      previous.functionHash === files.functionHash &&
      plan.fn?.status === 'ACTIVE' && plan.fn.verifyJwt === false &&
      plan.fn.hash !== null &&
      JSON.stringify(previous.remoteFunction) === JSON.stringify(plan.fn);
    dependencies.log(
      `Destination: ${
        configuration.projectName ? JSON.stringify(configuration.projectName) + ' ' : ''
      }${ref} (hosted Supabase project).`,
    );
    dependencies.log(
      `Modules: ${
        Object.entries(manifest.modules).map(([name, version]) => `${name} ${version}`).join(', ')
      }.`,
    );
    dependencies.log('Hosted configuration:');
    for (const issue of configuration.authBlockers) {
      dependencies.log(`  ACTION REQUIRED for new anonymous players: ${issue}`);
    }
    dependencies.log(
      `  Anonymous authentication: ${
        configuration.anonymous ? 'already enabled (verified)' : 'enable (pending authorization)'
      }.`,
    );
    dependencies.log(
      `  Browser origins: ${origins.action}; ${manifest.origins?.length ?? 0} configured locally.`,
    );
    if (manifest.origins) {
      for (const origin of manifest.origins) {
        dependencies.log(`    ${origin}`);
      }
    }
    if (origins.action === 'unmanaged') {
      dependencies.log(
        '  CANNOT VERIFY browser origins: legacy configuration is preserved. Use supagame config origins add <origin> to manage it.',
      );
    }
    if (origins.action === 'blocked' || origins.action === 'replace') {
      dependencies.log(
        '  ACTION REQUIRED: existing SG_ALLOWED_ORIGINS cannot be safely merged. Add ALL intended existing origins locally, then use --replace-origins with deployment authorization to replace the unreadable value.',
      );
    }
    if (manifest.modules['live-leaderboards']) {
      for (const issue of realtimeIssues) {
        dependencies.log(`  ACTION REQUIRED: Realtime prerequisites: ${issue}`);
      }
      if (!realtimeIssues.length) {
        dependencies.log(
          '  Realtime database Broadcast, RLS and receive grants: verified.',
        );
      }
      if (realtime) {
        dependencies.log(
          `  ${realtime.status.toUpperCase()}: ${realtime.message}`,
        );
      }
      dependencies.log(
        `  Realtime configuration API: ${
          configuration.realtimeConfig ? 'readable' : 'CANNOT VERIFY'
        }. Global settings will be preserved; private channels are requested by the SDK and triggers.`,
      );
      dependencies.log(
        '  Private-channel policies/triggers: versioned module assets staged; run doctor --remote after deployment to verify database objects. CANNOT VERIFY WebSocket delivery from configuration alone.',
      );
    }
    dependencies.log(
      'Pending database migrations (all project migrations; not just the SDK):',
    );
    for (const name of plan.pending) {
      dependencies.log(
        `  ${files.owned.has(name) ? 'SDK' : 'UNRELATED'} ${name} sha256=${
          digest(files.sql.find((f) => f.name === name)!.content)
        }`,
      );
    }
    if (!plan.pending.length) dependencies.log('  None.');
    dependencies.log(
      `Function supagame: ${
        unchanged
          ? 'unchanged (verified receipt)'
          : plan.fn
          ? 'redeploy (remote content differs or cannot be proven identical)'
          : 'create'
      }; local sha256=${files.functionHash}.`,
    );
    dependencies.log(
      'Only the supagame function is selected. Seeds, custom roles, Vault synchronization and unrelated config/secrets are excluded. Hosted configuration uses a separate one-property Auth plan and only SG_ALLOWED_ORIGINS. SQL migrations themselves can have arbitrary effects; review their contents.',
    );
    if (options.dryRun) {
      dependencies.log('Dry run complete; no hosted mutations authorized.');
      return;
    }
    if (realtimeIssues.length || realtime?.status === 'action required') {
      throw new Error(
        'Resolve Realtime prerequisites/service availability before deployment. No hosted mutations were made.',
      );
    }
    if (origins.action === 'blocked') {
      throw new Error(
        'Existing browser origins require review. Add all intended origins and rerun with --replace-origins; no hosted mutations were made.',
      );
    }
    if (!plan.pending.length && unchanged && !configurationWrite) {
      if (manifest.origins && origins.action === 'unchanged') {
        writeOriginReceipt(root, ref, manifest.origins);
      }
      dependencies.log('Deployment complete: no pending changes.');
      return;
    }
    if (options.allowRemote) {
      dependencies.log(
        'Explicit noninteractive authorization: --allow-remote (no prompt).',
      );
    } else {
      let answer: string;
      try {
        answer = await dependencies.confirm(ref);
      } catch {
        throw new Error('Deployment cancelled; no hosted mutations were made.');
      }
      if (answer !== `deploy ${ref}`) {
        throw new Error('Deployment declined; no hosted mutations were made.');
      }
    }
    // Recheck both sides after consent, before passing any noninteractive yes flag.
    if (
      deploymentFiles(root, ref).fingerprint !== files.fingerprint ||
      JSON.stringify(await cli.inspect(files.sql)) !== JSON.stringify(plan) ||
      JSON.stringify(await hosted.inspect()) !==
        JSON.stringify(configuration) ||
      JSON.stringify(readOriginReceipt(root, ref)) !==
        JSON.stringify(originReceipt) ||
      (manifest.modules['live-leaderboards'] &&
        (JSON.stringify(await hosted.realtimePrerequisites()) !==
            JSON.stringify(realtimeIssues) ||
          JSON.stringify(await inspectRealtime(ref)) !==
            JSON.stringify(realtime)))
    ) {
      throw new Error(
        'Deployment inputs or remote state changed during confirmation. Rerun to preview and authorize the new plan.',
      );
    }
    try {
      if (!configuration.anonymous) {
        await hosted.enableAnonymous();
        dependencies.log('Anonymous authentication enabled and verified.');
      }
      if (originWrite) await hosted.setOrigins(manifest.origins!, configuration.originDigest);
      if (manifest.origins) {
        writeOriginReceipt(root, ref, manifest.origins);
        dependencies.log(
          'Browser origin digest verified; management receipt saved.',
        );
      }
    } catch {
      throw new Error(
        'Hosted configuration failed or is uncertain. Earlier settings may have changed; database/function deployment has not started in this attempt. Rerun --dry-run to inspect current state, then authorize only remaining changes. Raw errors are withheld.',
      );
    }
    const state: DeploymentState = {
      formatVersion: 1,
      projectRef: ref,
      phase: 'database_complete',
      attempted: plan.pending.map((name) => ({
        name,
        hash: digest(files.sql.find((f) => f.name === name)!.content),
      })),
      functionHash: files.functionHash,
      remoteFunction: plan.fn,
    };
    if (plan.pending.length) {
      state.phase = 'database_started';
      writeState(root, state);
      try {
        await cli.push();
        const after = await cli.inspect(files.sql);
        if (after.pending.length) {
          throw new Error(
            'Database migration ledger still has pending changes.',
          );
        }
        if (JSON.stringify(after.fn) !== JSON.stringify(plan.fn)) {
          throw new Error('Remote function changed while applying migrations.');
        }
      } catch {
        try {
          const after = await cli.inspect(files.sql);
          dependencies.log(
            `Database reconciliation: applied ${
              state.attempted.filter((f) => after.applied.includes(f.name.slice(0, 14))).map((f) =>
                f.name
              ).join(', ') || 'none'
            }; remaining ${after.pending.join(', ') || 'none'}.`,
          );
        } catch {
          dependencies.log(
            'Database reconciliation unavailable; remote progress is uncertain.',
          );
        }
        throw new Error(
          'Database deployment failed or is uncertain. Functions were not deployed. Inspect remote progress and the local deployment journal; no automatic retry was attempted.',
        );
      }
      state.phase = 'database_complete';
      writeState(root, state);
      dependencies.log('Database migrations applied and verified.');
    }
    if (!unchanged) {
      state.phase = 'function_started';
      writeState(root, state);
      let stage = 'function deployment';
      try {
        await cli.deployFunction();
        stage = 'post-deployment function inspection';
        state.remoteFunction = await cli.functionInfo();
        if (
          !state.remoteFunction || state.remoteFunction.status !== 'ACTIVE' ||
          state.remoteFunction.verifyJwt !== false
        ) {
          throw new DeploymentDiagnostic(
            'Function status/authentication settings could not be verified: expected ACTIVE and verify_jwt=false.',
          );
        }
      } catch (error) {
        dependencies.log(
          'Database migrations are complete. Function outcome requires inspection; the next invocation will inspect remote state and require fresh authorization.',
        );
        // Raw causes can contain credentials; only the sanitized diagnostic is rendered.
        // eslint-disable-next-line preserve-caught-error
        throw new Error(
          `Function deployment failed or is uncertain. No automatic retry was attempted. Stage: ${stage}. ${error instanceof DeploymentDiagnostic ? error.message : 'Unexpected internal failure; raw error is withheld.'} Journal retained at function_started. Inspect with doctor --remote and deploy --dry-run before authorizing another attempt.`,
        );
      }
      dependencies.log('Function supagame deployed and verified.');
    }
    state.phase = 'complete';
    writeState(root, state);
    dependencies.log(
      configuration.authBlockers.length
        ? 'Deployment complete; new anonymous-player sign-in still requires the Auth actions shown above.'
        : 'Deployment complete.',
    );
  } finally {
    hosted?.remove();
    isolated?.remove();
    try { diagnostic?.close(); } finally { release(); }
  }
}
