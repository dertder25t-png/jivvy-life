import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          codemirror: ['@uiw/react-codemirror', '@codemirror/lang-markdown', '@codemirror/view', '@codemirror/autocomplete', '@codemirror/language'],
          importer: ['jszip', 'sql.js'],
        },
      },
    },
  },
});
