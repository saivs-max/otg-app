// Builds the entire app into ONE self-contained .html file (JS + CSS inlined)
// that opens directly in a browser with no server or build step.
// Usage: npx vite build --config vite.singlefile.config.js --outDir /tmp/sf
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'

export default defineConfig({
  plugins: [react(), viteSingleFile()],
  build: { cssCodeSplit: false, assetsInlineLimit: 100000000, reportCompressedSize: false },
})
