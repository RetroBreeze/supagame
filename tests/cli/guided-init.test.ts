import { afterEach, expect, it } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  cli,
  manifest,
  project,
  put,
  ref,
  snapshot,
} from "./project-fixture.ts";
import { planInit } from "../../packages/cli/src/commands/init.ts";
import { applyPlan } from "../../packages/cli/src/lib/file-stage.ts";
import { guidedInit } from "../../packages/cli/src/commands/guided-init.ts";
import { Prompts } from "../../packages/cli/src/lib/prompts.ts";
import { SetupEnvironment } from "../../packages/cli/src/lib/setup-environment.ts";
const roots: string[] = [];
function fixture() {
  const root = project(false);
  roots.push(root);
  return root;
}
afterEach(() =>
  roots.splice(0).forEach((root) =>
    rmSync(root, { recursive: true, force: true })
  )
);
it("stages selected modules and actual prerequisites in one transaction", () => {
  const root = fixture();
  const prepared = planInit({
    workdir: root,
    projectRef: ref,
    module: ["achievements", "cloud-saves"],
  });
  expect(snapshot(root)).toEqual({});
  expect(prepared.plan.at(-1)?.path).toBe("supagame.config.json");
  applyPlan(root, prepared.plan);
  expect(Object.keys(manifest(root).modules).sort()).toEqual([
    "achievements",
    "cloud-saves",
    "core",
    "leaderboards",
  ]);
  expect(readFileSync(join(root, "supabase/config.toml"), "utf8")).toContain(
    "[storage]",
  );
  expect(
    Object.keys(snapshot(root)).some((p) =>
      /supagame\.ts|\.env\.local/.test(p)
    ),
  ).toBe(false);
});
it("rolls back combined initialization after a module write fails", () => {
  const root = fixture(), before = snapshot(root);
  const { plan } = planInit({
    workdir: root,
    projectRef: ref,
    module: ["achievements"],
  });
  expect(() =>
    applyPlan(root, plan, {
      afterWrite: (path) => {
        if (path.includes("migrations/")) throw new Error("disk failure");
      },
    })
  ).toThrow("disk failure");
  expect(snapshot(root)).toEqual(before);
});
it("preserves unrelated files and origins across repeated explicit initialization", () => {
  const root = fixture();
  put(root, "notes.txt", "keep");
  expect(
    cli(
      root,
      "init",
      "--project-ref",
      ref,
      "--module",
      "achievements",
      "--origin",
      "https://game.example",
    ).status,
  ).toBe(0);
  const before = snapshot(root);
  expect(
    cli(root, "init", "--project-ref", ref, "--module", "achievements").status,
  ).toBe(0);
  expect(snapshot(root)).toEqual(before);
  expect(manifest(root).origins).toEqual(["https://game.example"]);
});
it("rejects unknown modules and conflicts before creating any files", () => {
  const root = fixture();
  expect(() =>
    planInit({ workdir: root, projectRef: ref, module: ["unknown"] })
  ).toThrow(/module/i);
  put(root, "supabase/.temp/project-ref", "zzzzzzzzzzzzzzzzzzzz");
  const before = snapshot(root);
  expect(() => planInit({ workdir: root, projectRef: ref, module: ["admin"] }))
    .toThrow(/mismatch/i);
  expect(snapshot(root)).toEqual(before);
});
function environment() {
  return new SetupEnvironment(async (args) => ({
    code: 0,
    stderr: "",
    stdout: args[0] === "--version"
      ? "3.0.0"
      : JSON.stringify({ projects: [{ id: ref, name: "Arcade" }] }),
  }));
}
function answers(values: (string | null)[]) {
  return new Prompts(async () => values.shift() ?? null, () => {});
}
it("guides a fresh native-engine project without origins or client code", async () => {
  const root = fixture();
  await guidedInit(
    { workdir: root },
    answers([ref, "achievements", "n", "n", "y"]),
    environment(),
  );
  expect(manifest(root).origins).toBeUndefined();
  expect(manifest(root).modules.achievements).toBeTruthy();
});
it("cancels the complete setup before any module or configuration is written", async () => {
  const root = fixture();
  await expect(
    guidedInit(
      { workdir: root },
      answers([ref, "leaderboards", "n", "n", "n"]),
      environment(),
    ),
  ).rejects.toThrow(/cancel/i);
  expect(snapshot(root)).toEqual({});
});
it("does not discover accounts or prompt for explicit offline setup", async () => {
  const root = fixture();
  const env = new SetupEnvironment(async () => {
    throw new Error("should not contact Supabase");
  });
  await guidedInit({ workdir: root, projectRef: ref }, answers([]), env);
  expect(manifest(root).projectRef).toBe(ref);
});
