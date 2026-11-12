import { afterEach, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cli, initialized, project } from "./project-fixture.ts";
import {
  openAdminService,
  resolveAdminTarget,
} from "../../packages/cli/src/lib/admin-service.ts";
import type { ProcessRunner } from "../../packages/cli/src/lib/supabase-cli.ts";
const roots: string[] = [];
function fixture() {
  const root = project();
  roots.push(root);
  initialized(root);
  expect(cli(root, "add", "admin").status).toBe(0);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});
it("dashboard requires explicit environment and derives one reference from its root", () => {
  const root = fixture();
  expect(() => resolveAdminTarget({ workdir: root })).toThrow();
  expect(() => resolveAdminTarget({ workdir: root, local: true, remote: true }))
    .toThrow();
  expect(resolveAdminTarget({ workdir: root, remote: true }).ref).toBe(
    "abcdefghijklmnopqrst",
  );
});
it("shared service pins configuration and rejects drift before execution", async () => {
  const root = fixture();
  const service = await openAdminService(
    { workdir: root, local: true },
    async () => ({ code: 0, stdout: "3.0.0", stderr: "" }),
  );
  try {
    mkdirSync(join(root, "supabase/.temp"), { recursive: true });
    writeFileSync(
      join(root, "supabase/.temp/project-ref"),
      "zzzzzzzzzzzzzzzzzzzz",
    );
    expect(() => service.revalidate()).toThrow();
  } finally {
    service.close();
  }
});
it("dashboard command is documented", () => {
  const root = fixture();
  const help = cli(root, "admin", "dashboard", "--help");
  expect(help.status).toBe(0);
  expect(help.stdout).toContain("--port");
});
it("refuses missing Admin and inconsistent manifest/link metadata", () => {
  const root = project();
  roots.push(root);
  initialized(root);
  expect(() => resolveAdminTarget({ workdir: root, local: true })).toThrow(
    "Install Admin",
  );
  expect(cli(root, "add", "admin").status).toBe(0);
  mkdirSync(join(root, "supabase/.temp"), { recursive: true });
  writeFileSync(
    join(root, "supabase/.temp/project-ref"),
    "zzzzzzzzzzzzzzzzzzzz",
  );
  expect(() => resolveAdminTarget({ workdir: root, remote: true })).toThrow(
    "mismatch",
  );
});
it("validates port and requires explicit mode before starting HTTP", () => {
  const root = fixture();
  expect(cli(root, "admin", "dashboard", "--local", "--port", "0").stderr)
    .toContain("Port");
  expect(cli(root, "admin", "dashboard").stderr).toContain(
    "--local or --remote",
  );
});
it("checks the remote response target and denies operators without execute permissions", async () => {
  const root = fixture();
  let permitted = false;
  const service = await openAdminService(
    { workdir: root, remote: true },
    async (args) => ({
      code: 0,
      stderr: "",
      stdout: args[0] === "--version"
        ? "3.0.0"
        : args[0] === "migration"
        ? JSON.stringify({
          target: { kind: "linked", project_ref: "abcdefghijklmnopqrst" },
          migrations: [],
        })
        : args[2]?.includes("current_user in")
        ? JSON.stringify([{ permitted }])
        : JSON.stringify([{
          module: "admin",
          installed: true,
          restricted_execution: true,
          rls: true,
          migration_applied: true,
          private_functions: true,
          private_tables: true,
        }]),
    }),
  );
  try {
    await expect(service.verify()).rejects.toThrow("operator");
    permitted = true;
    await expect(service.verify()).resolves.toBeDefined();
  } finally {
    service.close();
  }
});
it.each(["json", "jsonc"])("rejects ambiguous Supabase %s/TOML configuration", (extension) => {
  const root = fixture();
  writeFileSync(join(root, `supabase/config.${extension}`), "{}");
  expect(() => resolveAdminTarget({ workdir: root, remote: true })).toThrow(
    "config.json",
  );
});
it("fails closed on incomplete Admin security inspection results", async () => {
  const root = fixture();
  const service = await openAdminService(
    { workdir: root, local: true },
    async (args) => ({
      code: 0,
      stderr: "",
      stdout: args[0] === "--version"
        ? "3.0.0"
        : args[0] === "migration"
        ? JSON.stringify({
          target: { kind: "local", host: "127.0.0.1", port: 54322 },
          migrations: [],
        })
        : args[2]?.includes("current_user in")
        ? JSON.stringify([{ permitted: true }])
        : JSON.stringify([{ module: "admin" }]),
    }),
  );
  try {
    await expect(service.verify()).rejects.toThrow("security");
  } finally {
    service.close();
  }
});

