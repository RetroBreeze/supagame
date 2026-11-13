import { closeSync, fchmodSync, fsyncSync, openSync, writeSync } from 'node:fs';
import { DeploymentDiagnostic } from './deployment-diagnostic.ts';
import type { ProcessRunner } from './supabase-cli.ts';

// Exclusive creation rejects existing files and symlinks. Keep the descriptor
// open: never reopen a user path after subprocess execution.
export function rawDeploymentLog(path: string, run: ProcessRunner) {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'wx', 0o600);
    fchmodSync(fd, 0o600);
  } catch {
    if (fd !== undefined) closeSync(fd);
    throw new Error('Cannot create private diagnostic log. Choose a new file in an existing writable local directory.');
  }
  const descriptor = fd;
  const append = (record: object) => {
    try {
      const bytes = Buffer.from(JSON.stringify(record) + '\n');
      let offset = 0;
      while (offset < bytes.length) offset += writeSync(descriptor, bytes, offset);
      fsyncSync(descriptor);
    } catch {
      throw new DeploymentDiagnostic('Diagnostic log write failed. Subprocess outcome may be uncertain; inspect the deployment journal before retrying.');
    }
  };
  const wrapped: ProcessRunner = async (args, cwd) => {
    append({ event: 'start', at: new Date().toISOString(), args, cwd });
    const result = await run(args, cwd);
    append({ event: 'result', at: new Date().toISOString(), ...result });
    return result;
  };
  return { run: wrapped, close: () => closeSync(descriptor) };
}
