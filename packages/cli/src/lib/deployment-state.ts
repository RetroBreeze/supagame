import { applyPlan, planFiles, readProjectFile } from './file-stage.ts';
import { object } from './manifest.ts';
import type { RemoteFunction } from './supabase-cli.ts';

const path = 'supabase/.temp/supagame-deploy.json';
export interface DeploymentState {
  formatVersion: 1;
  projectRef: string;
  phase:
    | 'database_started'
    | 'database_complete'
    | 'function_started'
    | 'complete';
  attempted: { name: string; hash: string }[];
  functionHash: string;
  remoteFunction: RemoteFunction | null;
}
export function readState(root: string, ref: string): DeploymentState | null {
  const bytes = readProjectFile(root, path);
  if (!bytes) return null;
  let state: unknown;
  try {
    state = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error(
      'Invalid deployment journal. Inspect remote progress and reconcile supabase/.temp/supagame-deploy.json.',
    );
  }
  if (
    !object(state) || state.formatVersion !== 1 || state.projectRef !== ref ||
    !['database_started', 'database_complete', 'function_started', 'complete']
      .includes(String(state.phase)) ||
    !Array.isArray(state.attempted) ||
    state.attempted.some((f) =>
      !object(f) || typeof f.name !== 'string' ||
      !/^\d{14}_[a-zA-Z0-9_-]+\.sql$/.test(f.name) ||
      typeof f.hash !== 'string' || !/^[a-f0-9]{64}$/.test(f.hash)
    ) || typeof state.functionHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(state.functionHash) ||
    (state.remoteFunction !== null &&
      (!object(state.remoteFunction) ||
        !Number.isSafeInteger(state.remoteFunction.version) ||
        typeof state.remoteFunction.status !== 'string' ||
        (state.remoteFunction.verifyJwt !== null &&
          typeof state.remoteFunction.verifyJwt !== 'boolean') ||
        (state.remoteFunction.hash !== null &&
          typeof state.remoteFunction.hash !== 'string')))
  ) {
    throw new Error(
      'Invalid deployment journal or mismatched project. Inspect remote progress before reconciling supabase/.temp/supagame-deploy.json.',
    );
  }
  return state as unknown as DeploymentState;
}
export function writeState(root: string, state: DeploymentState): void {
  const before = readProjectFile(root, path);
  applyPlan(
    root,
    planFiles(root, [{
      path,
      content: Buffer.from(JSON.stringify(state, null, 2) + '\n'),
      ...(before ? { replace: before } : {}),
    }]),
  );
}
