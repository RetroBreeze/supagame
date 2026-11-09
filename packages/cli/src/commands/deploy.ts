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
  const release = deploymentLock(root);
  let isolated: ReturnType<typeof isolatedProject> | undefined;
  try {
    const previous = readState(root, ref);
    isolated = isolatedProject(files);
    const cli = new SupabaseCli(dependencies.run, isolated.directory, ref);
    await cli.checkVersion();
    const plan = await cli.inspect(files.sql);
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
      plan.fn?.status === 'ACTIVE' && plan.fn.verifyJwt === false && plan.fn.hash !== null &&
      JSON.stringify(previous.remoteFunction) === JSON.stringify(plan.fn);
    dependencies.log(`Destination: ${ref} (hosted Supabase project).`);
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
      'Only the supagame function is selected. Seeds, custom roles, Vault synchronization and config/secrets deployment are excluded. SQL migrations themselves can have arbitrary effects; review their contents.',
    );
    if (options.dryRun) {
      dependencies.log('Dry run complete; no hosted mutations authorized.');
      return;
    }
    if (!plan.pending.length && unchanged) {
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
      JSON.stringify(await cli.inspect(files.sql)) !== JSON.stringify(plan)
    ) {
      throw new Error(
        'Deployment inputs or remote state changed during confirmation. Rerun to preview and authorize the new plan.',
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
      try {
        await cli.deployFunction();
        state.remoteFunction = await cli.functionInfo();
        if (
          !state.remoteFunction || state.remoteFunction.status !== 'ACTIVE' ||
          state.remoteFunction.verifyJwt !== false
        ) {
          throw new Error(
            'Function status/authentication settings could not be verified.',
          );
        }
      } catch {
        dependencies.log(
          'Database migrations are complete. Function outcome requires inspection; the next invocation will inspect remote state and require fresh authorization.',
        );
        throw new Error(
          'Function deployment failed or is uncertain. No automatic retry was attempted.',
        );
      }
      dependencies.log('Function supagame deployed and verified.');
    }
    state.phase = 'complete';
    writeState(root, state);
    dependencies.log('Deployment complete.');
  } finally {
    isolated?.remove();
    release();
  }
}
