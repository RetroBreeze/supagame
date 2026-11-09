import { expect, it } from 'vitest';
import { demoConfig } from '../../examples/capacitor-demo/src/config.js';

it('accepts a local URL and a publishable key only', () => {
  expect(demoConfig('http://127.0.0.1:54321/', 'sb_publishable_example')).toEqual({ url: 'http://127.0.0.1:54321', key: 'sb_publishable_example' });
});
it.each(['', 'sb_secret_do_not_ship', 'eyJhbGciOiJIUzI1NiJ9.admin.signature'])('rejects missing or privileged client keys', (key) => {
  expect(() => demoConfig('https://example.supabase.co', key)).toThrow(/publishable/);
});
it.each(['http://remote.example', 'https://user:secret@example.com', 'https://example.com?secret=x', 'not a URL'])('rejects unsafe project URLs', (url) => {
  expect(() => demoConfig(url, 'sb_publishable_example')).toThrow(/URL/);
});
