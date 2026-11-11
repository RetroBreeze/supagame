import { dashboardAssets } from "./dashboard-assets.ts";
import { request } from "node:http";
import { afterAll, afterEach, expect, it } from "vitest";
import { startDashboard } from "../../packages/cli/src/dashboard/server.ts";
import type { AdminService } from "../../packages/cli/src/lib/admin-service.ts";
const assets = dashboardAssets();
afterAll(() => assets.remove());
const servers: Awaited<ReturnType<typeof startDashboard>>[] = [];
const service = (): AdminService => ({
  target: {
    root: "/test",
    ref: "abcdefghijklmnopqrst",
    name: "Test game",
    environment: "local",
    modules: { admin: "0.1.4" },
    connection: { projectId: "test", port: 54322 },
    fingerprint: "test",
  },
  verify: async () => [],
  query: async () => [{ result: { revision: 0, id: "board" } }],
  execute: async () => [{ result: { generation: 2 } }],
  revalidate: () => {},
  close: () => {},
});
async function fixture() {
  const s = await startDashboard(service(), { port: 0, assets: assets.url });
  servers.push(s);
  return s;
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});
it("binds loopback and requires a launch secret; rejects foreign origin and host", async () => {
  const s = await fixture();
  expect(s.url).toMatch(/^http:\/\/127.0.0.1:/);
  expect(
    (await fetch(s.url + "/api/read", {
      method: "POST",
      headers: { origin: s.url, "content-type": "application/json" },
      body: "{}",
    })).status,
  ).toBe(401);
  expect(
    (await fetch(s.url + "/api/session", {
      method: "POST",
      headers: {
        origin: "https://evil.example",
        "content-type": "application/json",
        authorization: `Bearer ${s.launchCode}`,
      },
      body: "{}",
    })).status,
  ).toBe(403);
  const hostStatus = await new Promise((resolve) => {
    const req = request(s.url, { headers: { host: "evil.example" } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.end();
  });
  expect(hostStatus).toBe(403);
});
it("requires CSRF, rejects project injection and executes only a confirmed server preview", async () => {
  const s = await fixture();
  const login = await fetch(s.url + "/api/session", {
    method: "POST",
    headers: {
      origin: s.url,
      "content-type": "application/json",
      authorization: `Bearer ${s.launchCode}`,
    },
    body: "{}",
  });
  expect(login.status).toBe(200);
  const auth = await login.json();
  const headers = {
    origin: s.url,
    "content-type": "application/json",
    authorization: `Bearer ${auth.session}`,
    "x-supagame-csrf": auth.csrf,
  };
  expect(
    (await fetch(s.url + "/api/read", {
      method: "POST",
      headers: { ...headers, "x-supagame-csrf": "wrong" },
      body: "{}",
    })).status,
  ).toBe(403);
  expect(
    (await fetch(s.url + "/api/read", {
      method: "POST",
      headers,
      body: JSON.stringify({ view: "overview", projectRef: "other" }),
    })).status,
  ).toBe(400);
  const preview = await (await fetch(s.url + "/api/preview", {
    method: "POST",
    headers,
    body: JSON.stringify({ action: "leaderboard.reset", target: "board" }),
  })).json();
  expect(
    (await fetch(s.url + "/api/execute", {
      method: "POST",
      headers,
      body: JSON.stringify({
        previewId: preview.id,
        reason: "new season",
        confirmation: "wrong",
      }),
    })).status,
  ).toBe(400);
  const result = await fetch(s.url + "/api/execute", {
    method: "POST",
    headers,
    body: JSON.stringify({
      previewId: preview.id,
      reason: "new season",
      confirmation: "board",
    }),
  });
  expect(result.status).toBe(200);
  expect((await result.json()).result.generation).toBe(2);
});
it("rejects oversized bodies, unexpected methods and routes", async () => {
  const s = await fixture();
  expect(
    (await fetch(s.url + "/api/session", {
      method: "POST",
      headers: {
        origin: s.url,
        "content-type": "application/json",
        authorization: `Bearer ${s.launchCode}`,
      },
      body: JSON.stringify({ padding: "x".repeat(17000) }),
    })).status,
  ).toBe(413);
  expect((await fetch(s.url + "/api/read")).status).toBe(405);
  expect((await fetch(s.url + "/missing")).status).toBe(404);
});
async function authenticated(s: Awaited<ReturnType<typeof fixture>>) {
  const r = await fetch(s.url + "/api/session", {
    method: "POST",
    headers: {
      origin: s.url,
      "content-type": "application/json",
      authorization: `Bearer ${s.launchCode}`,
    },
    body: "{}",
  });
  const a = await r.json();
  return {
    origin: s.url,
    "content-type": "application/json",
    authorization: `Bearer ${a.session}`,
    "x-supagame-csrf": a.csrf,
  };
}
it("rejects missing origin, null origin, same-site attacks, form posts and preflights", async () => {
  const s = await fixture();
  const headers = await authenticated(s);
  for (
    const change of [{ origin: "" }, { origin: "null" }, {
      "sec-fetch-site": "same-site",
    }, { "content-type": "text/plain" }]
  ) {
    expect(
      (await fetch(s.url + "/api/read", {
        method: "POST",
        headers: { ...headers, ...change },
        body: JSON.stringify({ view: "overview" }),
      })).status,
    ).toBeGreaterThanOrEqual(400);
  }
  expect(
    (await fetch(s.url + "/api/read", {
      method: "OPTIONS",
      headers: { origin: "https://evil.example" },
    })).headers.has("access-control-allow-origin"),
  ).toBe(false);
});
it("rejects malformed JSON, invalid bearer and every browser-controlled connection field", async () => {
  const s = await fixture();
  const headers = await authenticated(s);
  expect(
    (await fetch(s.url + "/api/read", { method: "POST", headers, body: "{" }))
      .status,
  ).toBe(400);
  expect(
    (await fetch(s.url + "/api/read", {
      method: "POST",
      headers: { ...headers, authorization: "Bearer invalid" },
      body: "{}",
    })).status,
  ).toBe(401);
  for (
    const key of [
      "projectRef",
      "workdir",
      "connection",
      "sql",
      "remote",
      "local",
    ]
  ) {
    expect(
      (await fetch(s.url + "/api/read", {
        method: "POST",
        headers,
        body: JSON.stringify({ view: "boards", [key]: "attacker" }),
      })).status,
    ).toBe(400);
  }
});
it("static shell has strict security headers and no authentication capability", async () => {
  const s = await fixture();
  const response = await fetch(s.url);
  const html = await response.text();
  expect(html).not.toContain(s.launchCode);
  expect(html).not.toContain("abcdefghijklmnopqrst");
  expect(response.headers.get("content-security-policy")).toContain(
    "frame-ancestors 'none'",
  );
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.has("set-cookie")).toBe(false);
});
it("session capabilities are different per launch and cannot authorize another server", async () => {
  const first = await fixture(), second = await fixture();
  expect(first.launchCode).not.toBe(second.launchCode);
  const headers = await authenticated(first);
  expect(
    (await fetch(second.url + "/api/read", {
      method: "POST",
      headers: { ...headers, origin: second.url },
      body: '{"view":"boards"}',
    })).status,
  ).toBe(401);
});
it("does not change operation IDs, accepts exact retries, rejects changed reasons", async () => {
  let writes = 0;
  const backend = service();
  backend.execute = async () => {
    writes++;
    return [{ result: { generation: 2 } }];
  };
  const s = await startDashboard(backend, { port: 0, assets: assets.url });
  servers.push(s);
  const headers = await authenticated(s);
  const post = (route: string, body: unknown) =>
    fetch(s.url + route, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  const p = await (await post("/api/preview", {
    action: "leaderboard.reset",
    target: "board",
  })).json();
  const payload = { previewId: p.id, reason: "season", confirmation: "board" };
  expect((await post("/api/execute", payload)).status).toBe(200);
  expect((await (await post("/api/execute", payload)).json()).replayed).toBe(
    true,
  );
  expect(writes).toBe(1);
  expect(
    (await post("/api/execute", { ...payload, reason: "different" })).status,
  ).toBe(409);
});
it("reports port conflicts and invalidates sessions on shutdown", async () => {
  const s = await fixture();
  await expect(startDashboard(service(), { port: s.port, assets: assets.url }))
    .rejects.toMatchObject({ code: "EADDRINUSE" });
  await s.close();
  await expect(fetch(s.url)).rejects.toThrow();
});
it("rejects cross-session previews and unknown or invalid operations", async () => {
  const s = await fixture(),
    headers = await authenticated(s),
    other = await authenticated(s);
  const post = (h: typeof headers, path: string, data: unknown) =>
    fetch(s.url + path, {
      method: "POST",
      headers: h,
      body: JSON.stringify(data),
    });
  const p = await (await post(headers, "/api/preview", {
    action: "leaderboard.reset",
    target: "board",
  })).json();
  expect(
    (await post(other, "/api/execute", {
      previewId: p.id,
      reason: "season",
      confirmation: "board",
    })).status,
  ).toBe(409);
  for (
    const data of [
      { action: "sql.execute", target: "board" },
      { action: "leaderboard.reset", target: "board';drop table x" },
      { action: "player.restrict", target: "not-a-uuid" },
      { action: "leaderboard.reset", target: "board", revision: 0 },
    ]
  ) expect((await post(headers, "/api/preview", data)).status).toBe(400);
});
it("sanitizes unexpected backend failures without returning credentials", async () => {
  const backend = service();
  backend.query = async () => {
    throw Error("SUPABASE_ACCESS_TOKEN=private-test-secret");
  };
  const s = await startDashboard(backend, { port: 0, assets: assets.url });
  servers.push(s);
  const headers = await authenticated(s);
  const response = await fetch(s.url + "/api/read", {
    method: "POST",
    headers,
    body: '{"view":"boards"}',
  });
  expect(response.status).toBe(500);
  expect(await response.text()).not.toContain("private-test-secret");
});
it("never runs a new operation while the same operation is in progress", async () => {
  let release: () => void = () => {};
  let writes = 0;
  const backend = service();
  backend.execute = async () => {
    writes++;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return [{ result: { generation: 2 } }];
  };
  const s = await startDashboard(backend, { port: 0, assets: assets.url });
  servers.push(s);
  const headers = await authenticated(s);
  const p = await (await fetch(s.url + "/api/preview", {
    method: "POST",
    headers,
    body: '{"action":"leaderboard.reset","target":"board"}',
  })).json();
  const request = () =>
    fetch(s.url + "/api/execute", {
      method: "POST",
      headers,
      body: JSON.stringify({
        previewId: p.id,
        reason: "new",
        confirmation: "board",
      }),
    });
  const first = request();
  while (!writes) await new Promise((resolve) => setTimeout(resolve, 5));
  expect((await request()).status).toBe(409);
  release();
  expect((await first).status).toBe(200);
  expect(writes).toBe(1);
});
