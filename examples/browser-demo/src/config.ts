export function demoConfig(projectUrl: string | undefined, publishableKey: string | undefined): { url: string; key: string } {
  if (!publishableKey || !/^sb_publishable_[A-Za-z0-9_-]+$/.test(publishableKey)) {
    throw new Error('Set VITE_SUPABASE_PUBLISHABLE_KEY to the project publishable key; secret and legacy JWT keys are not accepted.');
  }
  let url: URL;
  try { url = new URL(projectUrl ?? ''); }
  catch { throw new Error('Set VITE_SUPABASE_URL to the Supabase project URL.'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('The project URL must use HTTPS (HTTP on loopback), with no credentials, path, query or fragment.');
  }
  return { url: url.origin, key: publishableKey };
}
