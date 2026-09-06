import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// One Vitest run covers every workspace. `shared` holds the bulk of the suite
// (pure game logic), `server` covers room lifecycle, `client` covers the
// keyboard fallback and the pose->action pipeline driven by mock landmarks.
// Nothing here touches a real camera or opens a socket to the internet.
export default defineConfig({
  resolve: {
    alias: {
      '@graufence/shared': fileURLToPath(new URL('./packages/shared/src/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['packages/*/test/**/*.test.ts'],
    coverage: { reporter: ['text', 'html'], include: ['packages/*/src/**/*.ts'] },
  },
});
