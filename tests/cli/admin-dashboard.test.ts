import { afterEach, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cli, initialized, project } from "./project-fixture.ts";
import {
  openAdminService,
  resolveAdminTarget,
} from "../../packages/cli/src/lib/admin-service.ts";
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
it("rejects ambiguous Supabase JSON/TOML configuration", () => {
  const root = fixture();
  writeFileSync(join(root, "supabase/config.json"), "{}");
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
