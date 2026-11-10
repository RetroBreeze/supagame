import { parseEnv } from 'node:util';
import { readProjectFile } from './file-stage.ts';
import type { DesiredFile } from './file-stage.ts';
import { mergeOrigins } from './origins.ts';
/** Edit only our public local runtime values; never log/reformat unrelated env. */
export function localOrigins(
  root: string,
  desired: string[],
  port = 54321,
): { origins: string[]; files: DesiredFile[] } {
  const path = 'supabase/functions/.env';
  const before = readProjectFile(root, path);
  let text = before?.toString('utf8') ?? '';
  const env = parseEnv(text);
  const invalid = () =>
    new Error(
      'Cannot safely merge local SG_ALLOWED_ORIGINS. Use a single-line JSON array of exact origins in supabase/functions/.env, then retry. Existing files were preserved.',
    );
  let existing: string[] = [];
  if (env.SG_ALLOWED_ORIGINS !== undefined) {
    try {
      const value: unknown = JSON.parse(env.SG_ALLOWED_ORIGINS);
      if (!Array.isArray(value) || !value.every((o) => typeof o === 'string')) {
        throw invalid();
      }
      existing = mergeOrigins([], value);
    } catch {
      throw invalid();
    }
  } else if (/^\s*(?:export\s+)?SG_ALLOWED_ORIGINS\b/m.test(text)) {
    throw invalid();
  }
  const origins = mergeOrigins(existing, desired);
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const append = (line: string) => {
    text += (text && !text.endsWith('\n') ? newline : '') + line + newline;
  };
  if (
    JSON.stringify(existing) !== JSON.stringify(origins) ||
    env.SG_ALLOWED_ORIGINS === undefined
  ) {
    const line = `SG_ALLOWED_ORIGINS='${JSON.stringify(origins)}'`;
    if (env.SG_ALLOWED_ORIGINS !== undefined) {
      const matches = [
        ...text.matchAll(
          /^[ \t]*(?:export[ \t]+)?SG_ALLOWED_ORIGINS[ \t]*=[^\r\n]*/gm,
        ),
      ];
      if (
        matches.length !== 1 ||
        parseEnv(matches[0]![0]).SG_ALLOWED_ORIGINS !== env.SG_ALLOWED_ORIGINS
      ) throw invalid();
      text = text.slice(0, matches[0]!.index) + line +
        text.slice(matches[0]!.index + matches[0]![0].length);
    } else append(line);
  }
  if (env.SG_AUTH_ISSUER === undefined) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(
        'Invalid local api.port; cannot prepare the local Auth issuer.',
      );
    }
    append(`SG_AUTH_ISSUER=http://127.0.0.1:${port}/auth/v1`);
  }
  return {
    origins,
    files: [
      {
        path,
        content: Buffer.from(text),
        ...(before ? { replace: before } : {}),
      },
      installationIgnore(root),
    ],
  };
}

export function installationIgnore(root: string): DesiredFile {
  const before = readProjectFile(root, '.gitignore');
  let text = before?.toString('utf8') ?? '';
  for (
    const entry of [
      '/supabase/functions/.env',
      '/supabase/.temp/',
      '/supabase/.branches/',
      '/.supagame-deploy-lock/',
      '/.supagame-stage/',
    ]
  ) {
    if (!text.split(/\r?\n/).includes(entry)) {
      text += (text && !text.endsWith('\n') ? '\n' : '') + entry + '\n';
    }
  }
  return {
    path: '.gitignore',
    content: Buffer.from(text),
    ...(before ? { replace: before } : {}),
  };
}
