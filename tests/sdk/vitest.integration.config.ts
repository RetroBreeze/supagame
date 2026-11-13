import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/sdk/*.integration.ts'], testTimeout: 20_000, hookTimeout: 20_000 } });
