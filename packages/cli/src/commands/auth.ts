import { stringify } from "smol-toml";
import { createInterface } from "node:readline/promises";
import { readProject, selectedRef, type LocalOptions } from "../lib/project.ts";
import { readManifest, object } from "../lib/manifest.ts";
import { executePlan, planFiles } from "../lib/file-stage.ts";
export interface AuthOptions extends LocalOptions {
  local?: boolean;
  remote?: boolean;
  redirect?: string[];
  siteUrl?: string;
  allowRemote?: boolean;
  enableGoogle?: boolean;
  doctor?: boolean;
}
interface Dependencies {
  fetch: typeof fetch;
  env: NodeJS.ProcessEnv;
  log: (s: string) => void;
  interactive: boolean;
  confirm: (ref: string) => Promise<string>;
}
function defaults(): Dependencies {
  return {
    fetch: globalThis.fetch,
    env: process.env,
    log: console.log,
    interactive: !!(
      process.stdin.isTTY &&
      process.stdout.isTTY &&
      !process.env.CI
    ),
    async confirm(ref) {
      const p = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      try {
        return await p.question(
          `Type "auth ${ref}" to authorize these Auth changes: `,
        );
      } finally {
        p.close();
      }
    },
  };
}
function redirect(value: string) {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw Error("Use an absolute HTTPS redirect URL.");
  }
  if (
    value !== value.trim() ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    value.includes("*") ||
    (u.protocol !== "https:" &&
      !(
        u.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)
      ))
  )
    throw Error(
      "Use HTTPS redirect URLs (HTTP only on localhost), without wildcards, query, credentials or fragments.",
    );
  return u.href;
}
/** Exact callback path plus a query-only glob for SDK/Supabase flow identifiers. */
function callbackPatterns(url: string): string[] {
  const literal = url.replace(/[\\*?[\]{}]/g, "\\$&");
  return [literal, `${literal}\\?**`];
}
export function authReadiness(config: Record<string, unknown>, urls: string[]) {
  const issues: string[] = [];
  if (config.external_google_enabled !== true)
    issues.push(
      "Enable Google in Auth providers and configure its OAuth Client ID and Client Secret.",
    );
  if (config.security_manual_linking_enabled !== true)
    issues.push("Enable manual identity linking in Auth settings.");
  const allowed = String(config.uri_allow_list ?? "").split(",");
  for (const u of urls)
    if (!callbackPatterns(u).every((p) => allowed.includes(p)))
      issues.push(
        `Add exact Auth redirect ${u} (existing wildcard rules require manual review).`,
      );
  return issues;
}
/** Supported Management API only. Never print raw responses: Auth config may contain secrets. */
export async function configureAuth(
  options: AuthOptions,
  deps = defaults(),
): Promise<void> {
  const { root, bytes, config } = readProject(options);
  if (!!options.local === !!options.remote)
    throw Error("Choose exactly one of --local or --remote.");
  if (options.dryRun && options.allowRemote)
    throw Error("Choose preview or explicit hosted authorization, not both.");
  const urls = (options.redirect ?? []).map(redirect),
    site = options.siteUrl ? redirect(options.siteUrl) : undefined;
  if (options.local) {
    const auth = object(config.auth) ? config.auth : {};
    if (options.doctor) {
      deps.log(
        `Local manual linking: ${auth.enable_manual_linking === true ? "enabled" : "enable auth.enable_manual_linking"}`,
      );
      deps.log(
        "Google requires auth.external.google with enabled=true, client_id and secret from env(GOOGLE_CLIENT_SECRET). Hosted settings are separate.",
      );
      return;
    }
    const next = {
      ...config,
      auth: {
        ...auth,
        enable_manual_linking: true,
        additional_redirect_urls: [
          ...new Set([
            ...(Array.isArray(auth.additional_redirect_urls)
              ? auth.additional_redirect_urls
              : []),
            ...urls.flatMap(callbackPatterns),
          ]),
        ],
        ...(site ? { site_url: site } : {}),
        ...(options.enableGoogle
          ? {
              external: {
                ...(object(auth.external) ? auth.external : {}),
                google: {
                  ...(object(auth.external) && object(auth.external.google)
                    ? auth.external.google
                    : {}),
                  enabled: true,
                  client_id: "env(GOOGLE_CLIENT_ID)",
                  secret: "env(GOOGLE_CLIENT_SECRET)",
                },
              },
            }
          : {}),
      },
    };
    executePlan(
      root,
      planFiles(root, [
        {
          path: "supabase/config.toml",
          content: Buffer.from(
            stringify(next as Parameters<typeof stringify>[0]),
          ),
          replace: bytes,
        },
      ]),
      options.dryRun ?? false,
    );
    deps.log(
      "Local Auth redirects and manual linking configured. Set auth.external.google enabled/client_id/secret using environment references; restart the local stack. CORS origins are configured separately.",
    );
    return;
  }
  if (!options.projectRef)
    throw Error("An explicit --project-ref is required.");
  const ref = selectedRef(
    root,
    options.projectRef,
    readManifest(root)?.value.projectRef,
  );
  const token = deps.env.SUPABASE_ACCESS_TOKEN;
  if (!token)
    throw Error(
      "Set SUPABASE_ACCESS_TOKEN in the environment for read-only preview or explicitly authorized configuration. Never commit it.",
    );
  const request = async (method: string, body?: Record<string, unknown>) => {
    try {
      const r = await deps.fetch(
        `https://api.supabase.com/v1/projects/${ref}/config/auth`,
        {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          redirect: "error",
          signal: AbortSignal.timeout(15000),
          ...(body ? { body: JSON.stringify(body) } : {}),
        },
      );
      if (!r.ok) throw Error();
      const data: unknown = await r.json();
      if (!object(data)) throw Error();
      return data;
    } catch {
      throw Error(
        "Auth configuration unavailable. Check Management API permissions and connectivity; response details are withheld.",
      );
    }
  };
  const before = await request("GET");
  deps.log(
    `Auth project: ${ref}. Google callback: https://${ref}.supabase.co/auth/v1/callback`,
  );
  if (options.doctor) {
    const issues = authReadiness(before, urls);
    for (const s of issues) deps.log(`ACTION REQUIRED: ${s}`);
    if (!issues.length)
      deps.log(
        "Google enabled; manual linking enabled; requested exact redirects present. Test real OAuth to verify credentials.",
      );
    return;
  }
  const patch: Record<string, unknown> = {
    security_manual_linking_enabled: true,
    uri_allow_list: [
      ...new Set([
        ...String(before.uri_allow_list ?? "")
          .split(",")
          .filter(Boolean),
        ...urls.flatMap(callbackPatterns),
      ]),
    ].join(","),
  };
  if (site) patch.site_url = site;
  if (options.enableGoogle) {
    const id = deps.env.GOOGLE_CLIENT_ID,
      secret = deps.env.GOOGLE_CLIENT_SECRET;
    if (!id || !secret)
      throw Error(
        "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in environment before --enable-google. Create them in Google Cloud first.",
      );
    Object.assign(patch, {
      external_google_enabled: true,
      external_google_client_id: id,
      external_google_secret: secret,
    });
  }
  deps.log(
    `Preview: manual linking enabled; Auth redirects ${String(patch.uri_allow_list)}${site ? `; site URL ${site}` : ""}${options.enableGoogle ? "; Google provider credentials supplied via environment (redacted)" : ""}. Unrelated Auth settings preserved. CORS is separate.`,
  );
  if (options.dryRun) return;
  if (
    !options.allowRemote &&
    (!deps.interactive || (await deps.confirm(ref)) !== `auth ${ref}`)
  )
    throw Error("Auth configuration cancelled; no hosted settings changed.");
  const fresh = await request("GET");
  if (Object.keys(patch).some((k) => fresh[k] !== before[k]))
    throw Error(
      "Hosted Auth settings changed after preview. Review a fresh plan.",
    );
  await request("PATCH", patch);
  const after = await request("GET");
  if (
    Object.keys(patch)
      .filter(
        (k) =>
          !["external_google_secret", "external_google_client_id"].includes(k),
      )
      .some((k) => after[k] !== patch[k])
  )
    throw Error("Auth update could not be verified; inspect before retrying.");
  deps.log(
    "Auth configuration verified. Google credentials require a real OAuth test.",
  );
}
