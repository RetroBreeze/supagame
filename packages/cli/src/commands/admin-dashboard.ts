import {
  type AdminTargetOptions,
  openAdminService,
} from "../lib/admin-service.ts";
import { createSupabaseRunner } from "../lib/supabase-cli.ts";
import { startDashboard } from "../dashboard/server.ts";
export async function dashboard(
  options: AdminTargetOptions & { port?: string },
) {
  const port = options.port === undefined ? 4173 : Number(options.port);
  if (
    !/^\d+$/.test(options.port ?? "4173") || !Number.isInteger(port) ||
    port < 1 || port > 65535
  ) throw new Error("Port must be an integer between 1 and 65535.");
  const controller = new AbortController();
  let server: Awaited<ReturnType<typeof startDashboard>> | undefined;
  let service: Awaited<ReturnType<typeof openAdminService>> | undefined;
  let stopped = false;
  const stop = () => {
    stopped = true;
    controller.abort();
    void server?.close();
    if (!server) service?.close();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    service = await openAdminService(
      options,
      createSupabaseRunner(30000, controller.signal),
    );
    await service.verify();
    if (stopped) return;
    server = await startDashboard(service, { port });
    console.log(
      `Supagame Admin — ${service.target.name} | ${service.target.ref} | ${service.target.environment.toUpperCase()}`,
    );
    console.log(
      `Dashboard: ${server.url}\nLaunch code (keep private): ${server.launchCode}`,
    );
    console.log(
      `SSH forwarding: ssh -L ${server.port}:127.0.0.1:${server.port} <user>@<server>\nThen open http://localhost:${server.port} and enter the launch code. Loopback only; press Ctrl+C to stop.`,
    );
    await new Promise<void>((resolve) => {
      if (stopped) {
        resolve();
        return;
      }
      const done = () => resolve();
      process.once("SIGINT", done);
      process.once("SIGTERM", done);
      // Cleanup after either signal removes the companion listener too.
      const cleanup = () => {
        process.off("SIGINT", done);
        process.off("SIGTERM", done);
      };
      controller.signal.addEventListener("abort", () => {
        cleanup();
        resolve();
      }, { once: true });
    });
  } catch (error) {
    if (stopped) return;
    if (
      error && typeof error === "object" && "code" in error &&
      error.code === "EADDRINUSE"
    ) {
      throw new Error(`Port ${port} is already in use. Choose --port <port>.`, {
        cause: error,
      });
    }
    throw error;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    controller.abort();
    await server?.close();
    service?.close();
  }
}
