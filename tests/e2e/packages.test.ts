import { existsSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { packedConsumer, run } from './packages.ts';
test('CLI, contracts and SDK tarballs install and work outside the repository', { timeout: 300_000 }, async () => {
  const consumer = await packedConsumer();
  try {
    run(consumer.cli,['init','--project-ref','abcdefghijklmnopqrst'],consumer.root);
    run(consumer.cli,['add','admin','--dry-run'],consumer.root);
    run(consumer.cli,['add','admin'],consumer.root);
    run(consumer.cli,['admin','dashboard','--help'],consumer.root);
    for(const file of ['index.html','app.js','style.css']) assert.ok(existsSync(join(consumer.root,'node_modules/@supagame/cli/dist/dashboard',file)));
    run(consumer.cli,['upgrade','--dry-run'],consumer.root);
  } finally { consumer.remove(); }
});
