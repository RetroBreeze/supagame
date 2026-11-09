import { test } from 'node:test';
import { packedConsumer } from './packages.ts';
test('CLI, contracts and SDK tarballs install and work outside the repository', { timeout: 300_000 }, async () => {
  const consumer = await packedConsumer();
  consumer.remove();
});
