import { realtimePrerequisites } from './realtime-prerequisites.ts';
import { securityQuery } from './doctor-security.ts';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest } from './deployment-files.ts';
import { DoctorInspector } from './doctor-inspect.ts';
import { object } from './manifest.ts';
import { mergeOrigins } from './origins.ts';
import type { ProcessRunner } from './supabase-cli.ts';

export interface OriginReceipt {
  origins: string[];
  digest: string;
}
export interface HostedSnapshot {
  anonymous: boolean;
  authBlockers: string[];
  originDigest: string | null;
  realtimeConfig: boolean;
  projectName: string | null;
}
export function planOrigins(
  origins: string[] | undefined,
  remote: string | null,
  receipt: OriginReceipt | null,
  replace: boolean,
) {
  if (!origins) return { action: 'unmanaged' as const };
  const expected = digest(JSON.stringify(origins));
  if (remote === expected) return { action: 'unchanged' as const };
  if (remote === null) return { action: 'create' as const };
  if (
    receipt && receipt.digest === remote &&
    digest(JSON.stringify(receipt.origins)) === remote &&
    receipt.origins.every((o) => origins.includes(o))
  ) return { action: 'update' as const };
  return { action: replace ? 'replace' as const : 'blocked' as const };
}
/** Uses the supported CLI Management API transport, including saved CLI login.
 * NEVER load or push the developer's TOML, dotenv, remote overlays or secrets. */
