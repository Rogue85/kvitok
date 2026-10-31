import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts', 'test/**/*.e2e.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    setupFiles: ['test/setup-env.ts'],
    // e2e tests share one test database.
    fileParallelism: false,
    hookTimeout: 30_000,
    testTimeout: 20_000,
  },
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
