import { execFile } from 'node:child_process';
import { object } from './manifest.ts';
import type { MigrationFile } from './migration-generator.ts';

export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}
export type ProcessRunner = (
  args: readonly string[],
  cwd: string,
) => Promise<ProcessResult>;

// Supabase reloads dotenv/config overrides itself: use only an isolated workdir.
// No environment variable is accepted as deployment consent or target selection.
export function processEnvironment(
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (
    const key of [
      'PATH',
      'HOME',
      'USERPROFILE',
      'SystemRoot',
      'TEMP',
      'TMP',
      'TMPDIR',
      'XDG_CONFIG_HOME',
      'SUPABASE_ACCESS_TOKEN',
      'SUPABASE_DB_PASSWORD',
    ]
  ) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  env.SUPABASE_YES = 'false';
  return env;
}
export const runSupabase: ProcessRunner = (args, cwd) =>
  new Promise((resolve) => {
    const child = execFile('supabase', [...args], {
      cwd,
      env: processEnvironment(process.env),
      encoding: 'utf8',
      timeout: 300_000,
      maxBuffer: 8 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      resolve({
        code: error ? (typeof error.code === 'number' ? error.code : null) : 0,
        stdout,
        stderr,
      });
    });
    child.stdin?.end();
  });
export interface RemoteFunction {
  version: number;
  status: string;
  verifyJwt: boolean | null;
  hash: string | null;
}
export interface RemotePlan {
  pending: string[];
  applied: string[];
  fn: RemoteFunction | null;
}
export class SupabaseCli {
  private readonly run: ProcessRunner;
  private readonly cwd: string;
  private readonly ref: string;
  constructor(run: ProcessRunner, cwd: string, ref: string) {
    this.run = run;
    this.cwd = cwd;
    this.ref = ref;
  }
  async checkVersion(): Promise<void> {
    const result = await this.call(['--version']);
    if (result.stdout.trim() !== '3.0.0') {
      throw new Error(
        'This CLI adapter requires Supabase CLI 3.0.0. Install the tested version before deploying.',
      );
    }
  }
  private async call(args: string[]): Promise<ProcessResult> {
    let result: ProcessResult;
    try {
      result = await this.run(args, this.cwd);
    } catch {
      throw new Error(
        'Supabase CLI could not complete the operation. Inspect CLI availability, authentication and network access; raw output is withheld.',
      );
    }
    if (result.code !== 0) {
      throw new Error(
        'Supabase CLI failed or was interrupted. Inspect CLI availability, authentication and network access; raw output is withheld.',
      );
    }
    return result;
  }
  private async json(args: string[]): Promise<Record<string, unknown>> {
    const result = await this.call([
      ...args,
      `--remote=${this.ref}`,
      '--workdir',
      this.cwd,
      '--output-format',
      'json',
    ]);
    let value: unknown;
    try {
      value = JSON.parse(result.stdout);
    } catch {
      throw new Error(
        'Cannot determine deployment changes: Supabase CLI returned invalid JSON.',
      );
    }
    if (
      !object(value) || !object(value.target) ||
      value.target.kind !== 'linked' || value.target.project_ref !== this.ref
    ) {
      throw new Error(
        'Cannot verify Supabase CLI remote target; refusing deployment.',
      );
    }
    return value;
  }
  async inspect(files: MigrationFile[]): Promise<RemotePlan> {
    const history = await this.json(['migration', 'list']);
    if (!Array.isArray(history.migrations)) {
      throw new Error('Cannot determine remote migration history.');
    }
    const local = new Set(files.map((f) => f.version)),
      seen = new Set<string>(),
      applied: string[] = [];
    for (const row of history.migrations) {
      if (
        !object(row) || typeof row.local !== 'string' ||
        typeof row.remote !== 'string' || !row.local || !local.has(row.local) ||
        seen.has(row.local) || (row.remote !== '' && row.remote !== row.local)
      ) {
        throw new Error(
          'Remote migration history differs from local files. Restore missing migrations or reconcile history before deploying.',
        );
      }
      seen.add(row.local);
      if (row.remote) applied.push(row.remote);
    }
    if (seen.size !== local.size) {
      throw new Error('Supabase CLI did not inventory every local migration.');
    }
    const preview = await this.json([
      'db',
      'push',
      '--dry-run',
      '--include-all',
      '--skip-vault',
    ]);
    const pending = files.filter((f) => !applied.includes(f.version)).map((f) => f.name);
    if (
      preview.dryRun !== true || !Array.isArray(preview.migrations) ||
      JSON.stringify(preview.migrations) !== JSON.stringify(pending) ||
      !Array.isArray(preview.roles) || preview.roles.length ||
      !Array.isArray(preview.seeds) || preview.seeds.length
    ) {
      throw new Error(
        'Cannot determine exact pending migrations: CLI preview disagrees with migration history or includes unreviewed seeds/roles.',
      );
    }
    return { pending, applied: applied.sort(), fn: await this.functionInfo() };
  }
  async functionInfo(): Promise<RemoteFunction | null> {
    const value = await this.json(['functions', 'list']);
    if (
      !Array.isArray(value.functions) ||
      value.functions.some((f) => !object(f) || typeof f.slug !== 'string')
    ) throw new Error('Cannot inspect deployed functions.');
    const matches = value.functions.filter((f) => f.slug === 'supagame') as Record<
      string,
      unknown
    >[];
    if (matches.length > 1) {
      throw new Error('Ambiguous remote supagame function.');
    }
    const fn = matches[0];
    if (!fn) return null;
    if (
      !Number.isSafeInteger(fn.version) || Number(fn.version) < 1 ||
      typeof fn.status !== 'string' ||
      (fn.verify_jwt !== undefined && typeof fn.verify_jwt !== 'boolean') ||
      (fn.ezbr_sha256 !== undefined &&
        (typeof fn.ezbr_sha256 !== 'string' ||
          !/^[a-f0-9]{64}$/.test(fn.ezbr_sha256)))
    ) {
      throw new Error(
        'Cannot determine remote function version/configuration.',
      );
    }
    return {
      version: Number(fn.version),
      status: fn.status,
      verifyJwt: typeof fn.verify_jwt === 'boolean' ? fn.verify_jwt : null,
      hash: typeof fn.ezbr_sha256 === 'string' ? fn.ezbr_sha256 : null,
    };
  }
  async push(): Promise<void> {
    await this.json(['db', 'push', '--include-all', '--skip-vault', '--yes']);
  }
  async deployFunction(): Promise<void> {
    const result = await this.json([
      'functions',
      'deploy',
      'supagame',
      '--yes',
    ]);
    if (
      result.project_ref !== this.ref || !Array.isArray(result.functions) ||
      result.functions.length !== 1 || result.functions[0] !== 'supagame'
    ) throw new Error('Cannot verify the function deployment response.');
  }
}
