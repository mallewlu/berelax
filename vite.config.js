import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    rolldownOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        bubbleGenesis: resolve(import.meta.dirname, 'bubble-genesis.html'),
      },
      output: {
        // three.js changes far less often than app code: keep it in its own
        // long-cacheable vendor chunks (only pages that import it load them).
        // Split along three's own file boundary (three.core.js vs the WebGL
        // renderer + examples) so neither chunk exceeds the 500 kB warning.
        codeSplitting: {
          groups: [
            {
              name: 'three-core',
              test: /[\\/]node_modules[\\/]three[\\/]build[\\/]three\.core\.js$/,
              priority: 2,
            },
            {
              name: 'three',
              test: /[\\/]node_modules[\\/]three[\\/]/,
              priority: 1,
            },
          ],
        },
      },
    },
  },
})
