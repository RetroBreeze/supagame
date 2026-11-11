import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { readFileSync } from "node:fs";
import { AdminFailure, type AdminService } from "../lib/admin-service.ts";
import { DashboardOperations, fields, readView } from "./operations.ts";
const token = () => randomBytes(32).toString("base64url");
function equal(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
async function body(req: IncomingMessage): Promise<unknown> {
  if (
    req.headers["content-type"] !== "application/json" ||
    req.headers["content-encoding"]
  ) {
    throw new AdminFailure(
      "INVALID_REQUEST",
      "Use application/json without compression.",
      415,
    );
  }
  if (Number(req.headers["content-length"] ?? 0) > 16384) {
    throw new AdminFailure("TOO_LARGE", "Request exceeds 16 KiB.", 413);
  }
  let total = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 16384) {
      throw new AdminFailure("TOO_LARGE", "Request exceeds 16 KiB.", 413);
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new AdminFailure("INVALID_REQUEST", "Malformed JSON.");
  }
}
export async function startDashboard(
  service: AdminService,
  options: { port: number; assets?: URL },
) {
  const assets = options.assets ??
    (import.meta.url.endsWith(".ts")
      ? new URL("../../dist/dashboard/", import.meta.url)
      : new URL("./", import.meta.url));
  const files = new Map<string, { data: Buffer; type: string }>();
  for (
    const [route, name, type] of [
      ["/", "index.html", "text/html; charset=utf-8"],
      ["/app.js", "app.js", "text/javascript; charset=utf-8"],
      ["/style.css", "style.css", "text/css; charset=utf-8"],
    ]
  ) {
    files.set(route!, {
      data: readFileSync(new URL(name!, assets)),
      type: type!,
    });
  }
  let launchCode = token(),
    closing = false,
    active = 0,
    failures = 0,
    resetAt = Date.now() + 60000;
  const sessions = new Map<
    string,
    { csrf: string; expires: number; operations: DashboardOperations }
  >();
  let port = options.port;
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    let entered = false;
    try {
      if (closing) {
        throw new AdminFailure(
          "SESSION_CLOSED",
          "Dashboard is shutting down.",
          401,
        );
      }
      for (
        const name of ["host", "origin", "authorization", "x-supagame-csrf"]
      ) {
        if (
          req.rawHeaders.filter((v, i) =>
            i % 2 === 0 && v.toLowerCase() === name
          ).length > 1
        ) {
          throw new AdminFailure(
            "INVALID_REQUEST",
            "Duplicate security headers.",
            400,
          );
        }
      }
      const host = req.headers.host;
      if (
        ![
          `127.0.0.1:${port}`,
          `localhost:${port}`,
          ...(port === 80 ? ["127.0.0.1", "localhost"] : []),
        ].includes(host ?? "") || req.headers["x-forwarded-host"] ||
        req.headers.forwarded
      ) {
        throw new AdminFailure(
          "INVALID_HOST",
          "Untrusted dashboard address.",
          403,
        );
      }
      const origin = `http://${host}`;
      if (
        (req.headers.origin && req.headers.origin !== origin) ||
        ["cross-site", "same-site"].includes(
          String(req.headers["sec-fetch-site"]),
        )
      ) {
        throw new AdminFailure(
          "INVALID_ORIGIN",
          "Cross-origin requests are denied.",
          403,
        );
      }
      const path = req.url ?? "";
      if (files.has(path)) {
        if (req.method !== "GET") {
          throw new AdminFailure(
            "METHOD_NOT_ALLOWED",
            "Use GET for static files.",
            405,
          );
        }
        const file = files.get(path)!;
        res.setHeader("Content-Type", file.type);
        res.end(file.data);
        return;
      }
      if (
        !["/api/session", "/api/read", "/api/preview", "/api/execute"].includes(
          path,
        )
      ) throw new AdminFailure("NOT_FOUND", "Unknown route.", 404);
      if (req.method !== "POST") {
        throw new AdminFailure(
          "METHOD_NOT_ALLOWED",
          "Use POST for dashboard API requests.",
          405,
        );
      }
      if (req.headers.origin !== origin) {
        throw new AdminFailure(
          "INVALID_ORIGIN",
          "An exact same-origin request is required.",
          403,
        );
      }
      const bearer =
        req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1] ??
          "";
      let session = sessions.get(bearer);
      if (path === "/api/session") {
        if (Date.now() > resetAt) {
          failures = 0;
          resetAt = Date.now() + 60000;
        }
        if (failures >= 10) {
          throw new AdminFailure(
            "RATE_LIMITED",
            "Too many login attempts. Wait one minute.",
            429,
          );
        }
        if (!equal(bearer, launchCode)) {
          failures++;
          throw new AdminFailure("UNAUTHORIZED", "Invalid launch code.", 401);
        }
      } else {
        if (!session || session.expires < Date.now()) {
          sessions.delete(bearer);
          throw new AdminFailure(
            "UNAUTHORIZED",
            "Session missing or expired. Use the terminal launch code.",
            401,
          );
        }
        if (
          !equal(String(req.headers["x-supagame-csrf"] ?? ""), session.csrf)
        ) {
          throw new AdminFailure(
            "CSRF_DENIED",
            "Invalid CSRF protection.",
            403,
          );
        }
      }
      if (active >= 8) {
        throw new AdminFailure(
          "BUSY",
          "Dashboard is busy. Try again shortly.",
          429,
        );
      }
      active++;
      entered = true;
      const value = await body(req);
      let result: unknown;
      if (path === "/api/session") {
        fields(value, []);
        for (const [key, s] of sessions) {
          if (s.expires < Date.now()) sessions.delete(key);
        }
        if (sessions.size >= 8) {
          throw new AdminFailure(
            "BUSY",
            "Session limit reached. Restart the dashboard.",
            429,
          );
        }
        const key = token();
        session = {
          csrf: token(),
          expires: Date.now() + 8 * 3600000,
          operations: new DashboardOperations(service),
        };
        sessions.set(key, session);
        result = { session: key, csrf: session.csrf };
      } else if (path === "/api/read") result = await readView(service, value);
      else if (path === "/api/preview") {
        result = await session!.operations.preview(value);
      } else result = await session!.operations.execute(value);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(result));
    } catch (error) {
      const failure = error instanceof AdminFailure ? error : new AdminFailure(
        "INTERNAL_ERROR",
        "Request failed. Check the local operator connection; details withheld.",
        500,
      );
      res.statusCode = failure.status;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ code: failure.code, message: failure.message }));
    } finally {
      if (entered) active--;
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 1000;
  server.setTimeout(40000, (socket) => socket.destroy());
  server.maxHeadersCount = 32;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw Error("No loopback listener");
  }
  port = address.port;
  let closePromise: Promise<void> | undefined;
  return {
    url: `http://${address.address}:${port}`,
    launchCode,
    port,
    close() {
      if (closePromise) return closePromise;
      closing = true;
      launchCode = "";
      sessions.clear();
      service.close();
      closePromise = new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      return closePromise;
    },
  };
}
