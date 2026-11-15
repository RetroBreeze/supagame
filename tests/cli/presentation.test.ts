import { expect, it } from "vitest";
import { Terminal } from "../../packages/cli/src/lib/terminal.ts";
import {
  deploymentPreview,
  diagnosticSummary,
} from "../../packages/cli/src/lib/presentation.ts";
it("summarizes healthy file checks while retaining every diagnostic in JSON and all warnings in text", () => {
  const findings = [{
    scope: "local" as const,
    id: "file:one",
    status: "healthy" as const,
    message: "one matches",
  }, {
    scope: "remote" as const,
    id: "realtime",
    status: "cannot verify" as const,
    message: "Runtime delivery requires verification",
  }];
  let text = "";
  const terminal = new Terminal({}, (s) => {
    text += s;
  }, false);
  diagnosticSummary(terminal, findings);
  expect(text).toContain("1 installed files verified");
  expect(text).toContain("Runtime delivery requires verification");
  expect(text).not.toContain("one matches");
  let json = "";
  const machine = new Terminal({ json: true }, (s) => {
    json += s;
  }, false);
  diagnosticSummary(machine, findings);
  machine.finish("doctor");
  expect(JSON.parse(json).result.findings).toEqual(findings);
});
it("deploy preview always exposes destination, all pending migrations and configuration limitations", () => {
  let output = "";
  const terminal = new Terminal({}, (s) => {
    output += s;
  }, false);
  deploymentPreview(terminal, {
    projectRef: "abcdefghijklmnopqrst",
    modules: { leaderboards: "0.1.0" },
    applied: ["20261108000100"],
    pending: [{
      name: "20261108000200_unrelated.sql",
      hash: "a".repeat(64),
      owned: false,
    }],
    functionAction: "unchanged",
    functionHash: "b".repeat(64),
    configuration: {
      anonymous: true,
      authBlockers: ["Captcha needs review"],
      originDigest: null,
      realtimeConfig: false,
      projectName: "Arcade",
    },
    originAction: "unmanaged",
    origins: undefined,
    live: true,
    realtimeIssues: [],
    realtime: {
      status: "cannot verify",
      message: "Service health is unverified",
    },
  });
  expect(output).toContain("abcdefghijklmnopqrst");
  expect(output).toContain("20261108000200_unrelated.sql");
  expect(output).toContain("UNRELATED");
  expect(output).toContain("Captcha needs review");
  expect(output).toContain("Service health is unverified");
  expect(output).toMatch(/WebSocket/);
  expect(output).not.toContain("a".repeat(64));
  expect(terminal.result).toMatchObject({
    pending: [{ hash: "a".repeat(64) }],
  });
});
