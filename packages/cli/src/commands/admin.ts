import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import {
  type AdminAction,
  adminDoctorSql,
  adminInspection,
  type AdminKind,
  adminMutation,
} from "../lib/admin.ts";
import { AdminFailure, openAdminService } from "../lib/admin-service.ts";
import { object } from "../lib/manifest.ts";
import { type LocalOptions } from "../lib/project.ts";
import { type ProcessRunner, runSupabase } from "../lib/supabase-cli.ts";
export interface AdminOptions extends LocalOptions {
  local?: boolean;
  remote?: boolean;
  allowRemote?: boolean;
  yes?: boolean;
  reason?: string;
  operationId?: string;
  expectedRevision?: string;
  json?: boolean;
  generation?: string;
}
export interface AdminDependencies {
  run: ProcessRunner;
  log: (message: string) => void;
  interactive: boolean;
  confirm: (prompt: string) => Promise<string>;
}
const defaults = (): AdminDependencies => ({
  run: runSupabase,
  log: console.log,
  interactive: !!process.stdin.isTTY && !process.env.CI,
  confirm: async (prompt) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      return await rl.question(prompt);
    } finally {
      rl.close();
    }
  },
});
export async function adminCommand(
  kind: AdminKind | "audit" | "doctor",
  verb: string,
  target: string | undefined,
  options: AdminOptions,
  deps = defaults(),
) {
  if (!!options.local === !!options.remote) {
    throw new Error("Choose --local or --remote --project-ref <ref>.");
  }
  if (options.remote && !options.projectRef) {
    throw new Error("Hosted administration requires --project-ref.");
  }
  const service = await openAdminService(options, deps.run);
  const destination = options.remote
    ? service.target.ref
    : `local:${service.target.name}`;
  try {
    const mutation = !["inspect", "list", "doctor"].includes(verb);
    const sql = kind === "doctor"
      ? adminDoctorSql
      : kind === "audit"
      ? "select operation_id,actor,action,target_type,target,created_at,reason,outcome,before_state,after_state from sg_private.admin_audit order by created_at desc limit 100"
      : verb === "list"
      ? "select * from public.game_leaderboards order by id"
      : adminInspection(
        kind,
        target!,
        options.generation === undefined
          ? undefined
          : Number(options.generation),
      );
    const preview = await service.query(sql);
    if (!options.json) deps.log(`Admin destination: ${destination}`);
    deps.log(JSON.stringify(preview, null, 2));
    if (
      kind === "doctor" &&
      (!Array.isArray(preview) || preview.length !== 1 || !object(preview[0]) ||
        Object.entries(preview[0]).some(([key, value]) =>
          key !== "module" && value !== true
        ))
    ) {
      throw new Error(
        "Admin security or migration checks failed; review the findings before operating.",
      );
    }
    if (!mutation) return;
    if (
      !Array.isArray(preview) || preview.length !== 1 || !object(preview[0]) ||
      !object(preview[0].result)
    ) throw new Error("Target not found or unsupported inspection result.");
    const revision = Number(preview[0].result.revision);
    const operationId = options.operationId ?? randomUUID();
    deps.log(
      `Operation ${operationId}: ${kind}.${verb} ${target}; expected revision ${revision}. Reset starts an empty generation; hide removes a score from rankings; restrictions block new score submissions. Historical records are retained.`,
    );
    if (options.dryRun) {
      deps.log("Read-only preview; no changes made.");
      return;
    }
    if (!options.reason?.trim()) {
      throw new Error("Every modification requires --reason.");
    }
    if (options.operationId && options.expectedRevision === undefined) {
      throw new Error(
        "Retries with --operation-id require --expected-revision from the original preview.",
      );
    }
    const operation = {
      action: `${kind}.${verb}` as AdminAction,
      target: target!,
      revision: options.expectedRevision === undefined
        ? revision
        : Number(options.expectedRevision),
      operationId,
      reason: options.reason,
    };
    adminMutation(operation);
    if (!(options.remote ? options.allowRemote : options.yes)) {
      if (!deps.interactive) {
        throw new Error(
          "Explicit confirmation required: --allow-remote for hosted or --yes for local automation.",
        );
      }
      if (
        await deps.confirm(
          `Type "${verb} ${target} ${destination}" to confirm: `,
        ) !== `${verb} ${target} ${destination}`
      ) throw new Error("Declined; no changes made.");
    }
    try {
      const result = await service.execute(operation);
      deps.log(JSON.stringify(result));
    } catch (error) {
      if (error instanceof AdminFailure && error.code === "OUTCOME_UNKNOWN") {
        throw new Error(
          `${error.message} Retry with --operation-id ${operation.operationId} --expected-revision ${operation.revision}.`,
          { cause: error },
        );
      }
      throw error;
    }
  } finally {
    service.close();
  }
}
