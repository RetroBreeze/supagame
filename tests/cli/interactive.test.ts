import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  cli,
  initialized,
  manifest,
  project,
  ref,
  repo,
  snapshot,
} from "./project-fixture.ts";
const roots: string[] = [];
afterEach(() =>
  roots.splice(0).forEach((root) =>
    rmSync(root, { recursive: true, force: true })
  )
);
function fixture(installed = true) {
  const root = project(installed);
  roots.push(root);
  if (installed) {
    initialized(root);
    expect(cli(root, "add", "leaderboards").status).toBe(0);
  }
  return root;
}
function pty(
  root: string,
  args: string[],
  steps: string[][] = [],
  env: NodeJS.ProcessEnv = {},
) {
  const result = spawnSync("python3", [
    join(repo, "tests/cli/pty-driver.py"),
    JSON.stringify({
      cwd: root,
      command: [
        process.execPath,
        join(repo, "packages/cli/src/cli.ts"),
        ...args,
      ],
      steps,
      env: { ...process.env, CI: "", NO_COLOR: "1", ...env },
    }),
  ], { encoding: "utf8", timeout: 25000 });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as { code: number; output: string };
}
it("creates a leaderboard through an actual terminal with validation feedback", () => {
  const root = fixture();
  const result = pty(root, ["leaderboard", "create", "arcade"], [
    ["? Score type", "points\n"],
    ["? Ranking", "desc\n"],
    ["? Minimum", "invalid\n"],
    ["! Enter a decimal", "0\n"],
    ["? Maximum", "100\n"],
    ["? Create leaderboard", "y\n"],
  ]);
  expect(result.code, result.output).toBe(0);
  expect(manifest(root).leaderboards[0]?.maxValue).toBe(100);
  // eslint-disable-next-line no-control-regex -- Assert ANSI color is disabled on a real PTY.
  expect(result.output).not.toMatch(/\u001b\[[0-9;]*m/);
});
it.each(["\u0003", "\u0004"])(
  "cancels terminal input without files (%s)",
  (key) => {
    const root = fixture(), before = snapshot(root);
    const result = pty(root, ["leaderboard", "create", "arcade"], [[
      "? Score type",
      key,
    ]]);
    expect(result.code, result.output).toBe(130);
    expect(snapshot(root)).toEqual(before);
  },
);
it.each([["--no-interactive"], ["--json"]])(
  "never prompts in a terminal with %s",
  (flags) => {
    const root = fixture(),
      result = pty(root, ["leaderboard", "create", "arcade", flags]);
    expect(result.code).toBe(1);
    expect(result.output).not.toContain("? Score type");
    if (flags === "--json") expect(JSON.parse(result.output).ok).toBe(false);
  },
);
it("never prompts under CI or for a fully specified command in a terminal", () => {
  const root = fixture();
  expect(pty(root, ["leaderboard", "create", "arcade"], [], { CI: "1" }).code)
    .toBe(1);
  const result = pty(root, [
    "leaderboard",
    "create",
    "arcade",
    "--type",
    "points",
    "--order",
    "desc",
    "--keep-best",
  ]);
  expect(result.code, result.output).toBe(0);
  expect(result.output).not.toContain("?");
});
it("guides native-engine initialization with a synthetic CLI account, without hosted writes", () => {
  const root = fixture(false),
    bin = mkdtempSync(join(tmpdir(), "supagame-pty-bin-"));
  roots.push(bin);
  const executable = join(bin, "supabase");
  writeFileSync(
    executable,
    `#!/usr/bin/env node\nconst args=process.argv.slice(2);if(args[0]==='--version') console.log('3.0.0');else if(args[0]==='projects'&&args[1]==='list') console.log(JSON.stringify({projects:[{id:'${ref}',name:'Arcade'}]}));else process.exit(99);\n`,
  );
  chmodSync(executable, 0o700);
  const result = pty(root, ["init"], [
    ["? Supabase project", ref + "\n"],
    ["? Which Supagame", "achievements\n"],
    ["? Configure browser", "n\n"],
    ["? Export public", "n\n"],
    ["? Apply configuration", "y\n"],
  ], { PATH: bin + ":" + process.env.PATH });
  expect(result.code, result.output).toBe(0);
  expect(manifest(root).modules.achievements).toBeTruthy();
  expect(manifest(root).origins).toBeUndefined();
});
