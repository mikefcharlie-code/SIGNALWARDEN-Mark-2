import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: { rollupOptions: { output: { manualChunks: { globe: ['three'], orbital: ['satellite.js'] } } } },
  server: {
    host: '0.0.0.0',
    port: 3000,
    strictPort: true,
    proxy: {
      '/api/v1/public-imagery': { target: 'http://localhost:8000', changeOrigin: false },
      '/api/v1/local-ai': { target: 'http://localhost:8000', changeOrigin: false },
      '/api/v1/reports': { target: 'http://localhost:8000', changeOrigin: false },
      '/api/v1/lattice': { target: 'http://localhost:8000', changeOrigin: true },
    },
  },
  preview: {
    // Same-origin local-only relay; production deployments must configure the same narrow route.
    proxy: { '/api/v1/public-imagery': { target: 'http://localhost:8000', changeOrigin: false } },
    host: '0.0.0.0',
    port: 3000,
    strictPort: true,
  },
})
