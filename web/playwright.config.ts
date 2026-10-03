import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: './e2e',
  webServer: { command: 'npm run dev -- --port 5173 --strictPort', url: 'http://localhost:5173', reuseExistingServer: !process.env.CI, timeout: 20000 },
  use: { baseURL: 'http://localhost:5173', headless: true },
})