export class HostedConfiguration {
  readonly directory: string;
  private inspector: DoctorInspector;
  constructor(run: ProcessRunner, ref: string) {
    this.directory = mkdtempSync(join(tmpdir(), 'supagame-config-'));
    try {
      mkdirSync(join(this.directory, 'supabase'));
      writeFileSync(
        join(this.directory, 'supabase/config.toml'),
        'project_id = "supagame-hosted-configuration"\n[auth]\nenable_anonymous_sign_ins = true\n',
        { mode: 0o600 },
      );
    } catch (error) {
      this.remove();
      throw error;
    }
    this.inspector = new DoctorInspector(run, this.directory, {
      ref,
      projectId: 'supagame-hosted-configuration',
      port: 54322,
    });
  }
  remove(): void {
    rmSync(this.directory, { recursive: true, force: true });
  }
  async auth() {
    const data = await this.inspector.json(['config', 'diff']);
    const invalid = () =>
      new Error(
        'Cannot verify the narrowly scoped hosted Auth configuration. Check CLI 3.0.0 or 3.1.0 and config read permissions; no full config push is permitted.',
      );
    if (
      !object(data) || data.schema_version !== 1 || !object(data.scope) ||
      !Array.isArray(data.scope.present) ||
      !data.scope.present.includes('auth') || !Array.isArray(data.changes) ||
      !Array.isArray(data.masked) || !Array.isArray(data.unmanaged)
    ) throw invalid();
    const path = ['auth', 'enable_anonymous_sign_ins'];
    const isAuth = (v: unknown) => JSON.stringify(v) === JSON.stringify(path);
    if (
      [...data.masked, ...data.unmanaged].some((v) => isAuth(v) || (object(v) && isAuth(v.path)))
    ) throw invalid();
    if (
      Array.isArray(data.scope.missing) && data.scope.missing.includes('auth')
    ) throw invalid();
    if (
      data.changes.some((c) =>
        !object(c) || !Array.isArray(c.path) || !c.path.every((p) => typeof p === 'string') ||
        (c.class === 'remote_only' && (c.declared !== false || isAuth(c.path)))
      )
    ) throw invalid();
    const changes = data.changes.filter((c) => !object(c) || c.class !== 'remote_only');
    if (
      changes.length > 1 ||
      changes.some((c) =>
        !object(c) || !isAuth(c.path) || c.class !== 'update' ||
        c.declared !== true || c.local !== true || c.remote !== false
      )
    ) throw invalid();
    const authBlockers: string[] = [];
    for (const c of data.changes) {
      if (!object(c)) continue;
      if (
        JSON.stringify(c.path) === JSON.stringify(['auth', 'enable_signup']) &&
        c.remote === false
      ) {
        authBlockers.push(
          'Hosted Auth signup is disabled. Review this project policy before creating anonymous players; existing sessions can still be reused. Supagame will not enable general signup.',
        );
      }
      if (
        JSON.stringify(c.path) ===
          JSON.stringify(['auth', 'captcha', 'enabled']) && c.remote === true
      ) {
        authBlockers.push(
          'Hosted Auth requires CAPTCHA. Provide a CAPTCHA-aware sign-in flow using the Supabase client before calling the SDK; Supagame will not disable CAPTCHA.',
        );
      }
    }
    // Absence is equality ONLY with a complete auth response and a declared local true.
    return {
      anonymous: changes.length === 0,
      authBlockers,
      realtimeConfig: data.scope.present.includes('realtime'),
    };
  }
  async secret() {
    const data = await this.inspector.json(['secrets', 'list']);
    if (
      !object(data) || !Array.isArray(data.secrets) ||
      data.secrets.some((s) => !object(s) || typeof s.name !== 'string')
    ) {
      throw new Error(
        'Cannot verify hosted secret inventory. Check secrets read permission.',
      );
    }
    const matches = data.secrets.filter((s) => s.name === 'SG_ALLOWED_ORIGINS');
    if (
      matches.length > 1 ||
      matches.some((s) => typeof s.value !== 'string' || !/^[a-fA-F0-9]{64}$/.test(s.value))
    ) {
      throw new Error(
        'Cannot verify SG_ALLOWED_ORIGINS digest. Existing hosted configuration was preserved.',
      );
    }
    return {
      originDigest: matches.length ? String(matches[0]!.value).toLowerCase() : null,
      projectName: object(data.target) && typeof data.target.project_name === 'string'
        ? data.target.project_name
        : null,
    };
  }
  async realtimePrerequisites(): Promise<string[]> {
    const checks = realtimePrerequisites();
    const rows = await this.inspector.query(securityQuery(checks));
    if (
      !Array.isArray(rows) || rows.length !== checks.length ||
      new Set(rows.map((r) => object(r) ? r.check : null)).size !==
        checks.length ||
      checks.some((c) =>
        !rows.some((r) => object(r) && r.check === c.id && typeof r.ok === 'boolean')
      )
    ) {
      throw new Error(
        'Cannot verify Realtime prerequisites; check database read permissions.',
      );
    }
    return checks.filter((c) => rows.some((r) => r.check === c.id && !r.ok))
      .map((c) => c.remedy);
  }
  async inspect(): Promise<HostedSnapshot> {
    return { ...await this.auth(), ...await this.secret() };
  }
  async enableAnonymous(): Promise<void> {
    // Rebuild the allowlisted plan immediately before the scoped write.
    if ((await this.auth()).anonymous) return;
    await this.inspector.json(['config', 'push', '--yes']);
    if (!(await this.auth()).anonymous) {
      throw new Error(
        'Anonymous Auth update could not be verified. Inspect and retry with a fresh preview.',
      );
    }
  }
  async setOrigins(origins: string[], expectedDigest: string | null): Promise<void> {
    const value = JSON.stringify(mergeOrigins([], origins));
    const current = (await this.secret()).originDigest;
    if (current === digest(value)) return;
    if (current !== expectedDigest) throw new Error('Hosted browser origins changed after preview; inspect and authorize a fresh plan.');
    const path = join(this.directory, 'origins.env');
    writeFileSync(path, `SG_ALLOWED_ORIGINS='${value}'\n`, { mode: 0o600 });
    await this.inspector.json(['secrets', 'set', '--env-file', path, '--yes']);
    if ((await this.secret()).originDigest !== digest(value)) {
      throw new Error(
        'Browser origin update could not be verified. Inspect and retry with a fresh preview.',
      );
    }
  }
}