const healthyAdmin = [{
  module: "admin", installed: true, restricted_execution: true, rls: true,
  migration_applied: true, private_functions: true, private_tables: true,
}];
function hostedTransport(operatorResponse = '[{"permitted":true}]', splitRoles = true) {
  const calls: { args: readonly string[]; cwd: string }[] = [];
  const run: ProcessRunner = async (args, cwd) => {
    calls.push({ args, cwd });
    const stdout = args[0] === "--version" ? "3.0.0"
      : args[0] === "migration" ? JSON.stringify({
        target: { kind: "linked", project_ref: "abcdefghijklmnopqrst" }, migrations: [],
      })
      : args[2]?.includes("current_user in")
      // Supabase 3.0.0 hosted read_only executes as supabase_read_only_user,
      // even when the same operator credentials authorize normal queries as postgres.
      ? splitRoles && args.includes("--read-only") ? '[{"permitted":false}]' : operatorResponse
      : args[2]?.startsWith("select sg_private.admin_apply(") ? '[{"result":{"generation":2}}]'
      : JSON.stringify(healthyAdmin);
    return { code: 0, stderr: "", stdout };
  };
  return { calls, run };
}
it("verifies the hosted mutation operator instead of the read-only query role", async () => {
  const { run, calls } = hostedTransport();
  const service = await openAdminService({ workdir: fixture(), remote: true }, run);
  try {
    await expect(service.verify()).resolves.toEqual(healthyAdmin);
    await service.query("select 1");
    await service.execute({ action: "leaderboard.reset", target: "test", revision: 0,
      operationId: "90000000-0000-4000-8000-000000000021", reason: "test" });
    const queries = calls.filter(({ args }) => args[0] === "db");
    const operator = queries.find(({ args }) => args[2]?.includes("current_user in"))!;
    const mutation = queries.at(-1)!;
    expect(operator.args.slice(3)).toEqual(mutation.args.slice(3));
    expect(operator.cwd).toBe(mutation.cwd);
    expect(operator.args).toContain("--yes");
    expect(operator.args).not.toContain("--read-only");
    for (const call of queries) {
      expect(call.args).toContain("--remote=abcdefghijklmnopqrst");
      expect(call.args).not.toContain("--db-url");
      if (call !== operator && call !== mutation) {
        expect(call.args).toContain("--read-only");
        expect(call.args).not.toContain("--yes");
      }
    }
  } finally { service.close(); }
});
it.each([
  '[{"permitted":false}]', '[{"permitted":"true"}]', '[{"permitted":1}]',
  '[{"permitted":null}]', '[{}]', '[]', '{}',
  '[{"permitted":true},{"permitted":false}]',
])("fails closed on an untrusted or ambiguous operator result: %s", async (response) => {
  const transport = hostedTransport(response, false);
  const service = await openAdminService({ workdir: fixture(), remote: true }, transport.run);
  try {
    await expect(service.verify()).rejects.toMatchObject({ code: "ADMIN_DENIED", status: 403 });
  } finally { service.close(); }
});
it.each(["failure", "throw", "invalid JSON"])("sanitizes an unavailable operator probe: %s", async (mode) => {
  const transport = hostedTransport();
  const service = await openAdminService({ workdir: fixture(), remote: true }, async (args, cwd) => {
    if (!args[2]?.includes("current_user in")) return transport.run(args, cwd);
    if (mode === "throw") throw new Error("private subprocess diagnostic");
    return { code: mode === "failure" ? 1 : 0, stdout: "private subprocess diagnostic", stderr: "private subprocess diagnostic" };
  });
  try {
    await expect(service.verify()).rejects.toMatchObject({
      code: "OPERATOR_CHECK_FAILED", status: 503,
      message: expect.stringContaining("operator verification"),
    });
    await expect(service.verify()).rejects.not.toThrow("private subprocess diagnostic");
  } finally { service.close(); }
});
