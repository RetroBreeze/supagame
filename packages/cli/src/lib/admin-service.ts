import { adminDoctorSql, adminMutation, type AdminOperation } from "./admin.ts";
import { DoctorInspector, inspectionWorkspace } from "./doctor-inspect.ts";
import { readProjectFile } from "./file-stage.ts";
import { object, readManifest } from "./manifest.ts";
import { type LocalOptions, readProject, selectedRef } from "./project.ts";
import { type ProcessRunner, runSupabase } from "./supabase-cli.ts";

export interface AdminTargetOptions extends LocalOptions {
  local?: boolean;
  remote?: boolean;
}
export class AdminFailure extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
export function resolveAdminTarget(options: AdminTargetOptions) {
  if (!!options.local === !!options.remote) {
    throw new Error("Choose exactly --local or --remote.");
  }
  const project = readProject(options), manifest = readManifest(project.root);
  if (!manifest?.value.modules.admin) {
    throw new Error("Install Admin with supagame add admin first.");
  }
  if (readProjectFile(project.root, "supabase/config.json") !== null) {
    throw new Error(
      "Ambiguous supabase/config.json and config.toml configuration. Reconcile it before administration.",
    );
  }
  const ref = selectedRef(
    project.root,
    options.projectRef,
    manifest.value.projectRef,
  );
  const port = object(project.config.db)
    ? Number(project.config.db.port ?? 54322)
    : 54322;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Invalid local database port.");
  }
  const name = String(project.config.project_id);
  return {
    root: project.root,
    ref,
    name,
    environment: options.remote ? "hosted" as const : "local" as const,
    modules: { ...manifest.value.modules },
    connection: { projectId: name, port, ...(options.remote ? { ref } : {}) },
    fingerprint: JSON.stringify([
      project.bytes.toString(),
      manifest.bytes.toString(),
      ref,
    ]),
  };
}
export type AdminTarget = ReturnType<typeof resolveAdminTarget>;
export interface AdminService {
  readonly target: AdminTarget;
  query(sql: string): Promise<unknown>;
  execute(operation: AdminOperation): Promise<unknown>;
  verify(): Promise<unknown>;
  revalidate(): void;
  close(): void;
}
const failures: Record<string, [string, number]> = {
  ADMIN_STALE_STATE: [
    "State changed since preview. Review a new preview before proceeding.",
    409,
  ],
  ADMIN_OPERATION_CONFLICT: [
    "Operation ID was already used with another payload. Inspect audit history.",
    409,
  ],
  ADMIN_TARGET_NOT_FOUND: ["Target no longer exists.", 404],
  ADMIN_DENIED: ["The database denied operator permissions.", 403],
  ADMIN_REASON_REQUIRED: [
    "A reason between 1 and 1000 characters is required.",
    400,
  ],
};
export async function openAdminService(
  options: AdminTargetOptions,
  run: ProcessRunner = runSupabase,
): Promise<AdminService> {
  const target = resolveAdminTarget(options),
    scratch = inspectionWorkspace(target.connection, []);
  const inspector = new DoctorInspector(run, scratch.root, target.connection);
  let closed = false;
  const revalidate = () => {
    if (closed) {
      throw new AdminFailure(
        "SESSION_CLOSED",
        "Dashboard session has closed.",
        401,
      );
    }
    try {
      if (
        resolveAdminTarget({ ...options, workdir: target.root }).fingerprint !==
          target.fingerprint
      ) throw Error();
    } catch {
      throw new AdminFailure(
        "PROJECT_CHANGED",
        "Project configuration changed. Stop and restart the dashboard.",
        409,
      );
    }
  };
  const query = async (sql: string) => {
    revalidate();
    try {
      return await inspector.query(sql);
    } catch {
      throw new AdminFailure(
        "READ_FAILED",
        "Read failed. Check Supabase CLI login, permissions, network and Admin installation.",
        503,
      );
    }
  };
  try {
    await inspector.version();
  } catch (e) {
    scratch.remove();
    throw e;
  }
  return {
    target,
    revalidate,
    query,
    async verify() {
      revalidate();
      await inspector.json(["migration", "list"]); // validates explicit target envelope, including local host/port
      const checks = await query(adminDoctorSql);
      if (
        !Array.isArray(checks) || checks.length !== 1 || !object(checks[0]) ||
        checks[0].module !== "admin" ||
        [
          "installed",
          "restricted_execution",
          "rls",
          "migration_applied",
          "private_functions",
          "private_tables",
        ].some((key) => checks[0][key] !== true)
      ) {
        throw new AdminFailure(
          "ADMIN_UNAVAILABLE",
          "Admin schema, migration or security checks failed. Run supagame admin doctor.",
          403,
        );
      }
      // Hosted --read-only uses supabase_read_only_user, even for an operator.
      // Check the same transport/role as execute(), using only this fixed,
      // side-effect-free catalog SELECT. Ordinary reads retain --read-only.
      revalidate();
      let role: unknown;
      try {
        role = await inspector.json([
          "db", "query",
          "select current_user in ('postgres','supabase_admin') and has_function_privilege(current_user,'sg_private.admin_apply(text,text,bigint,uuid,text)','execute') as permitted",
          "--yes",
        ], true);
      } catch {
        throw new AdminFailure(
          "OPERATOR_CHECK_FAILED",
          "Supabase operator verification failed. Check CLI login, database query permissions and network for the selected project; raw diagnostics withheld.",
          503,
        );
      }
      if (
        !Array.isArray(role) || role.length !== 1 || !object(role[0]) ||
        role[0].permitted !== true
      ) {
        throw new AdminFailure(
          "ADMIN_DENIED",
          "A trusted Supabase project operator with Admin execution permission is required. Admin doctor checks installation security, not operator authorization.",
          403,
        );
      }
      return checks;
    },
    async execute(operation) {
      revalidate();
      const statement = adminMutation(operation);
      let result;
      try {
        result = await run([
          "db",
          "query",
          statement,
          "--yes",
          ...(target.environment === "hosted"
            ? [`--remote=${target.ref}`]
            : []),
          "--workdir",
          scratch.root,
          "--agent=no",
          "--output",
          "json",
        ], scratch.root);
      } catch {
        throw new AdminFailure(
          "OUTCOME_UNKNOWN",
          "Operation outcome is unknown. Inspect audit history or retry the same operation ID.",
          503,
        );
      }
      if (result.code !== 0) {
        if (
          (result.stderr + result.stdout).includes("permission denied")
        ) {
          throw new AdminFailure(
            "ADMIN_DENIED",
            "The database denied operator permissions.",
            403,
          );
        }
        if (
          (result.stderr + result.stdout).includes("sg_private.admin_apply") &&
          (result.stderr + result.stdout).includes("does not exist")
        ) {
          throw new AdminFailure(
            "ADMIN_UNAVAILABLE",
            "Admin is missing or its migration is incomplete. Run admin doctor.",
            409,
          );
        }
        for (
          const [code, [message, status]] of Object.entries(failures)
        ) {
          if (
            (result.stderr + result.stdout).includes(code)
          ) throw new AdminFailure(code, message, status);
        }
        throw new AdminFailure(
          "OUTCOME_UNKNOWN",
          "Operation failed or its outcome is unknown. Inspect audit history; retry only with the same operation ID and revision. Raw diagnostics withheld.",
          503,
        );
      }
      try {
        const value: unknown = JSON.parse(result.stdout);
        if (
          !Array.isArray(value) || value.length !== 1 || !object(value[0]) ||
          !object(value[0].result)
        ) throw Error();
        return value;
      } catch {
        throw new AdminFailure(
          "OUTCOME_UNKNOWN",
          "Unverifiable operation response. Inspect audit history or retry the same operation ID.",
          503,
        );
      }
    },
    close() {
      closed = true;
      scratch.remove();
    },
  };
}
