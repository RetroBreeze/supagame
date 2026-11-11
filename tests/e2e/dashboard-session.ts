import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
export async function dashboardSession(
  cli: string,
  root: string,
  options: { remote?: boolean; env?: NodeJS.ProcessEnv } = {},
) {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  if (!address || typeof address === "string") throw Error("No test port");
  const port = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const child = spawn(cli, [
    "admin",
    "dashboard",
    options.remote ? "--remote" : "--local",
    "--port",
    String(port),
  ], { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: options.env ?? process.env });
  let output = "", exited = false;
  child.stdout.on("data", (b) => {
    output += b.toString();
  });
  child.stderr.resume();
  child.on("error", () => {
    exited = true;
  });
  const finished = new Promise<void>((resolve) =>
    child.on("exit", () => {
      exited = true;
      resolve();
    })
  );
  const close = async () => {
    if (!exited) child.kill("SIGTERM");
    await Promise.race([
      finished,
      delay(5000, undefined, {ref:false}).then(() => {
        if (!exited) {
          child.kill("SIGKILL");
          throw Error("Dashboard did not shut down cleanly");
        }
      }),
    ]);
  };
  try {
    const deadline = Date.now() + 30000;
    while (!output.includes("Launch code (keep private): ")) {
      if (exited || Date.now() > deadline) {
        throw Error(
          "Installed dashboard startup failed; process output withheld",
        );
      }
      await delay(30);
    }
    const launch = output.match(/Launch code \(keep private\): (\S+)/)?.[1];
    if (!launch) throw Error("Missing launch capability");
    output = "";
    const url = `http://127.0.0.1:${port}`;
    const login = await fetch(url + "/api/session", {
      method: "POST",
      headers: {
        origin: url,
        "content-type": "application/json",
        authorization: `Bearer ${launch}`,
      },
      body: "{}",
    });
    if (!login.ok) throw Error("Installed dashboard authentication failed");
    const auth = await login.json();
    const request = async (path: string, body: unknown) => {
      const response = await fetch(url + path, {
        method: "POST",
        headers: {
          origin: url,
          "content-type": "application/json",
          authorization: `Bearer ${auth.session}`,
          "x-supagame-csrf": auth.csrf,
        },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    };
    return { url, request, close };
  } catch (error) {
    await close();
    throw error;
  }
}
