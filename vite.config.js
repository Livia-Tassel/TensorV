import { defineConfig } from 'vite';

export default defineConfig({
  server: { proxy: { '/api': { target: 'http://127.0.0.1:8765', changeOrigin: false } } },
  build: {
    rollupOptions: {
      output: { manualChunks: { editor: ['codemirror', '@codemirror/lang-python', '@codemirror/commands'] } },
    },
  },
});
