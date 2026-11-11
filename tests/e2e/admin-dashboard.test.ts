import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { startDashboard } from "../../packages/cli/src/dashboard/server.ts";
import {
  AdminFailure,
  type AdminService,
} from "../../packages/cli/src/lib/admin-service.ts";
import type { AdminOperation } from "../../packages/cli/src/lib/admin.ts";
test("dashboard browser: identity, XSS escaping, confirmation, unknown outcome and exact retry", async () => {
  const operations: AdminOperation[] = [];
  let releaseOverview: () => void = () => {};
  const overviewReady = new Promise<void>(resolve => { releaseOverview = resolve; });
  let generation = 1;
  let applied = false;
  const board = {
    id: "arcade",
    kind: "points",
    sort_direction: "desc",
    enabled: true,
    generation: 1,
    admin_revision: 0,
    active_players: 2,
    submissions: 2,
  };
  const hostile = "<img src=x onerror=alert(1)>";
  const service: AdminService = {
    target: {
      root: "/test",
      ref: "abcdefghijklmnopqrst",
      name: "Synthetic game",
      environment: "hosted",
      modules: { admin: "0.1.4", core: "0.1.4", leaderboards: "0.1.4" },
      connection: {
        projectId: "synthetic",
        port: 54322,
        ref: "abcdefghijklmnopqrst",
      },
      fingerprint: "x",
    },
    verify: async () => [],
    revalidate: () => {},
    close: () => {},
    query: async (sql) => {
      if (sql.includes("to_jsonb(b)")) {
        return [{
          result: {
            ...board,
            generation,
            revision: generation - 1,
            activePlayers: 2,
            generations: [{ generation: 1, submissions: 2 }],
          },
        }];
      }
      if (sql.includes("as leaderboards")) {
        await overviewReady;
        return [{ leaderboards: 1, players: 2 }];
      }
      if (sql.includes("from sg_private.admin_audit")) {
        return [{
          created_at: "2026-11-11T12:00:00Z",
          action: "score.hide",
          target: "arcade",
          reason: hostile,
          actor: "postgres",
          outcome: "applied",
          operation_id: "test-operation",
        }];
      }
      if (sql.includes("select b.*")) return [{ ...board, generation }];
      if (sql.includes("from public.game_players p")) {
        return [{
          user_id: "90000000-0000-4000-8000-000000000001",
          display_name: hostile,
          restricted: false,
          revision: 0,
        }];
      }
      return [];
    },
    execute: async (input) => {
      operations.push(input);
      if (!applied) {
        generation++;
        applied = true;
        throw new AdminFailure(
          "OUTCOME_UNKNOWN",
          "Connection interrupted. Retry the same operation.",
          503,
        );
      }
      return [{ result: { ...board, generation } }];
    },
  };
  const server = await startDashboard(service, { port: 0 });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    await page.goto(server.url);
    assert.equal(await page.locator("#app").isVisible(), false);
    await page.getByLabel("Launch code", { exact: true }).fill(
      server.launchCode,
    );
    await page.getByRole("button", { name: "Unlock dashboard" }).click();
    await page.getByText("Loading…", { exact: true }).waitFor();
    releaseOverview();
    await page.getByText("Synthetic game", { exact: true }).waitFor();
    await page.getByRole("heading", { name: "Recent activity" }).waitFor();
    assert.equal(await page.locator("img").count(), 0);
    assert.ok(await page.getByText(hostile, { exact: true }).isVisible());
    assert.equal(
      await page.evaluate(() => localStorage.length + sessionStorage.length),
      0,
    );
    await page.screenshot({
      path: "/tmp/supagame-admin-dashboard.png",
      fullPage: true,
    });
    await page.getByRole("button", { name: "Leaderboards", exact: true })
      .click();
    await page.getByRole("button", { name: "Inspect", exact: true }).click();
    await page.getByRole("button", { name: "Preview reset", exact: true })
      .click();
    await page.locator("#operation-dialog").waitFor();
    assert.ok(
      await page.locator("#operation-project").innerText().then((x) =>
        x.includes("HOSTED") && x.includes("abcdefghijklmnopqrst")
      ),
    );
    assert.equal(await page.locator("#execute").isEnabled(), false);
    await page.getByLabel("Reason", { exact: false }).fill("New competition");
    await page.locator("#confirmation").fill("wrong");
    assert.equal(await page.locator("#execute").isEnabled(), false);
    await page.locator("#confirmation").fill("arcade");
    await page.locator("#execute").click();
    await page.getByRole("button", { name: "Retry same operation" }).waitFor();
    assert.equal(await page.locator("#operation-result").innerText(), "");
    await page.getByRole("button", { name: "Retry same operation" }).click();
    await page.getByText("Operation committed. Actual result:").waitFor();
    assert.equal(operations.length, 2);
    assert.deepEqual(operations[0], operations[1]);
    await page.getByRole("button", { name: "Close operation" }).click();
    await page.getByRole("button", { name: "Players", exact: true }).click();
    await page.getByText(hostile, { exact: true }).waitFor();
    assert.equal(await page.locator("img").count(), 0);
    await page.setViewportSize({ width: 900, height: 1000 });
    assert.ok(await page.getByRole("button", { name: "Audit log", exact: true }).isVisible());
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(
      await page.getByRole("button", { name: "Audit log", exact: true })
        .isVisible(),
    );
    await page.getByRole("button", { name: "Audit log", exact: true }).click();
    await page.getByText(hostile, { exact: true }).waitFor();
    await page.getByLabel("Filter recent activity").fill("nothing matches");
    await page.getByRole("button", { name: "Filter", exact: true }).click();
    await page.getByText("No records match this view.").waitFor();
  } finally {
    releaseOverview();
    await browser.close();
    await server.close();
  }
});
