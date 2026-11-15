import { afterEach, expect, it } from "vitest";
import { rmSync } from "node:fs";
import {
  connectionFile,
  connectionInfo,
} from "../../packages/cli/src/lib/connection.ts";
import { applyPlan, planFiles } from "../../packages/cli/src/lib/file-stage.ts";
import { project, put, ref, snapshot } from "./project-fixture.ts";
import { connection } from "../../packages/cli/src/commands/connection.ts";
import { SetupEnvironment } from "../../packages/cli/src/lib/setup-environment.ts";
const key = "sb_publishable_synthetic_public_key";
const roots: string[] = [];
afterEach(() =>
  roots.splice(0).forEach((root) =>
    rmSync(root, { recursive: true, force: true })
  )
);
it("exports a derived engine-neutral public snapshot", () => {
  expect(connectionInfo(ref, key)).toEqual({
    schemaVersion: 1,
    projectRef: ref,
    publishableKey: key,
    supabaseUrl: `https://${ref}.supabase.co`,
    apiBaseUrl: `https://${ref}.supabase.co/functions/v1/supagame/v1`,
  });
});
it.each([
  "sb_secret_forbidden",
  "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.signature",
  "sbp_access_token",
  "password",
  "sb_publishable_bad\nvalue",
])(
  "rejects credentials outside the public key format without echoing them",
  (value) => {
    expect(() => connectionInfo(ref, value)).toThrow(/publishable/i);
    try {
      connectionInfo(ref, value);
    } catch (error) {
      expect(String(error)).not.toContain(value);
    }
  },
);
it("rejects wrong project URLs, insecure URLs and unverified custom domains", () => {
  for (
    const url of [
      "https://zzzzzzzzzzzzzzzzzzzz.supabase.co",
      "https://unverified.example",
      "http://example.com",
      "https://user:password@example.com",
      "https://example.com/path",
    ]
  ) expect(() => connectionInfo(ref, key, url)).toThrow();
  expect(
    connectionInfo(ref, key, "https://games.example.com", "games.example.com")
      .supabaseUrl,
  ).toBe("https://games.example.com");
});
it("never replaces foreign files or exports for another project, even with replacement enabled", () => {
  const root = project(false);
  roots.push(root);
  put(root, "connection.json", '{"keep":"mine"}');
  const before = snapshot(root);
  expect(() =>
    connectionFile(root, "connection.json", connectionInfo(ref, key), true)
  ).toThrow(/replace|export/i);
  expect(snapshot(root)).toEqual(before);
});
it("safely repeats identical exports and requires explicit replacement for public key changes", () => {
  const root = project(false);
  roots.push(root);
  applyPlan(
    root,
    planFiles(root, [
      connectionFile(root, "connection.json", connectionInfo(ref, key)),
    ]),
  );
  const before = snapshot(root);
  applyPlan(
    root,
    planFiles(root, [
      connectionFile(root, "connection.json", connectionInfo(ref, key)),
    ]),
  );
  expect(snapshot(root)).toEqual(before);
  expect(() =>
    connectionFile(root, "connection.json", connectionInfo(ref, key + "new"))
  ).toThrow(/replace/i);
  applyPlan(
    root,
    planFiles(root, [
      connectionFile(
        root,
        "connection.json",
        connectionInfo(ref, key + "new"),
        true,
      ),
    ]),
  );
});
it.each([
  ".supagame-stage/export.json",
  ".git/config.json",
  "supabase/config.json",
  "supagame.config.json",
])("rejects installer-owned output paths (%s)", (path) => {
  const root = project(false);
  roots.push(root);
  expect(() => connectionFile(root, path, connectionInfo(ref, key))).toThrow(
    /path|reserved/i,
  );
  expect(snapshot(root)).toEqual({});
});
it("revalidates local project identity after fetching public keys", async () => {
  const root = project(false);
  roots.push(root);
  put(root, "supabase/.temp/project-ref", ref);
  const env = new SetupEnvironment(async (args) => {
    if (args[0] === "--version") {
      return { code: 0, stdout: "3.0.0", stderr: "" };
    }
    put(root, "supabase/.temp/project-ref", "zzzzzzzzzzzzzzzzzzzz");
    return {
      code: 0,
      stderr: "",
      stdout: JSON.stringify({
        target: { kind: "linked", project_ref: ref },
        keys: [{
          id: "public",
          name: "default",
          type: "publishable",
          api_key: key,
        }],
      }),
    };
  });
  await expect(
    connection({ workdir: root, output: "connection.json" }, undefined, env),
  ).rejects.toThrow(/mismatch/i);
  expect(snapshot(root)["connection.json"]).toBeUndefined();
});
