import { planLeaderboard, createLeaderboard } from './leaderboard-create.ts';
import { planAchievement, createAchievement, type AchievementOptions } from './achievement-create.ts';
import { type LocalOptions, readProject } from '../lib/project.ts';
import { readManifest } from '../lib/manifest.ts';
import { type BoardOptions } from '../lib/migration-generator.ts';
import { applyPlan, reportPlan, type PlannedFile } from '../lib/file-stage.ts';
import { Cancelled, type Prompts } from '../lib/prompts.ts';
import { currentTerminal } from '../lib/terminal.ts';

async function apply(root: string, plan: PlannedFile[], dryRun: boolean | undefined, prompts: Prompts, question: string) {
  reportPlan(plan, Boolean(dryRun));
  if (dryRun) return;
  if (!await prompts.confirm(question, true)) throw new Cancelled();
  applyPlan(root, plan);
}
export async function guidedLeaderboard(id: string, options: LocalOptions & BoardOptions, prompts?: Prompts): Promise<void> {
  if (!prompts || (options.type !== undefined && options.order !== undefined && options.keepBest === true)) {
    createLeaderboard(id, options); return;
  }
  // Fail before asking questions if the project prerequisites are absent.
  const { root } = readProject(options);
  if (!readManifest(root)?.value.modules.leaderboards) throw new Error('Run supagame add leaderboards first.');
  const type = options.type ?? await prompts.select('Score type', [{value:'points',label:'Points'},{value:'time',label:'Time'}], 'points');
  const order = options.order ?? await prompts.select('Ranking', [{value:'desc',label:'Higher scores first'},{value:'asc',label:'Lower scores first'}], type === 'time' ? 'asc' : 'desc');
  const min = options.min ?? await prompts.integer('Minimum accepted score (none for unbounded)', {optional:true,default:'none'});
  const max = options.max ?? await prompts.integer('Maximum accepted score (none for unbounded)', {optional:true,default:'none',...(min === undefined ? {} : {min:Number(min)})});
  const prepared = planLeaderboard(id, { ...options, type, order, keepBest:true, ...(min === undefined ? {} : {min}), ...(max === undefined ? {} : {max}) });
  currentTerminal()?.values({ ID:id, Type:type, Ranking:order === 'desc' ? 'Highest first' : 'Lowest first', 'Keep best':'Yes (enforced by the backend)', Minimum:min ?? 'Unbounded', Maximum:max ?? 'Unbounded' });
  await apply(root, prepared.plan, options.dryRun, prompts, 'Create leaderboard?');
}
export async function guidedAchievement(id: string, options: LocalOptions & Partial<AchievementOptions>, prompts?: Prompts): Promise<void> {
  const complete = options.title !== undefined && options.description !== undefined && options.board !== undefined && options.threshold !== undefined;
  if (!prompts || complete) {
    if (!complete) throw new Error('Missing achievement options: supply --title, --description, --board and --threshold, or use an interactive terminal.');
    createAchievement(id, options as AchievementOptions); return;
  }
  const { root } = readProject(options), manifest = readManifest(root)?.value;
  if (!manifest?.modules.achievements) throw new Error('Run supagame add achievements first.');
  const boards = manifest.leaderboards.filter(b => b.sortDirection === 'desc').map(b => ({value:b.id,label:b.id}));
  if (!boards.length) throw new Error('Create a descending leaderboard before creating an achievement.');
  const title = options.title ?? await prompts.text('Title', {validate:v => v.length > 0 && v.length <= 120 ? undefined : 'Use 1–120 characters.'});
  const description = options.description ?? await prompts.text('Description', {validate:v => v.length <= 1000 ? undefined : 'Use at most 1000 characters.'});
  const board = options.board ?? await prompts.select('Leaderboard', boards);
  const threshold = options.threshold ?? (await prompts.integer('Score threshold', {min:0}))!;
  const prepared = planAchievement(id, {...options,title,description,board,threshold});
  currentTerminal()?.values({ID:id,Title:title,Leaderboard:board,Threshold:threshold});
  await apply(root, prepared.plan, options.dryRun, prompts, 'Create achievement?');
}
