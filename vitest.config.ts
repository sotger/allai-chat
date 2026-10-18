import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const sharedPath = fileURLToPath(new URL('./src/shared', import.meta.url));
const mainPath = fileURLToPath(new URL('./src/main', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@shared': sharedPath,
      '@main': mainPath
    }
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}']
  }
});
