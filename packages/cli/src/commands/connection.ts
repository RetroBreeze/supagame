import { type LocalOptions, selectedRef } from "../lib/project.ts";
import { executePlan, planFiles, projectRoot } from "../lib/file-stage.ts";
import { readManifest } from "../lib/manifest.ts";
import { connectionFile, connectionInfo } from "../lib/connection.ts";
import { SetupEnvironment } from "../lib/setup-environment.ts";
import { CliFailure } from "../lib/cli-error.ts";
import { type Prompts } from "../lib/prompts.ts";
import { currentTerminal } from "../lib/terminal.ts";

export interface ConnectionOptions extends LocalOptions {
  output?: string;
  replace?: boolean;
  keyId?: string;
  url?: string;
}
export async function resolveConnection(
  ref: string,
  options: Pick<ConnectionOptions, "keyId" | "url">,
  environment: SetupEnvironment,
  prompts?: Prompts,
) {
  const keys = await environment.keys(ref);
  const id = options.keyId ??
    (keys.length === 1 ? keys[0]!.id : prompts
      ? await prompts.select(
        "Public client key",
        keys.map((k) => ({ value: k.id, label: k.name })),
      )
      : undefined);
  const key = keys.find((k) => k.id === id);
  if (!key) {
    throw new CliFailure(
      "validation",
      "SELECT_PUBLIC_KEY",
      "Select a valid public key with --key-id; multiple public keys require an explicit choice.",
    );
  }
  const canonical = `https://${ref}.supabase.co`;
  const custom = options.url && options.url.replace(/\/$/, "") !== canonical
    ? await environment.customDomain(ref)
    : undefined;
  return connectionInfo(ref, key.key, options.url, custom);
}
export async function connection(
  options: ConnectionOptions,
  prompts?: Prompts,
  environment = new SetupEnvironment(),
) {
  const root = projectRoot(options.workdir ?? process.cwd());
  const ref = selectedRef(
    root,
    options.projectRef,
    readManifest(root)?.value.projectRef,
  );
  await environment.check();
  currentTerminal()?.event({
    kind: "progress",
    message: "Reading public connection information…",
  });
  const info = await resolveConnection(ref, options, environment, prompts);
  selectedRef(root, ref, readManifest(root)?.value.projectRef);
  const terminal = currentTerminal();
  if (terminal) {
    terminal.result = info;
    terminal.values({
      Project: ref,
      "Supabase URL": info.supabaseUrl,
      "Publishable key": info.publishableKey,
      "API base URL": info.apiBaseUrl,
    });
  }
  if (options.output) {
    executePlan(
      root,
      planFiles(root, [
        connectionFile(root, options.output, info, options.replace),
      ]),
      options.dryRun ?? false,
    );
  }
  return info;
}
