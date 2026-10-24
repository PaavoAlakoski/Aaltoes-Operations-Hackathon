import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Deployed under /driver next to the control room (see vercel.json). Vercel
// services receive the full path, so the build sits in dist/driver and is
// served from dist: /driver/assets/... maps to dist/driver/assets/....
// The dev server stays at the root of its own port.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/driver/' : '/',
  build: { outDir: 'dist/driver', emptyOutDir: true },
  plugins: [react()],
  server: { port: 5175, strictPort: true },
}));
