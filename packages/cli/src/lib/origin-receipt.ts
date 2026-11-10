import { applyPlan, planFiles, readProjectFile } from './file-stage.ts';
import { object } from './manifest.ts';
import { mergeOrigins } from './origins.ts';
import { digest } from './deployment-files.ts';
import type { OriginReceipt } from './hosted-config.ts';
const path = 'supabase/.temp/supagame-origins.json';
export function readOriginReceipt(
  root: string,
  ref: string,
): OriginReceipt | null {
  const bytes = readProjectFile(root, path);
  if (!bytes) return null;
  try {
    const r: unknown = JSON.parse(bytes.toString('utf8'));
    if (
      !object(r) || r.formatVersion !== 1 || r.projectRef !== ref ||
      !Array.isArray(r.origins) || !r.origins.every((o) => typeof o === 'string') ||
      JSON.stringify(mergeOrigins([], r.origins)) !==
        JSON.stringify(r.origins) ||
      r.digest !== digest(JSON.stringify(r.origins))
    ) throw new Error();
    return { origins: r.origins, digest: String(r.digest) };
  } catch {
    throw new Error(
      'Invalid browser origin receipt. Inspect hosted configuration before reconciling supabase/.temp/supagame-origins.json.',
    );
  }
}
export function writeOriginReceipt(
  root: string,
  ref: string,
  origins: string[],
): void {
  const before = readProjectFile(root, path);
  const content = Buffer.from(
    JSON.stringify(
      {
        formatVersion: 1,
        projectRef: ref,
        origins,
        digest: digest(JSON.stringify(origins)),
      },
      null,
      2,
    ) + '\n',
  );
  applyPlan(
    root,
    planFiles(root, [{
      path,
      content,
      ...(before ? { replace: before } : {}),
    }]),
  );
}
