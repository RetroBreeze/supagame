/** Browser origins are public configuration, never URLs containing credentials. */
export function normalizeOrigin(value: string): string {
  const invalid = () =>
    new Error(
      'Invalid browser origin. Use an exact http:// or https:// host and optional port, without credentials, path, query, fragment or wildcard.',
    );
  if (
    value.length > 2048 || /[\s\\*%?#'"`<>]/.test(value) ||
    !/^https?:\/\/[^/]/i.test(value)
  ) throw invalid();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid();
  }
  if (
    url.username || url.password || url.pathname !== '/' || !url.hostname ||
    url.origin === 'null'
  ) throw invalid();
  if (
    !url.hostname.startsWith('[') &&
    !url.hostname.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))
  ) throw invalid();
  return url.origin;
}
export function mergeOrigins(
  existing: readonly string[],
  additions: readonly string[],
): string[] {
  const origins = [
    ...new Set([...existing, ...additions].map(normalizeOrigin)),
  ];
  if (origins.length > 100 || JSON.stringify(origins).length > 16000) {
    throw new Error(
      'Too many browser origins; use at most 100 origins and 16 KB of configuration.',
    );
  }
  return origins;
}
