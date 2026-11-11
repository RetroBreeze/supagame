import { it, expect } from "vitest";
import { rmSync } from "node:fs";
import {
  cli,
  initialized,
  manifest,
  project,
  snapshot,
  ref,
} from "./project-fixture.ts";
import { deploymentFiles } from "../../packages/cli/src/lib/deployment-files.ts";
import { securityChecks } from "../../packages/cli/src/lib/doctor-security.ts";
it("stages cloud saves, private Storage and policies idempotently with preview and doctor", () => {
  const root = project();
  initialized(root);
  try {
    const before = snapshot(root);
    const dry = cli(root, "add", "cloud-saves", "--dry-run");
    expect(dry.status, dry.stderr).toBe(0);
    expect(snapshot(root)).toEqual(before);
    const add = cli(root, "add", "cloud-saves");
    expect(add.status, add.stderr).toBe(0);
    expect(manifest(root).modules["cloud-saves"]).toBeTruthy();
    const staged = snapshot(root);
    expect(cli(root, "add", "cloud-saves").status).toBe(0);
    expect(snapshot(root)).toEqual(staged);
    expect(
      [...deploymentFiles(root, ref).owned].some((f) =>
        f.endsWith("_cloud_saves.sql"),
      ),
    ).toBe(true);
    expect(cli(root, "doctor").status).toBe(0);
    expect(cli(root, "upgrade", "--dry-run").status).toBe(0);
    const checks = securityChecks(["cloud-saves"]);
    expect(checks.some((c) => c.id === "saves:bucket")).toBe(true);
    expect(checks.some((c) => c.id === "saves:storage-guards")).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);
it("stages immutable quota changes without touching unrelated project configuration", () => {
  const root = project();
  initialized(root);
  try {
    expect(cli(root, "add", "cloud-saves").status).toBe(0);
    const before = snapshot(root);
    expect(
      cli(
        root,
        "saves",
        "configure",
        "--max-slots",
        "20",
        "--max-json-bytes",
        "65536",
        "--dry-run",
      ).status,
    ).toBe(0);
    expect(snapshot(root)).toEqual(before);
    const result = cli(
      root,
      "saves",
      "configure",
      "--max-slots",
      "20",
      "--max-json-bytes",
      "65536",
    );
    expect(result.status, result.stderr).toBe(0);
    const staged = snapshot(root);
    expect(
      cli(
        root,
        "saves",
        "configure",
        "--max-slots",
        "20",
        "--max-json-bytes",
        "65536",
      ).status,
    ).toBe(0);
    expect(snapshot(root)).toEqual(staged);
    expect(cli(root, "saves", "configure", "--max-slots", "0").status).not.toBe(
      0,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);

import { cleanupSaves } from "../../packages/cli/src/commands/saves-cleanup.ts";
import { vi } from "vitest";
it("cleanup previews exact destination and never mutates a hosted project without confirmation", async () => {
  const root = project();
  initialized(root);
  cli(root, "add", "cloud-saves");
  const calls: string[][] = [];
  const run = vi.fn(async (args: readonly string[]) => {
    calls.push([...args]);
    return {
      code: 0,
      stdout:
        args[0] === "--version"
          ? "3.0.0"
          : JSON.stringify([
              {
                path: "11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222",
              },
            ]),
      stderr: "",
    };
  });
  const fetcher = vi.fn();
  try {
    await cleanupSaves(
      { workdir: root, remote: true, projectRef: ref, dryRun: true },
      {
        run,
        fetcher,
        log: () => {},
        confirm: async () => "",
        interactive: false,
      },
    );
    expect(
      calls.every((a) => a[0] === "--version" || a.includes("--read-only")),
    ).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
    await expect(
      cleanupSaves(
        { workdir: root, remote: true, projectRef: ref },
        {
          run,
          fetcher,
          log: () => {},
          confirm: async () => "",
          interactive: false,
        },
      ),
    ).rejects.toThrow(/confirmation|allow-remote/i);
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it.each(["storage-http", "storage-network", "database-ack"] as const)(
  "operator cleanup retains recovery records after %s failure",
  async (failure) => {
    const root = project();
    initialized(root);
    cli(root, "add", "cloud-saves");
    const path =
      "11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
    const calls: string[][] = [];
    const run = vi.fn(async (args: readonly string[]) => {
      calls.push([...args]);
      if (args[0] === "--version")
        return { code: 0, stdout: "3.0.0", stderr: "" };
      if (args[0] === "status")
        return {
          code: 0,
          stdout: JSON.stringify({
            API_URL: "http://127.0.0.1:54321",
            SERVICE_ROLE_KEY: "not-a-real-credential",
          }),
          stderr: "",
        };
      if (args.some((a) => a.includes("finish_save_cleanup")))
        return { code: 1, stdout: "", stderr: "synthetic database failure" };
      return { code: 0, stdout: JSON.stringify([{ path }]), stderr: "" };
    });
    const fetcher = vi.fn(async () => {
      if (failure === "storage-network")
        throw new TypeError("synthetic transport failure");
      return new Response(null, {
        status: failure === "storage-http" ? 503 : 200,
      });
    });
    try {
      await expect(
        cleanupSaves(
          { workdir: root, local: true },
          {
            run,
            fetcher,
            log: () => {},
            confirm: async () => "",
            interactive: false,
          },
        ),
      ).rejects.toThrow(/retry|retained|failed/i);
      expect(
        calls.some((a) => a.some((s) => s.includes("prepare_save_cleanup"))),
      ).toBe(true);
      expect(
        calls.some((a) => a.some((s) => s.includes("finish_save_cleanup"))),
      ).toBe(failure === "database-ack");
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(
        calls.some((a) =>
          a.some((s) => s.includes("delete from storage.objects")),
        ),
      ).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it("upgrades an installed 0.1.2 Cloud Saves module additively, preserving old SQL and unrelated files", () => {
  const root = project();
  initialized(root);
  try {
    expect(cli(root, "add", "cloud-saves").status).toBe(0);
    const inventory = currentInventory(templateFiles()),
      value = manifest(root);
    for (const module of ["core", "leaderboards", "cloud-saves"] as const) {
      const old = releaseFor(inventory, module, "0.1.2");
      value.modules[module] = "0.1.2";
      for (const file of [...old.migrations, ...old.assets])
        put(root, file.path, file.content.toString());
    }
    put(root, "supagame.config.json", JSON.stringify(value));
    unlinkSync(
      join(root, "supabase/migrations/20261110000306_save_revisions.sql"),
    );
    put(root, "notes.txt", "unrelated");
    const before = snapshot(root);
    const preview = cli(root, "upgrade", "--dry-run");
    expect(preview.status, preview.stderr).toBe(0);
    expect(snapshot(root)).toEqual(before);
    const result = cli(root, "upgrade");
    expect(result.status, result.stderr).toBe(0);
    expect(manifest(root).modules["cloud-saves"]).toBe("0.1.3");
    const after = snapshot(root);
    for (const [path, content] of Object.entries(before))
      if (path.includes("/migrations/") || path === "notes.txt")
        expect(after[path]).toEqual(content);
    expect(
      readFileSync(
        join(root, "supabase/migrations/20261110000306_save_revisions.sql"),
        "utf8",
      ),
    ).toContain("create table sg_private.save_revisions");
    expect(cli(root, "upgrade").status).toBe(0);
    expect(snapshot(root)).toEqual(after);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);
import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { put } from "./project-fixture.ts";
import {
  currentInventory,
  releaseFor,
} from "../../packages/cli/src/lib/versions.ts";
import { templateFiles } from "../../packages/cli/src/lib/templates.ts";
