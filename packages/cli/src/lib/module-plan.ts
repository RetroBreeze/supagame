import { storageConfig } from './cloud-saves.ts';
import { type Manifest } from './manifest.ts';
import { functionConfig } from './project.ts';
import { checkMigrationVersions, MODULE_VERSION, templateFiles, migrationModule } from './templates.ts';

export const moduleChoices = [
  {value:'leaderboards',label:'Leaderboards'}, {value:'live-leaderboards',label:'Live Leaderboards'},
  {value:'achievements',label:'Achievements'}, {value:'cloud-saves',label:'Cloud Saves'}, {value:'admin',label:'Admin (operator tools)'},
];
export function modulePlan(project: {root:string;bytes:Buffer;config:Record<string,unknown>}, manifest: Manifest, requested: string[]) {
  for (const name of requested) if (!moduleChoices.some(c => c.value === name)) throw new Error(`Unknown module '${name}'. Available modules: ${moduleChoices.map(c => c.value).join(', ')}.`);
  for (const [name, version] of Object.entries(manifest.modules)) {
    if (version !== MODULE_VERSION) throw new Error(`Installed ${name} version ${version} differs from CLI templates ${MODULE_VERSION}. Use a matching CLI version, or inspect known forward-only paths with supagame upgrade --dry-run.`);
  }
  checkMigrationVersions(project.root);
  const modules = {...manifest.modules};
  if (requested.length) { modules.core = MODULE_VERSION; modules.leaderboards = MODULE_VERSION; }
  for (const name of requested) modules[name as keyof typeof modules] = MODULE_VERSION;
  let config = Object.keys(modules).length ? functionConfig(project.bytes,project.config) : project.bytes;
  if (requested.includes('cloud-saves')) config = storageConfig(config);
  return { value:{...manifest,modules}, config,
    files: Object.keys(modules).length ? templateFiles().filter(f => { const name = migrationModule(f.path); return !name || !!modules[name]; }) : [] };
}
