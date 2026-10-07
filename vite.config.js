import { defineConfig } from 'vite';
const apiPort = Number(process.env.TENSORV_TEST_PORT || 8765);
if (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535) throw new Error('Invalid TensorV API port');

export default defineConfig({
  server: { proxy: { '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false } } },
  build: {
    rollupOptions: {
      output: { manualChunks: { editor: ['codemirror', '@codemirror/lang-python', '@codemirror/commands'] } },
    },
  },
});
