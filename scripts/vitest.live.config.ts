import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

/** Live probes against real signed-in subscriptions. Kept out of the default suite. */
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, '../src/shared'),
      '@main': resolve(__dirname, '../src/main'),
      '@renderer': resolve(__dirname, '../src/renderer'),
    },
  },
  test: { environment: 'node', include: ['scripts/**/*.test.ts'], root: resolve(__dirname, '..') },
});
