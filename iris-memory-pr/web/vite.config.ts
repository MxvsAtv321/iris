import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// The app is served through the team's one Cloudflare tunnel, alongside the
// brain, so the phone page, dashboard, garden and brain share one HTTPS
// address. The tunnel provides the HTTPS that VR needs. Vite only accepts
// hostnames it knows, so TUNNEL_HOST in the root .env names the tunnel's
// hostname. Quick tunnels on *.trycloudflare.com are accepted without it.
//
// Settings come from the repo's root .env. Only VITE_ settings reach the browser.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, "..", "");
  const tunnelHost = env.TUNNEL_HOST?.trim();
  const allowedHosts = [".trycloudflare.com", ...(tunnelHost ? [tunnelHost] : [])];

  return {
    plugins: [react()],
    envDir: "..",
    server: {
      port: 5173,
      allowedHosts,
      // live reload has to come back through the tunnel too
      ws: tunnelHost ? { protocol: "wss", host: tunnelHost, clientPort: 443 } : undefined,
    },
    preview: { port: 4173, allowedHosts },
    optimizeDeps: { exclude: ["@huggingface/transformers"] },
  };
});
