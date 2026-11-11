import { validSaveLimits, type SaveLimits } from './cloud-saves.ts';
import { isAchievement, type AchievementDefinition } from './achievements.ts';
import { mergeOrigins } from './origins.ts';
import { readProjectFile } from './file-stage.ts';

export const MANIFEST = 'supagame.config.json';
export interface LeaderboardDefinition {
  id: string;
  kind: 'time' | 'points';
  sortDirection: 'asc' | 'desc';
  keepBest: true;
  minValue: number | null;
  maxValue: number | null;
}
export interface Manifest {
  formatVersion: 1;
  projectRef: string;
  modules: Partial<Record<'core' | 'leaderboards' | 'live-leaderboards' | 'achievements' | 'cloud-saves' | 'admin', string>>;
  leaderboards: LeaderboardDefinition[];
  origins?: string[];
  cloudSaves?: SaveLimits;
  achievements?: AchievementDefinition[];
}
export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function projectRef(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9]{20}$/.test(value);
}
function keys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key));
}
export function isLeaderboard(value: unknown): value is LeaderboardDefinition {
  if (
    !object(value) ||
    !keys(value, [
      'id',
      'kind',
      'sortDirection',
      'keepBest',
      'minValue',
      'maxValue',
    ])
  ) return false;
  return typeof value.id === 'string' &&
    /^[a-z0-9][a-z0-9-]{0,63}$/.test(value.id) &&
    (value.kind === 'time' || value.kind === 'points') &&
    (value.sortDirection === 'asc' || value.sortDirection === 'desc') &&
    value.keepBest === true &&
    (value.minValue === null || Number.isSafeInteger(value.minValue)) &&
    (value.maxValue === null || Number.isSafeInteger(value.maxValue)) &&
    (value.minValue === null || value.maxValue === null ||
      Number(value.minValue) <= Number(value.maxValue));
}
export function validateManifest(value: unknown): Manifest {
  const invalid = () =>
    new Error(
      `${MANIFEST} is invalid. Expected formatVersion 1, a 20-character projectRef, versioned modules object and unique valid leaderboard definitions. Fix the configuration; its contents were not changed.`,
    );
  if (
    !object(value) ||
    !keys(value, ['formatVersion', 'projectRef', 'modules', 'leaderboards', ...(Object.hasOwn(value, 'cloudSaves') ? ['cloudSaves'] : []), ...(Object.hasOwn(value, 'achievements') ? ['achievements'] : []), ...(Object.hasOwn(value, 'origins') ? ['origins'] : [])]) ||
    value.formatVersion !== 1 || !projectRef(value.projectRef) ||
    !object(value.modules) || !Array.isArray(value.leaderboards)
  ) throw invalid();
  for (const [module, version] of Object.entries(value.modules)) {
    if (
      !['core', 'leaderboards', 'live-leaderboards', 'achievements', 'cloud-saves', 'admin'].includes(module) ||
      typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)
    ) throw invalid();
  }
  if (value.modules.admin && !value.modules.leaderboards) throw invalid();
  if (value.modules['live-leaderboards'] && !value.modules.leaderboards) throw invalid();
  if (value.modules.leaderboards && !value.modules.core) throw invalid();
  if (
    !value.leaderboards.every(isLeaderboard) ||
    new Set(value.leaderboards.map((item) => item.id)).size !==
      value.leaderboards.length
  ) throw invalid();
  if (value.leaderboards.length && !value.modules.leaderboards) throw invalid();
  if (value.modules['cloud-saves'] && !value.modules.leaderboards) throw invalid();
  if (value.modules.achievements && !value.modules.leaderboards) throw invalid();
  if (value.achievements !== undefined) {
    if (!value.modules.achievements || !Array.isArray(value.achievements) || !value.achievements.every(isAchievement) || new Set(value.achievements.map(a => a.id)).size !== value.achievements.length) throw invalid();
    for (const a of value.achievements) if (!value.leaderboards.some(b => b.id === a.condition.leaderboardId && b.sortDirection === 'desc')) throw invalid();
  }
  if (value.cloudSaves !== undefined && (!value.modules['cloud-saves'] || !validSaveLimits(value.cloudSaves))) throw invalid();
  if (value.origins !== undefined) {
    if (!Array.isArray(value.origins) || !value.origins.every(v => typeof v === 'string')) throw invalid();
    try {
      if (JSON.stringify(mergeOrigins([], value.origins)) !== JSON.stringify(value.origins)) throw invalid();
    } catch { throw invalid(); }
  }
  return value as unknown as Manifest;
}
export function readManifest(
  root: string,
): { value: Manifest; bytes: Buffer } | null {
  const bytes = readProjectFile(root, MANIFEST);
  if (bytes === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error(
      `${MANIFEST} contains invalid JSON. Fix the file and rerun; no files changed.`,
    );
  }
  return { value: validateManifest(value), bytes };
}
export function manifestBytes(value: Manifest): Buffer {
  return Buffer.from(JSON.stringify(validateManifest(value), null, 2) + '\n');
}
