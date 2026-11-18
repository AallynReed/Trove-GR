import { defineConfig } from 'vite';

export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/Trove-GR/' : '/',
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 800 },
}));
