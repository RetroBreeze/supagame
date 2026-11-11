import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
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
