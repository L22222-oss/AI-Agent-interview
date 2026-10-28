const path = require('node:path');
const { defineConfig } = require('vite');
const vue = require('@vitejs/plugin-vue');

module.exports = defineConfig(({ mode }) => ({
  root: path.resolve(__dirname, 'vueeee'),
  plugins: [vue()],
  server: {
    proxy: {
      '/api': mode === 'node' ? 'http://127.0.0.1:3000' : 'http://127.0.0.1:8080',
    },
  },
  build: {
    outDir: path.resolve(__dirname, 'vueeee/dist'),
    emptyOutDir: true,
  },
}));
