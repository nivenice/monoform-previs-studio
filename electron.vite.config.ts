import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const { version } = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as { version: string }

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'electron/main/index.ts') },
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'electron/preload/index.ts') },
        // Sandboxed preload scripts must stay CommonJS; ESM preloads need sandbox disabled.
        output: { format: 'cjs', entryFileNames: 'index.cjs' },
      },
    },
  },
  renderer: {
    root: '.',
    base: './',
    plugins: [react()],
    define: { __APP_VERSION__: JSON.stringify(version) },
    server: { host: '127.0.0.1', port: 5173, strictPort: true },
    build: {
      outDir: 'out/renderer',
      rollupOptions: { input: { index: resolve(__dirname, 'index.html') } },
    },
  },
})
