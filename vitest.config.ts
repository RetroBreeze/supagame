import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/cli/**/*.test.ts', 'tests/api/contract.test.ts', 'tests/sdk/**/*.test.ts'],
    environment: 'node',
  },
});
