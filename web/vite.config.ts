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
  const proxy: Record<string, object> = {
    '/api': {
      target: env.IRIS_API_TARGET || 'http://127.0.0.1:8000',
      changeOrigin: true, ws: true, timeout: 30000, proxyTimeout: 30000,
    },
  }
  // Judge sign-in (Neon Auth) is served from this site's own address, at /auth. The sign-in cookie is then
  // first-party, so it works on phones that block third-party cookies, and the tunnel's address never has
  // to be added to Neon Auth's trusted origins: the request reaches it as localhost, which it allows.
  // Without NEON_AUTH_BASE_URL there is no /auth, and the app runs with the no-login session as before.
  try {
    const auth = new URL(env.NEON_AUTH_BASE_URL || '')
    proxy['/auth'] = {
      target: auth.origin, changeOrigin: true, timeout: 8000, proxyTimeout: 8000,
      rewrite: (path: string) => path.replace(/^\/auth/, auth.pathname.replace(/\/$/, '')),
      headers: { origin: 'http://localhost:5173' }, cookieDomainRewrite: '',
    }
  } catch { /* not configured */ }
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
