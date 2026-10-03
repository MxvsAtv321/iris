import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [react(), tailwindcss()],
    server: {
      allowedHosts: (env.IRIS_ALLOWED_HOSTS || '').split(',').map(h => h.trim()).filter(Boolean),
      proxy: { '/api': { target: env.IRIS_API_TARGET || 'http://127.0.0.1:8000', changeOrigin: true, ws: true, timeout: 30000, proxyTimeout: 30000 } },
    },
  }
})

