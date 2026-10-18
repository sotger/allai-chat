import { fileURLToPath } from 'node:url';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

const sharedPath = fileURLToPath(new URL('./src/shared', import.meta.url));
const mainPath = fileURLToPath(new URL('./src/main', import.meta.url));
const preloadIndexPath = fileURLToPath(new URL('./src/preload/index.ts', import.meta.url));
const preloadWebviewPath = fileURLToPath(new URL('./src/preload/webview.ts', import.meta.url));
const rendererPath = fileURLToPath(new URL('./src/renderer/src', import.meta.url));

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': sharedPath,
        '@main': mainPath
      }
    },
    build: {
      rollupOptions: {
        output: {
          entryFileNames: 'index.js'
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': sharedPath
      }
    },
    build: {
      rollupOptions: {
        input: {
          index: preloadIndexPath,
          webview: preloadWebviewPath
        },
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs'
        }
      }
    }
  },
  renderer: {
    plugins: [react()],
    resolve: {
      alias: {
        '@shared': sharedPath,
        '@renderer': rendererPath
      }
    }
  }
});
