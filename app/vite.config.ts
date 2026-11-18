import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // Rust build artifacts would otherwise trigger full page reloads on every cargo rebuild.
    watch: { ignored: ['**/src-tauri/**'] },
  },
});
