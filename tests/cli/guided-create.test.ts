import { afterEach, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { cli, initialized, manifest, project, snapshot } from './project-fixture.ts';
import { Prompts } from '../../packages/cli/src/lib/prompts.ts';
import { guidedLeaderboard, guidedAchievement } from '../../packages/cli/src/commands/guided-create.ts';
const roots: string[] = [];
function setup() { const root = project(); roots.push(root); initialized(root); expect(cli(root, 'add', 'achievements').status).toBe(0); return root; }
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function prompts(answers: (string | null)[]) { return new Prompts(async () => answers.shift() ?? null, () => {}); }
it('guides missing leaderboard settings and writes the validated definition', async () => {
  const root = setup();
  await guidedLeaderboard('arcade', { workdir: root }, prompts(['points','desc','0','1000000','y']));
  expect(manifest(root).leaderboards).toEqual([{ id:'arcade',kind:'points',sortDirection:'desc',keepBest:true,minValue:0,maxValue:1000000 }]);
});
it.each([['n'], [null]] as const)('declining or cancelling changes no files', async (answer) => {
  const root = setup(), before = snapshot(root);
  await expect(guidedLeaderboard('arcade', { workdir: root }, prompts(['points','desc','none','none',answer]))).rejects.toThrow(/cancel/i);
  expect(snapshot(root)).toEqual(before);
});
it('fully specified leaderboard commands never consult prompts, preserving unbounded defaults', async () => {
  const root = setup();
  await guidedLeaderboard('arcade', { workdir:root,type:'points',order:'desc',keepBest:true }, prompts([]));
  expect(manifest(root).leaderboards[0]?.minValue).toBeNull();
});
it('dry-run guided configuration never asks for write approval or changes files', async () => {
  const root = setup(), before = snapshot(root);
  await guidedLeaderboard('arcade', { workdir:root,dryRun:true }, prompts(['points','desc','0','100']));
  expect(snapshot(root)).toEqual(before);
});
it('guides achievements using installed descending boards and preserves explicit fields', async () => {
  const root = setup();
  await guidedLeaderboard('arcade', { workdir:root,type:'points',order:'desc',keepBest:true }, prompts([]));
  await guidedAchievement('winner', { workdir:root,title:'Winner',description:'Win once' }, prompts(['arcade','100','y']));
  expect(manifest(root).achievements?.[0]).toMatchObject({id:'winner',title:'Winner',condition:{leaderboardId:'arcade',threshold:100}});
});
it('JSON failures and local previews remain a single document with no prompts', () => {
  const root = setup();
  const missing = cli(root,'leaderboard','create','arcade','--json');
  expect(missing.status).toBe(1);
  expect(JSON.parse(missing.stdout)).toMatchObject({schemaVersion:1,ok:false,error:{category:'validation'}});
  const before = snapshot(root);
  const dry = cli(root,'leaderboard','create','arcade','--type','points','--order','desc','--keep-best','--dry-run','--json','--no-interactive');
  expect(dry.status,dry.stderr).toBe(0);
  expect(JSON.parse(dry.stdout)).toMatchObject({ok:true,events:expect.arrayContaining([expect.objectContaining({kind:'file',status:'create'})])});
  expect(snapshot(root)).toEqual(before);
});
