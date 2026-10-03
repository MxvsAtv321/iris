import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig(({ mode }) => {
  // Keep Darren's root env and Ali's web/.env.local; local web settings win.
  const env = { ...loadEnv(mode, '..', ''), ...loadEnv(mode, process.cwd(), '') }
  const tunnelHost = env.TUNNEL_HOST?.trim()
  const allowedHosts = [...new Set([
    ...(env.IRIS_ALLOWED_HOSTS || '').split(',').map(host => host.trim()).filter(Boolean),
    ...(tunnelHost ? [tunnelHost] : []),
  ])]
  const proxy = {
    '/api': {
      target: env.IRIS_API_TARGET || 'http://127.0.0.1:8000',
      changeOrigin: true, ws: true, timeout: 30000, proxyTimeout: 30000,
    },
  }
  return {
    plugins: [react(), tailwindcss()],
    envDir: '..',
    // Only explicitly public VITE_ variables reach the client.
    define: Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith('VITE_')).map(([key, value]) => ['import.meta.env.' + key, JSON.stringify(value)])),
    server: {
      port: 5173, allowedHosts, proxy,
      ws: tunnelHost ? { protocol: 'wss', host: tunnelHost, clientPort: 443 } : undefined,
    },
    preview: { host: '0.0.0.0', port: 4173, allowedHosts, proxy },
    optimizeDeps: { exclude: ['@huggingface/transformers'] },
  }
})
