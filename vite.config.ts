import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(here, 'index.html'),
        video: resolve(here, 'video.html'),
      },
    },
  },
  server: {
    port: 5173,
    open: false,
  },
});
