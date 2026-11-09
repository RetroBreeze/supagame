import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { object } from './manifest.ts';
import type { ProcessRunner } from './supabase-cli.ts';
import type { MigrationFile } from './migration-generator.ts';

export interface InspectionTarget {
  ref?: string;
  projectId: string;
  port: number;
}
// CLI read commands can cache link metadata. All such writes stay in disposable scratch.
export function inspectionWorkspace(target: InspectionTarget, files: readonly MigrationFile[]) {
  const root = mkdtempSync(join(tmpdir(), 'supagame-doctor-'));
  try {
    mkdirSync(join(root, 'supabase/migrations'), { recursive: true });
    writeFileSync(
      join(root, 'supabase/config.toml'),
      `project_id = ${
        JSON.stringify(target.projectId)
      }\n[db]\nport = ${target.port}\n[auth]\nenable_anonymous_sign_ins = true\n`,
      { mode: 0o600 },
    );
    for (const file of files) {
      writeFileSync(join(root, 'supabase/migrations', file.name), file.content, { mode: 0o600 });
    }
    return { root, remove: () => rmSync(root, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
export class DoctorInspector {
  private run: ProcessRunner;
  private root: string;
  private target: InspectionTarget;
  constructor(run: ProcessRunner, root: string, target: InspectionTarget) {
    this.run = run;
    this.root = root;
    this.target = target;
  }
  private async call(args: string[]): Promise<string> {
    try {
      const result = await this.run(args, this.root);
      if (result.code === 0) return result.stdout;
    } catch { /* Never print child diagnostics: they can contain credentials. */ }
    throw new Error(
      'Inspection unavailable. Check Supabase CLI 3.0.0, local stack or hosted read permissions/network; raw process output is withheld.',
    );
  }
  async version(): Promise<void> {
    if ((await this.call(['--version'])).trim() !== '3.0.0') {
      throw new Error('Install the supported Supabase CLI 3.0.0 to inspect this installation.');
    }
  }
  async json(args: string[], rows = false): Promise<unknown> {
    const flags = this.target.ref ? [`--remote=${this.target.ref}`] : [];
    const stdout = await this.call([
      ...args,
      ...flags,
      '--workdir',
      this.root,
      ...(rows ? ['--agent=no', '--output', 'json'] : ['--output-format', 'json']),
    ]);
    let value: unknown;
    try {
      value = JSON.parse(stdout);
    } catch {
      throw new Error('Inspection returned unsupported JSON; no conclusions can be drawn.');
    }
    if (!rows) {
      if (
        !object(value) || !object(value.target) ||
        (this.target.ref
          ? value.target.kind !== 'linked' || value.target.project_ref !== this.target.ref
          : value.target.kind !== 'local' || value.target.port !== this.target.port ||
            !['127.0.0.1', 'localhost'].includes(String(value.target.host)))
      ) {
        throw new Error(
          'Inspection target could not be verified; check the selected project and CLI version.',
        );
      }
    }
    return value;
  }
  async query(sql: string): Promise<unknown> {
    return this.json(['db', 'query', sql, '--read-only'], true);
  }
}
