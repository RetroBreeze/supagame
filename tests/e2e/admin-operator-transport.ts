import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { dashboardSession } from "./dashboard-session.ts";

// This double models the observed hosted Supabase 3.0.0 transport boundary.
// Real SQL/grants are covered by database tests and the installed local E2E.
export async function packagedHostedOperator(cli: string, root: string) {
  const bin = join(root, "operator-bin"), log = join(root, "operator-calls.jsonl");
  mkdirSync(bin);
  writeFileSync(join(bin, "supabase"), `#!/usr/bin/env node
import {appendFileSync} from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify({args,cwd:process.cwd()})+'\\n');
const emit = value => console.log(JSON.stringify(value));
if (args[0] === '--version') console.log('3.0.0');
else if (!args.includes('--remote=abcdefghijklmnopqrst')) process.exit(1);
else if (args[0] === 'migration') emit({target:{kind:'linked',project_ref:'abcdefghijklmnopqrst'},migrations:[]});
else if (args[0] !== 'db' || args[1] !== 'query') process.exit(1);
else if (args[2].includes('current_user in')) emit([{permitted:!args.includes('--read-only')}]);
else if (args[2].startsWith("select 'admin' as module") && args.includes('--read-only')) emit([{module:'admin',installed:true,restricted_execution:true,rls:true,migration_applied:true,private_functions:true,private_tables:true}]);
else process.exit(1);
`, { mode: 0o700 });
  const session = await dashboardSession(cli, root, {
    remote: true, env: { ...process.env, PATH: bin + delimiter + process.env.PATH },
  });
  try {
    assert.equal((await fetch(session.url)).status, 200);
    const calls = readFileSync(log, "utf8").trim().split("\n").map((line) =>
      JSON.parse(line) as { args: string[]; cwd: string }
    );
    const probe = calls.find(({ args }) => args[2]?.includes("current_user in"));
    assert.ok(probe, "startup must verify the actual operator");
    assert.ok(probe.args.includes("--yes"));
    assert.ok(!probe.args.includes("--read-only"));
    assert.notEqual(probe.cwd, root, "Supabase runs in an isolated workdir");
    for (const call of calls.filter(({ args }) => args[0] !== "--version")) {
      assert.ok(call.args.includes("--remote=abcdefghijklmnopqrst"));
      assert.equal(call.cwd, probe.cwd);
    }
  } finally { await session.close(); }
  await assert.rejects(fetch(session.url));
}
