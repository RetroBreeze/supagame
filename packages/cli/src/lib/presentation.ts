import type { Diagnostic } from "../commands/doctor.ts";
import type { HostedSnapshot } from "./hosted-config.ts";
import type { RealtimeInspection } from "./realtime-inspection.ts";
import type { Terminal } from "./terminal.ts";

export function diagnosticSummary(
  terminal: Terminal,
  findings: Diagnostic[],
): void {
  terminal.result = { findings };
  const healthyFiles = findings.filter((f) =>
    f.status === "healthy" && f.id.startsWith("file:")
  );
  if (healthyFiles.length && !terminal.options.verbose) {
    terminal.event({
      kind: "success",
      message:
        `${healthyFiles.length} installed files verified. Use --verbose for individual checks.`,
    });
  }
  for (const f of findings) {
    if (
      f.status === "healthy" && f.id.startsWith("file:") &&
      !terminal.options.verbose && !terminal.options.json
    ) continue;
    terminal.event({
      kind: f.status === "healthy"
        ? "success"
        : f.status === "error"
        ? "error"
        : "warning",
      message: `${f.status.toUpperCase()} [${f.scope}:${f.id}] ${f.message}`,
    });
  }
}
export interface DeploymentPreview {
  projectRef: string;
  modules: Record<string, string>;
  applied: string[];
  pending: { name: string; hash: string; owned: boolean }[];
  functionAction: string;
  functionHash: string;
  configuration: HostedSnapshot;
  originAction: string;
  origins: string[] | undefined;
  live: boolean;
  realtimeIssues: string[];
  realtime: RealtimeInspection | null;
}
export function deploymentPreview(
  terminal: Terminal,
  preview: DeploymentPreview,
): void {
  terminal.result = preview;
  const info = (message: string) => terminal.event({ kind: "info", message });
  const warning = (message: string) =>
    terminal.event({ kind: "warning", message });
  terminal.values({
    Project: preview.configuration.projectName ?? preview.projectRef,
    Destination: `${preview.projectRef} (hosted)`,
    Modules: Object.entries(preview.modules).map(([k, v]) => `${k} ${v}`).join(
      ", ",
    ),
  });
  info("\nDATABASE");
  info(`✓ ${preview.applied.length} migrations already applied`);
  if (!preview.pending.length) info("✓ No pending migrations");
  for (const migration of preview.pending) {
    info(
      `+ ${migration.owned ? "SUPAGAME" : "UNRELATED"} ${migration.name}${
        terminal.options.verbose ? ` sha256=${migration.hash}` : ""
      }`,
    );
  }
  info("\nEDGE FUNCTIONS");
  info(
    `supagame: ${preview.functionAction}${
      terminal.options.verbose ? ` sha256=${preview.functionHash}` : ""
    }`,
  );
  info("\nCONFIGURATION");
  info(
    `Anonymous authentication: ${
      preview.configuration.anonymous
        ? "enabled (verified)"
        : "enable after authorization"
    }`,
  );
  for (const issue of preview.configuration.authBlockers) {
    warning(`ACTION REQUIRED for new anonymous players: ${issue}`);
  }
  info(
    `Browser origins: ${preview.originAction}; ${
      preview.origins?.length ?? 0
    } configured locally`,
  );
  for (const origin of preview.origins ?? []) info(`  ${origin}`);
  if (preview.originAction === "unmanaged") {
    warning(
      "CANNOT VERIFY browser origins: existing hosted configuration is preserved. Browser games can configure exact origins with supagame config origins add <origin>. Native engines can omit origins.",
    );
  }
  if (["blocked", "replace"].includes(preview.originAction)) {
    warning(
      "ACTION REQUIRED: record ALL intended existing origins, then use --replace-origins with deployment authorization to replace the unreadable hosted value.",
    );
  }
  if (preview.live) {
    for (const issue of preview.realtimeIssues) {
      warning(`ACTION REQUIRED: Realtime prerequisites: ${issue}`);
    }
    if (!preview.realtimeIssues.length) {
      info(
        "Realtime database Broadcast prerequisites, RLS and receive grants: verified.",
      );
    }
    if (preview.realtime) {
      (preview.realtime.status === "healthy" ? info : warning)(
        `${preview.realtime.status.toUpperCase()}: ${preview.realtime.message}`,
      );
    }
    info(
      `Realtime configuration API: ${
        preview.configuration.realtimeConfig ? "readable" : "CANNOT VERIFY"
      }. Global settings are preserved.`,
    );
    warning(
      "CANNOT VERIFY WebSocket delivery from configuration alone. Run doctor --remote after deployment to verify private-channel policies and triggers, then verify runtime delivery.",
    );
  }
  info(
    "Only the supagame function is selected. All pending project migrations are listed, including unrelated SQL; review their contents. Seeds, roles, Vault and unrelated configuration are excluded.",
  );
}
