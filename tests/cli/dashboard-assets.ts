import { buildSync } from "esbuild";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
export function dashboardAssets() {
  const root = mkdtempSync(join(tmpdir(), "supagame-dashboard-assets-"));
  const source = new URL("../../packages/cli/dashboard/", import.meta.url);
  for (const file of ["index.html", "style.css"]) {
    copyFileSync(new URL(file, source), join(root, file));
  }
  buildSync({
    entryPoints: [fileURLToPath(new URL("app.ts", source))],
    outfile: join(root, "app.js"),
    bundle: true,
    platform: "browser",
    format: "esm",
  });
  return {
    url: pathToFileURL(root + "/"),
    remove: () => rmSync(root, { recursive: true, force: true }),
  };
}
