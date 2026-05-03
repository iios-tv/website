import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Production code runs in browsers / Web Workers (where ImageData is a
    // global). Tests run in Node, so the setup file polyfills the few
    // browser globals we depend on. A real DOM env (jsdom / happy-dom)
    // would also work but is far heavier and we don't need it.
    environment: 'node',
    setupFiles: ['./src/test-utils/setup.ts'],
    include: ['src/**/*.test.ts'],
    // Don't recurse into node_modules / dist.
    exclude: ['node_modules', 'dist'],
  },
});
