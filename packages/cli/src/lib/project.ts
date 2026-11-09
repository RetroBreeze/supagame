import { parse } from 'smol-toml';
import { projectRoot, readProjectFile } from './file-stage.ts';
import { object, projectRef } from './manifest.ts';

export interface LocalOptions {
  workdir?: string;
  dryRun?: boolean;
  projectRef?: string;
}
export function readProject(options: LocalOptions) {
  const root = projectRoot(options.workdir ?? process.cwd());
  const bytes = readProjectFile(root, 'supabase/config.toml');
  if (!bytes) {
    throw new Error(
      'No supabase/config.toml in the selected directory. Run supabase init there first, or select the project root with --workdir.',
    );
  }
  let config: Record<string, unknown>;
  try {
    config = parse(bytes.toString('utf8'), { unsafeKeyBehaviour: 'throw' });
  } catch {
    throw new Error(
      'supabase/config.toml is not valid TOML. Fix the file before staging; no settings were changed.',
    );
  }
  if (typeof config.project_id !== 'string' || !config.project_id.trim()) {
    throw new Error(
      'supabase/config.toml must define a local project_id. Run supabase init in the selected directory.',
    );
  }
  return { root, bytes, config };
}
export function selectedRef(
  root: string,
  explicit?: string,
  recorded?: string,
): string {
  const references: string[] = [];
  if (explicit !== undefined) references.push(explicit);
  if (recorded !== undefined) references.push(recorded);
  const linked = readProjectFile(root, 'supabase/.temp/project-ref');
  if (linked) references.push(linked.toString('utf8').trim());
  const cache = readProjectFile(root, 'supabase/.temp/linked-project.json');
  if (cache) {
    let value: unknown;
    try {
      value = JSON.parse(cache.toString('utf8'));
    } catch {
      throw new Error(
        'Invalid supabase/.temp/linked-project.json. Repair local Supabase link metadata before proceeding.',
      );
    }
    if (!object(value) || !projectRef(value.ref)) {
      throw new Error(
        'Missing valid ref in supabase/.temp/linked-project.json. Repair local Supabase link metadata.',
      );
    }
    references.push(value.ref);
  }
  if (!references.length) {
    throw new Error(
      'No selected Supabase project reference. Supply --project-ref <ref> to init, or link this local Supabase project first. No remote destination is inferred from project_id or environment variables.',
    );
  }
  if (references.some((ref) => !projectRef(ref))) {
    throw new Error(
      'Invalid project reference. Use the 20 lowercase letters/digits from the Supabase project settings.',
    );
  }
  if (new Set(references).size !== 1) {
    throw new Error(
      'Project reference mismatch: the explicit reference, manifest and local Supabase link metadata disagree. Reconcile the destination before continuing.',
    );
  }
  return references[0]!;
}
export function functionConfig(
  bytes: Buffer,
  config: Record<string, unknown>,
): Buffer {
  const functions = config.functions;
  if (functions !== undefined && !object(functions)) {
    throw new Error('Invalid functions table in supabase/config.toml.');
  }
  const existing = functions?.supagame;
  if (existing !== undefined) {
    if (
      !object(existing) || existing.verify_jwt !== false ||
      (existing.enabled !== undefined && existing.enabled !== true) ||
      (existing.entrypoint !== undefined &&
        existing.entrypoint !== './functions/supagame/index.ts') ||
      (existing.import_map !== undefined &&
        existing.import_map !== './functions/supagame/deno.json')
    ) {
      throw new Error(
        'Conflicting [functions.supagame] settings in supabase/config.toml. Review the function, set verify_jwt = false for its explicit route authentication, and use ./functions/supagame/index.ts and ./functions/supagame/deno.json (or default paths). Existing settings were preserved.',
      );
    }
    return bytes;
  }
  const newline = bytes.includes(Buffer.from('\r\n')) ? '\r\n' : '\n';
  const appended = bytes.toString('utf8') +
    (bytes.at(-1) === 10 ? '' : newline) + [
    '',
    '# Supabase Game Services: authentication is enforced per route in this function.',
    '[functions.supagame]',
    'enabled = true',
    'verify_jwt = false',
    'entrypoint = "./functions/supagame/index.ts"',
    'import_map = "./functions/supagame/deno.json"',
    '',
  ].join(newline);
  try {
    parse(appended, { unsafeKeyBehaviour: 'throw' });
  } catch {
    throw new Error(
      'Cannot append [functions.supagame] to this TOML layout. Add the function section explicitly using the documented settings; existing configuration was preserved.',
    );
  }
  return Buffer.from(appended);
}
