import { InvalidParameterError } from "./errors.js";
export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
/** Reject lossy JSON.stringify inputs, cycles and values PostgreSQL cannot store. */
export function validateJson(
  value: unknown,
  ancestors = new Set<object>(),
): asserts value is JsonValue {
  if (value === null || typeof value === "boolean") return;
  if (
    typeof value === "string" &&
    !value.includes("\0") &&
    !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
      value,
    )
  )
    return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (
    typeof value === "object" &&
    (Array.isArray(value) ||
      Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null) &&
    !ancestors.has(value)
  ) {
    ancestors.add(value);
    if (Object.getOwnPropertySymbols(value).length)
      throw new InvalidParameterError("data", "Save data must be JSON.");
    for (const [key, child] of Object.entries(value)) {
      validateJson(key);
      validateJson(child, ancestors);
    }
    if (Array.isArray(value) && Object.keys(value).length !== value.length)
      throw new InvalidParameterError("data", "Sparse arrays are not JSON.");
    ancestors.delete(value);
    return;
  }
  throw new InvalidParameterError(
    "data",
    "Save data must be lossless, finite JSON without cycles, NUL or unpaired surrogates.",
  );
}
export function operationId(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  if (!c?.getRandomValues)
    throw new InvalidParameterError(
      "operationId",
      "Secure randomness is unavailable; supply a UUID.",
    );
  const bytes = c.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 15) | 64;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = Array.from(bytes, (x) => x.toString(16).padStart(2, "0")).join(
    "",
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
