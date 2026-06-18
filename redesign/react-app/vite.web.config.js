// Build the React app for serving by the Express server at /v2.
// Output goes to otg-app/web-dist; base path is /v2/ so asset URLs resolve.
// Runs in "product" mode (real login + live API), not the design-review explorer.
// Usage: npx vite build --config vite.web.config.js
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/',
  define: { 'import.meta.env.VITE_APP_MODE': JSON.stringify('product') },
  build: { outDir: '../../web-dist', emptyOutDir: true },
})
