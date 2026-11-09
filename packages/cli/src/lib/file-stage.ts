import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export interface DesiredFile {
  path: string;
  content: Buffer;
  replace?: Buffer;
}
export interface PlannedFile extends DesiredFile {
  status: 'create' | 'update' | 'unchanged' | 'conflict';
  before: Buffer | null;
  mode: number;
}
const stage = '.supagame-stage';
function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
export function projectRoot(directory: string): string {
  const root = resolve(directory);
  if (realpathSync(root) !== root) {
    throw new Error(
      'Project path must not contain symlinks. Select the real project directory with --workdir.',
    );
  }
  if (!lstatSync(root).isDirectory()) {
    throw new Error('Project path must be a directory.');
  }
  return root;
}
export function safePath(root: string, relative: string): string {
  if (
    lstatSync(root).isSymbolicLink() || realpathSync(root) !== resolve(root)
  ) throw new Error('Unsafe symlink in project root path.');
  if (
    !relative || isAbsolute(relative) ||
    (/[\\:]/.test(relative) || relative.includes('\u0000')) ||
    relative.split('/').some((p) => !p || p === '.' || p === '..')
  ) {
    throw new Error(`Unsafe relative path: ${JSON.stringify(relative)}`);
  }
  let current = root;
  const parts = relative.split('/');
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) {
        throw new Error(
          `Unsafe symlink at ${relative}. Remove the link or select another project.`,
        );
      }
      if (index < parts.length - 1 && !stat.isDirectory()) {
        throw new Error(`Path parent is not a directory: ${relative}`);
      }
      if (stat.isFile() && stat.nlink !== 1) {
        throw new Error(
          `Unsafe hard-linked file at ${relative}. Use an independent regular file.`,
        );
      }
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) throw error;
    }
  }
  return current;
}
export function readProjectFile(root: string, path: string): Buffer | null {
  const target = safePath(root, path);
  let fd: number;
  try {
    fd = openSync(
      target,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return null;
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new Error(`Expected an independent regular file: ${path}`);
    }
    if (stat.size > 16 * 1024 * 1024) {
      throw new Error(`File is too large to stage safely: ${path}`);
    }
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function planFiles(
  root: string,
  desired: readonly DesiredFile[],
): PlannedFile[] {
  const seen = new Set<string>();
  return desired.map((file) => {
    if (seen.has(file.path)) {
      throw new Error(`Duplicate staging path: ${file.path}`);
    }
    seen.add(file.path);
    const before = readProjectFile(root, file.path);
    const stat = before === null ? null : lstatSync(safePath(root, file.path));
    return {
      ...file,
      before,
      mode: stat ? stat.mode & 0o777 : 0o644,
      status: before === null
        ? 'create'
        : before.equals(file.content)
        ? 'unchanged'
        : file.replace?.equals(before)
        ? 'update'
        : 'conflict',
    };
  });
}
function equal(a: Buffer | null, b: Buffer | null): boolean {
  return a === null ? b === null : b !== null && a.equals(b);
}
function writeDurable(path: string, content: Buffer, mode = 0o600): void {
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
      constants.O_NOFOLLOW,
    mode,
  );
  try {
    fchmodSync(fd, mode);
    writeFileSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function cleanStage(root: string): void {
  const path = safePath(root, stage);
  const names = readdirSync(path);
  for (const name of names) {
    if (name !== 'owner.json' && !/^\d+\.(tmp|bak)$/.test(name)) {
      throw new Error(
        'Unrecognized staging files. Inspect .supagame-stage before retrying.',
      );
    }
    if (!lstatSync(join(path, name)).isFile()) {
      throw new Error(
        'Unsafe staging contents. Inspect .supagame-stage before retrying.',
      );
    }
  }
  for (const name of names) unlinkSync(join(path, name));
  rmdirSync(path);
}
function requireStaleStage(root: string): void {
  let owner: unknown;
  try {
    owner = JSON.parse(readProjectFile(root, `${stage}/owner.json`)?.toString() ?? 'null');
  } catch {
    throw new Error(
      'Incomplete staging lock. Ensure no installer is running, inspect and remove .supagame-stage, then rerun.',
    );
  }
  if (
    !owner || typeof owner !== 'object' || !('pid' in owner) || !Number.isSafeInteger(owner.pid) ||
    Number(owner.pid) <= 0 || !('host' in owner) || owner.host !== hostname()
  ) {
    throw new Error(
      'Unrecognized staging lock. Ensure no installer is running, inspect and remove .supagame-stage, then rerun.',
    );
  }
  let alive = true;
  try {
    process.kill(Number(owner.pid), 0);
  } catch (error) {
    if (hasCode(error, 'ESRCH')) alive = false;
  }
  if (alive) {
    throw new Error(
      'Another staging operation may be running. Wait for it to finish; do not remove its .supagame-stage lock.',
    );
  }
}
function acquire(root: string): void {
  const path = safePath(root, stage);
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if (!hasCode(error, 'EEXIST')) throw error;
    requireStaleStage(root);
    // Resume forwards: compare completed files with templates; never restore
    // destinations from an untrusted journal. Remove only stale private staging files.
    cleanStage(root);
    mkdirSync(path, { mode: 0o700 });
  }
  writeDurable(
    join(path, 'owner.json'),
    Buffer.from(JSON.stringify({ pid: process.pid, host: hostname() })),
  );
}
export function applyPlan(
  root: string,
  plan: readonly PlannedFile[],
  hooks: { afterWrite?: (path: string) => void } = {},
): void {
  if (plan.some((file) => file.status === 'conflict')) {
    throw new Error(
      'Resolve the listed file conflicts before installing. No files changed.',
    );
  }
  // Even unchanged inputs participate in optimistic concurrency checks.
  function revalidate() {
    for (const file of plan) {
      if (!equal(readProjectFile(root, file.path), file.before)) {
        throw new Error(
          `File changed after preview: ${file.path}. Rerun to inspect the new plan.`,
        );
      }
    }
  }
  revalidate();
  if (
    plan.every((file) => file.status === 'unchanged') &&
    !existsSync(safePath(root, stage))
  ) return;
  acquire(root);
  const written: PlannedFile[] = [];
  const directories: string[] = [];
  const backups = new Map<string, string>();
  let sequence = 0;
  try {
    revalidate();
    for (const file of plan) {
      if (file.status === 'unchanged') continue;
      const parents = file.path.split('/').slice(0, -1);
      for (let i = 1; i <= parents.length; i++) {
        const relative = parents.slice(0, i).join('/');
        const directory = safePath(root, relative);
        try {
          mkdirSync(directory);
          directories.push(relative);
        } catch (error) {
          if (!hasCode(error, 'EEXIST')) throw error;
          if (!lstatSync(directory).isDirectory()) {
            throw new Error(`Path is not a directory: ${relative}`, {
              cause: error,
            });
          }
        }
      }
      if (!equal(readProjectFile(root, file.path), file.before)) {
        throw new Error(`File changed during staging: ${file.path}`);
      }
      const temporary = safePath(root, `${stage}/${sequence++}.tmp`);
      writeDurable(temporary, file.content, file.mode);
      const target = safePath(root, file.path);
      if (file.before === null) {
        linkSync(temporary, target);
        written.push(file);
        unlinkSync(temporary);
      } else {
        const backup = safePath(root, `${stage}/${sequence++}.bak`);
        linkSync(target, backup);
        backups.set(file.path, backup);
        renameSync(temporary, target);
        written.push(file);
      }
      hooks.afterWrite?.(file.path);
    }
  } catch (error) {
    const unrestored: string[] = [];
    for (const file of written.reverse()) {
      try {
        if (!equal(readProjectFile(root, file.path), file.content)) {
          throw new Error('Concurrent edit', { cause: error });
        }
        const target = safePath(root, file.path);
        if (file.before === null) unlinkSync(target);
        else {
          // Restore the original inode, including nanosecond timestamps and mode.
          renameSync(backups.get(file.path)!, target);
        }
      } catch {
        unrestored.push(file.path);
      }
    }
    for (const directory of directories.reverse()) {
      try {
        rmdirSync(safePath(root, directory));
      } catch { /* Preserve non-empty/user-modified directories. */ }
    }
    if (unrestored.length) {
      throw new Error(
        `Staging failed; concurrent changes were preserved at ${
          unrestored.join(', ')
        }. Inspect these files and rerun.`,
        { cause: error },
      );
    }
    throw error;
  } finally {
    cleanStage(root);
  }
}
export function reportPlan(
  plan: readonly PlannedFile[],
  dryRun: boolean,
): void {
  console.log(dryRun ? 'Dry run: local preview only.' : 'Local staging plan:');
  for (const file of plan) console.log(`${file.status} ${file.path}`);
  if (plan.some((file) => file.status === 'conflict')) {
    throw new Error(
      'Resolve the listed file conflicts; existing files will not be overwritten. No files changed.',
    );
  }
}
export function executePlan(
  root: string,
  plan: readonly PlannedFile[],
  dryRun: boolean,
): void {
  reportPlan(plan, dryRun);
  if (existsSync(safePath(root, stage))) {
    try {
      requireStaleStage(root);
    } catch (error) {
      console.log('conflict .supagame-stage');
      throw error;
    }
    console.log(
      dryRun
        ? 'unchanged .supagame-stage (interrupted operation; real execution will recover)'
        : 'Recovering interrupted local staging.',
    );
  }
  if (!dryRun) applyPlan(root, plan);
}
