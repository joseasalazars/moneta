import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, './src') } },
  // changeOrigin rewrites Host to 127.0.0.1:3000 so the server's DNS-rebinding guard accepts it.
  server: { proxy: { '/api': { target: 'http://127.0.0.1:3000', changeOrigin: true } } },
})
