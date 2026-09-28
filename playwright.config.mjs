import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: './tests', timeout: 45000, expect: { timeout: 15000 }, workers: 1,
  reporter: [['list'], ['json', { outputFile: 'evidence/test-results.json' }]],
  use: { baseURL: 'http://127.0.0.1:5174', viewport: { width: 1440, height: 1100 }, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: [
    { command: 'npm run dev', url: 'http://127.0.0.1:5174', reuseExistingServer: false },
    { command: 'npm run signal', url: 'http://127.0.0.1:4444', reuseExistingServer: false },
  ],
})
