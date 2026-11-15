import { expect, it } from "vitest";
import { interactive, Terminal } from "../../packages/cli/src/lib/terminal.ts";

it.each(
  [
    [true, true, {}, {}, true],
    [false, true, {}, {}, false],
    [true, false, {}, {}, false],
    [true, true, { CI: "true" }, {}, false],
    [true, true, {}, { interactive: false }, false],
    [true, true, {}, { json: true }, false],
  ] as const,
)(
  "gates interaction by both streams, CI and explicit options (%s/%s)",
  (input, output, env, options, expected) => {
    expect(interactive(options, { input, output, env })).toBe(expected);
  },
);
it("emits one parseable JSON document with structured events and no terminal control sequences", () => {
  let output = "";
  const terminal = new Terminal(
    { json: true },
    (s) => {
      output += s;
    },
    true,
    {},
  );
  terminal.heading("INIT");
  terminal.event({ kind: "warning", message: "Cannot verify delivery" });
  terminal.event({
    kind: "file",
    status: "create",
    path: "supagame.config.json",
  });
  expect(output).toBe("");
  terminal.finish("init", { projectRef: "abcdefghijklmnopqrst" });
  expect(JSON.parse(output)).toMatchObject({
    schemaVersion: 1,
    command: "init",
    ok: true,
    result: { projectRef: "abcdefghijklmnopqrst" },
    events: expect.arrayContaining([{
      kind: "warning",
      message: "Cannot verify delivery",
    }]),
  });
  expect(output).not.toContain("\u001b");
});
it.each([[false, {}], [true, { NO_COLOR: "" }], [true, { CI: "1" }]] as const)(
  "keeps redirected, colour-disabled and CI output plain",
  (tty, env) => {
    let output = "";
    const terminal = new Terminal(
      {},
      (s) => {
        output += s;
      },
      tty,
      env,
    );
    terminal.heading("DEPLOY");
    terminal.values({ Project: "Arcade", Destination: "abcdefghijklmnopqrst" });
    terminal.event({ kind: "warning", message: "Cannot verify runtime" });
    terminal.event({ kind: "info", message: "Untrusted\u001b[2Jname\rspoof" });
    expect(output).not.toContain(String.fromCharCode(27));
    expect(output).not.toContain("\r");
    expect(output).toContain("Cannot verify runtime");
    expect(output).toContain("abcdefghijklmnopqrst");
  },
);
