import { createInterface } from "node:readline/promises";
import { inspectionWorkspace, DoctorInspector } from "../lib/doctor-inspect.ts";
import { readManifest, object } from "../lib/manifest.ts";
import { readProject, selectedRef, type LocalOptions } from "../lib/project.ts";
import { runSupabase, type ProcessRunner } from "../lib/supabase-cli.ts";
import { sqlLiteral } from "../lib/migration-generator.ts";
interface Options extends LocalOptions {
  local?: boolean;
  remote?: boolean;
  allowRemote?: boolean;
}
interface Dependencies {
  run: ProcessRunner;
  fetcher: typeof fetch;
  log: (line: string) => void;
  interactive: boolean;
  confirm: (ref: string) => Promise<string>;
}
const defaults = (): Dependencies => ({
  run: runSupabase,
  fetcher: fetch,
  log: console.log,
  interactive: !!process.stdin.isTTY && !process.env.CI,
  confirm: async (ref) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      return await rl.question(
        `Type "cleanup ${ref}" to remove only the displayed retired/abandoned objects: `,
      );
    } finally {
      rl.close();
    }
  },
});
export async function cleanupSaves(options: Options, deps = defaults()) {
  if (!!options.local === !!options.remote)
    throw new Error("Choose exactly --local or --remote --project-ref <ref>.");
  const project = readProject(options),
    manifest = readManifest(project.root);
  if (!manifest?.value.modules["cloud-saves"])
    throw new Error("Install cloud-saves first.");
  if (options.remote && !options.projectRef)
    throw new Error("An exact --project-ref is required.");
  const ref = selectedRef(
    project.root,
    options.remote ? options.projectRef : undefined,
    manifest.value.projectRef,
  );
  if (options.allowRemote && options.dryRun)
    throw new Error("Preview and remote authorization are separate.");
  const port = object(project.config.db)
    ? Number(project.config.db.port ?? 54322)
    : 54322;
  const target = {
    projectId: String(project.config.project_id),
    port,
    ...(options.remote ? { ref } : {}),
  };
  const scratch = inspectionWorkspace(target, []);
  const candidates =
    "select path from sg_private.save_objects o where (state='garbage' or (state='pending' and created_at<now()-interval '24 hours') or state='live' or not exists(select 1 from auth.users where id=o.user_id)) and not exists(select 1 from public.game_saves where object_path=o.path and not deleted) and not exists(select 1 from sg_private.save_revisions r where r.user_id=o.user_id and (r.snapshot).object_path=o.path and r.expires_at>now()) order by created_at,path limit 100";
  const paths = (value: unknown): string[] => {
    if (
      !Array.isArray(value) ||
      value.some(
        (v) =>
          !object(v) ||
          typeof v.path !== "string" ||
          !/^[0-9a-f-]{36}\/[0-9a-f-]{36}$/.test(v.path),
      )
    )
      throw new Error("Cleanup returned unverifiable object paths.");
    return value.map((v) => v.path as string);
  };
  try {
    const inspector = new DoctorInspector(deps.run, scratch.root, target);
    await inspector.version();
    const preview = paths(await inspector.query(candidates));
    deps.log(
      `Cloud Saves cleanup destination: ${options.remote ? ref : `local ${target.projectId} on 127.0.0.1:${port}`}`,
    );
    for (const path of preview)
      deps.log(`Retired/abandoned private object: ${path}`);
    if (options.dryRun) {
      deps.log(`Preview only: ${preview.length} objects. No changes made.`);
      return;
    }
    if (options.remote && !options.allowRemote) {
      if (!deps.interactive)
        throw new Error(
          "Hosted cleanup requires explicit confirmation or --allow-remote.",
        );
      if ((await deps.confirm(ref)) !== `cleanup ${ref}`)
        throw new Error("Cleanup declined. No changes made.");
    }
    if (!preview.length) {
      deps.log("No objects need cleanup.");
      return;
    }
    let url: string, adminKey: string;
    if (options.remote) {
      url = `https://${ref}.supabase.co`;
      adminKey = process.env.SUPAGAME_STORAGE_ADMIN_KEY ?? "";
      if (!adminKey)
        throw new Error(
          "Operator cleanup needs SUPAGAME_STORAGE_ADMIN_KEY in this process environment; never put it in a game or committed file. No changes made.",
        );
    } else {
      const result = await deps.run(
        ["status", "--workdir", project.root, "--output", "json"],
        scratch.root,
      );
      if (result.code !== 0)
        throw new Error("Cannot inspect the local Storage service.");
      const status = JSON.parse(result.stdout) as Record<string, string>;
      const apiPort = object(project.config.api)
        ? Number(project.config.api.port ?? 54321)
        : 54321;
      if (status.API_URL !== `http://127.0.0.1:${apiPort}`)
        throw new Error("Unverified local Storage destination.");
      url = status.API_URL;
      adminKey = status.SERVICE_ROLE_KEY ?? "";
      if (!adminKey) throw new Error("Local operator credential unavailable.");
    }
    const query = async (sql: string) => {
      const result = await deps.run(
        [
          "db",
          "query",
          sql,
          // This closure is reached only after the hosted confirmation above.
          ...(options.remote ? [`--remote=${ref}`, "--yes"] : []),
          "--workdir",
          scratch.root,
          "--agent=no",
          "--output",
          "json",
        ],
        scratch.root,
      );
      if (result.code !== 0)
        throw new Error(
          "Cleanup database operation failed; raw output withheld. Retry safely.",
        );
      return JSON.parse(result.stdout) as unknown;
    };
    const array = (items: string[]) =>
      `array[${items.map(sqlLiteral).join(",")}]::text[]`;
    const selected = paths(
      await query(
        `select sg_private.prepare_save_cleanup(${array(preview)}) as path`,
      ),
    );
    if (!selected.length) {
      deps.log("Candidates changed; no objects removed.");
      return;
    }
    let response: Response;
    try {
      response = await deps.fetcher(`${url}/storage/v1/object/supagame-saves`, {
        method: "DELETE",
        redirect: "error",
        headers: {
          apikey: adminKey,
          Authorization: `Bearer ${adminKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ prefixes: selected }),
      });
    } catch {
      throw new Error(
        "Storage unavailable. Cleanup records remain for a safe retry.",
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        "Storage cleanup failed. Registry retained; no current saves were removed.",
      );
    }
    await response.body?.cancel();
    await query(
      `select sg_private.finish_save_cleanup(${array(selected)}) as removed`,
    );
    deps.log(
      `Cleanup processed ${selected.length} objects. Repeat for the next batch; live saves are protected.`,
    );
  } finally {
    scratch.remove();
  }
}
