import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { openAdminService } from "../../packages/cli/src/lib/admin-service.ts";
test("optional Admin migration, authorization and lifecycle (transaction rolled back)", () => {
  const migration = readFileSync(
    new URL("../../modules/admin/migrations/001_admin.sql", import.meta.url),
    "utf8",
  );
  const tests = readFileSync(
    new URL("./admin.test.sql", import.meta.url),
    "utf8",
  );
  const output = execFileSync("docker", [
    "exec",
    "-i",
    "supabase_db_supagame-schema-tests",
    "psql",
    "-X",
    "-qAt",
    "-U",
    "postgres",
    "-d",
    "postgres",
    "-v",
    "ON_ERROR_STOP=1",
  ], {
    input: "begin;\n" + migration + "\n" + tests.replace(/^begin;/, ""),
    encoding: "utf8",
  });
  assert.doesNotMatch(output, /not ok/);
  assert.match(output, /1\.\.38/);
});

test("dashboard operator probe evaluates real PostgreSQL roles and EXECUTE privileges", async () => {
  const root = mkdtempSync(join(tmpdir(), "supagame-operator-db-"));
  const migration = readFileSync(new URL("../../modules/admin/migrations/001_admin.sql", import.meta.url), "utf8");
  mkdirSync(join(root, "supabase"));
  writeFileSync(join(root, "supabase/config.toml"), 'project_id="operator-test"\n');
  writeFileSync(join(root, "supagame.config.json"), JSON.stringify({
    formatVersion: 1, projectRef: "abcdefghijklmnopqrst",
    modules: { core: "0.1.0", leaderboards: "0.1.0", admin: "0.1.4" }, leaderboards: [],
  }));
  try {
    for (const [role, grantExecute, allowed] of [
      ["postgres", false, true], ["supabase_admin", false, true],
      ["postgres", "revoke", false],
      ["supabase_read_only_user", false, false],
      ["authenticated", false, false],
      // Even accidental EXECUTE grants must not bypass the operator role check.
      ["authenticated", true, false], ["anon", true, false], ["service_role", true, false],
    ] as const) {
      let probed = false;
      const service = await openAdminService({ workdir: root, remote: true }, async (args) => {
        if (args[0] === "--version") return { code: 0, stdout: "3.0.0", stderr: "" };
        if (args[0] === "migration") return { code: 0, stderr: "", stdout: JSON.stringify({
          target: { kind: "linked", project_ref: "abcdefghijklmnopqrst" }, migrations: [],
        }) };
        if (args[2]?.startsWith("select 'admin'")) return { code: 0, stderr: "", stdout: JSON.stringify([{
          module: "admin", installed: true, restricted_execution: true, rls: true,
          migration_applied: true, private_functions: true, private_tables: true,
        }]) };
        probed = true;
        // Emulate the hosted transport's role choice, but evaluate the production
        // permission SQL against the actual migration and PostgreSQL grants.
        const effectiveRole = args.includes("--read-only") ? "supabase_read_only_user" : role;
        const stdout = execFileSync("docker", ["exec", "-i", "supabase_db_supagame-schema-tests",
          "psql", "-X", "-qAt", "-U", "supabase_admin", "-d", "postgres", "-v", "ON_ERROR_STOP=1"], {
          encoding: "utf8",
          input: `begin;\nset local role postgres;\n${migration}\nreset role;\ngrant usage on schema sg_private to ${effectiveRole};\n${
            grantExecute === "revoke" ? `revoke execute on function sg_private.admin_apply(text,text,bigint,uuid,text) from ${effectiveRole};`
              : grantExecute ? `grant execute on function sg_private.admin_apply(text,text,bigint,uuid,text) to ${effectiveRole};` : ""
          }\nset local role ${effectiveRole};\nselect json_agg(r) from (${args[2]}) r;\nrollback;`,
        });
        return { code: 0, stdout: stdout.trim().split("\n").at(-1)!, stderr: "" };
      });
      try {
        if (allowed) await service.verify();
        else await assert.rejects(service.verify(), { code: "ADMIN_DENIED" }, role);
        assert.ok(probed);
      } finally { service.close(); }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
