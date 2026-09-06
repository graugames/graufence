import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const base = process.env['GITHUB_ACTIONS'] === 'true' ? '/graufence/' : '/';

export default defineConfig({
  base,
  plugins: [react()],
  server: {
    // 5174 rather than the Vite default: 5173 is a busy port on any machine
    // with more than one front end on it.
    port: 5174,
    strictPort: true,
    // Bind on all interfaces so a phone or a second laptop on the same network
    // can join the match - handy when testing two real cameras.
    host: true,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: {
        // MediaPipe is by far the largest dependency and changes rarely; giving
        // it its own chunk keeps the app bundle small and cacheable.
        manualChunks: {
          mediapipe: ['@mediapipe/tasks-vision'],
          react: ['react', 'react-dom'],
        },
      },
    },
  },
  // Vitest resolves this through the root config; Vite needs it for `npm run dev`
  // so the client always compiles the shared package from source.
  optimizeDeps: { exclude: ['@graufence/shared'] },
});
