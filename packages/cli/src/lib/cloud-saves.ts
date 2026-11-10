import { createHash } from "node:crypto";
import { parse } from "smol-toml";
export interface SaveLimits {
  maxSlots: number;
  maxJsonBytes: number;
  maxBinaryBytes: number;
  maxTotalBytes: number;
}
export const defaultSaveLimits: SaveLimits = {
  maxSlots: 10,
  maxJsonBytes: 1048576,
  maxBinaryBytes: 52428800,
  maxTotalBytes: 104857600,
};
export function validSaveLimits(value: unknown): value is SaveLimits {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const x = value as Record<string, unknown>;
  return (
    Object.keys(x).length === 4 &&
    Object.keys(defaultSaveLimits).every(
      (k) => Number.isSafeInteger(x[k]) && Number(x[k]) >= 1,
    ) &&
    Number(x.maxSlots) <= 1000 &&
    Number(x.maxJsonBytes) <= 1048576 &&
    Number(x.maxBinaryBytes) <= 5368709120 &&
    Number(x.maxTotalBytes) <= 53687091200
  );
}
export function saveLimitsSql(x: SaveLimits): Buffer {
  if (!validSaveLimits(x)) throw new Error("Invalid Cloud Saves limits.");
  return Buffer.from(
    `-- Supagame Cloud Saves limits; staged locally, explicitly confirmed on deploy.\nupdate sg_private.save_config set max_slots=${x.maxSlots}, max_json_bytes=${x.maxJsonBytes}, max_binary_bytes=${x.maxBinaryBytes}, max_total_bytes=${x.maxTotalBytes};\nupdate storage.buckets set file_size_limit=${x.maxBinaryBytes} where id='supagame-saves';\n`,
  );
}
export function saveLimitsSuffix(x: SaveLimits): string {
  return `_supagame_save_limits_${createHash("sha256").update(saveLimitsSql(x)).digest("hex").slice(0, 12)}.sql`;
}
/** Change only this module's local prerequisite and preserve all other TOML text. */
export function storageConfig(bytes: Buffer): Buffer {
  const config = parse(bytes.toString());
  const storage = config.storage as Record<string, unknown> | undefined;
  if (storage?.enabled === true) return bytes;
  let text = bytes.toString();
  if (!storage) text += "\n[storage]\nenabled = true\n";
  else {
    const section = /^\[storage\][^\n]*\n([\s\S]*?)(?=^\[|$(?![\s\S]))/m;
    if (!section.test(text))
      throw new Error(
        "Cannot safely update the local Storage configuration. Use a conventional [storage] section.",
      );
    text = text.replace(section, (block) =>
      /^enabled\s*=/m.test(block)
        ? block.replace(/^enabled\s*=\s*false/m, "enabled = true")
        : block + "enabled = true\n",
    );
  }
  const result = parse(text);
  if ((result.storage as Record<string, unknown>)?.enabled !== true)
    throw new Error("Cannot safely enable local Storage.");
  return Buffer.from(text);
}
