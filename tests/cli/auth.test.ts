import { it, expect, vi, afterEach } from "vitest";
import { rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  configureAuth,
  authReadiness,
} from "../../packages/cli/src/commands/auth.ts";
import { project, initialized, ref } from "./project-fixture.ts";
const roots: string[] = [];
afterEach(() =>
  roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })),
);
function fixture() {
  const root = project(true);
  roots.push(root);
  initialized(root);
  return root;
}
it("reports provider/manual linking/redirect readiness independently of CORS", () => {
  expect(
    authReadiness(
      {
        external_google_enabled: false,
        security_manual_linking_enabled: false,
        uri_allow_list: "",
      },
      ["https://game.example/"],
    ),
  ).toHaveLength(3);
  expect(
    authReadiness(
      {
        external_google_enabled: true,
        security_manual_linking_enabled: true,
        uri_allow_list: "https://game.example/,https://game.example/\\?**",
      },
      ["https://game.example/"],
    ),
  ).toEqual([]);
});
it("patches only scoped auth fields after explicit target confirmation", async () => {
  const root = fixture(),
    requests: { method: string; body?: string }[] = [],
    logs: string[] = [];
  let config = {
    external_google_enabled: true,
    security_manual_linking_enabled: false,
    uri_allow_list: "https://old.example/**",
    site_url: "https://old.example",
    secret: "do-not-log",
  };
  const fetcher = vi.fn(async (_url, init) => {
    requests.push({ method: init.method, body: init.body });
    if (init.method === "PATCH")
      config = { ...config, ...JSON.parse(init.body) };
    return Response.json(config);
  });
  await configureAuth(
    {
      workdir: root,
      projectRef: ref,
      remote: true,
      redirect: ["https://game.example/"],
      allowRemote: true,
    },
    {
      fetch: fetcher,
      env: { SUPABASE_ACCESS_TOKEN: "private" },
      log: (s) => logs.push(s),
      confirm: async () => "",
      interactive: false,
    },
  );
  const patch = JSON.parse(requests.find((r) => r.method === "PATCH")!.body!);
  expect(patch).toEqual({
    security_manual_linking_enabled: true,
    uri_allow_list:
      "https://old.example/**,https://game.example/,https://game.example/\\?**",
  });
  expect(logs.join(" ")).not.toMatch(/private|do-not-log/);
});
it("declined or unattended confirmation makes no hosted writes", async () => {
  const root = fixture(),
    fetcher = vi.fn(async () =>
      Response.json({
        security_manual_linking_enabled: false,
        uri_allow_list: "",
      }),
    );
  await expect(
    configureAuth(
      {
        workdir: root,
        projectRef: ref,
        remote: true,
        redirect: ["https://game.example/"],
      },
      {
        fetch: fetcher,
        env: { SUPABASE_ACCESS_TOKEN: "private" },
        log: () => {},
        confirm: async () => "no",
        interactive: true,
      },
    ),
  ).rejects.toThrow("cancelled");
  expect(
    fetcher.mock.calls.every(
      (c) => (c as unknown as [string, { method: string }])[1].method === "GET",
    ),
  ).toBe(true);
});
it("local configuration preserves unrelated values and rejects insecure LAN redirects", async () => {
  const root = fixture();
  await configureAuth({
    workdir: root,
    local: true,
    redirect: ["http://localhost:5173/"],
  });
  const text = readFileSync(join(root, "supabase/config.toml"), "utf8");
  expect(text).toContain("enable_manual_linking = true");
  expect(text).toContain("http://localhost:5173/");
  await expect(
    configureAuth({
      workdir: root,
      local: true,
      redirect: ["http://192.168.1.20:5173/"],
    }),
  ).rejects.toThrow("HTTPS");
});
it("allowlists callback query state without widening the hostname or path", async () => {
  const root = fixture();
  await configureAuth({
    workdir: root,
    local: true,
    redirect: ["http://localhost:5173/auth/callback"],
    enableGoogle: true,
  });
  const text = readFileSync(join(root, "supabase/config.toml"), "utf8");
  expect(text).toContain("callback");
  const { createRequire } = await import("node:module");
  const { parse } = createRequire(
    new URL("../../packages/cli/package.json", import.meta.url),
  )("smol-toml");
  const parsed = parse(text);
  expect(parsed.auth.additional_redirect_urls).toContain(
    "http://localhost:5173/auth/callback\\?**",
  );
  expect(parsed.auth.external.google.secret).toBe("env(GOOGLE_CLIENT_SECRET)");
});
