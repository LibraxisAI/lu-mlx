import { defineConfig, devices } from '@playwright/test'

/**
 * The desktop UI against the LOCAL web stack of the web repository
 * (the web app): the production build of the web app, a
 * real PostgreSQL with every migration, the real render worker and a real
 * local model. Nothing is intercepted here: sign-in, model list, chat, jobs
 * and the preflight of every cross-origin call are the server's own.
 *
 * Not part of `npm run test:e2e`: it needs that stack up. Started by
 * scripts/create-chat-stack-probe.mjs, which reads the addresses and the
 * seeded test accounts from the web repository and hands them over as LU_STACK_*.
 */
const port = Number(process.env.LU_STACK_DESKTOP_PORT) || 5611
const need = (name: string): string => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set. Run: node scripts/create-chat-stack-probe.mjs <web repo>`)
  return value
}

export default defineConfig({
  testDir: './e2e-stack',
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  // A 9B model on this machine answers a turn with tools in up to a minute.
  timeout: 600_000,
  expect: { timeout: 20_000 },
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://localhost:${port}`,
    headless: true,
    // The stand-in of the project host answers with a certificate of its own.
    ignoreHTTPSErrors: true,
    launchOptions: {
      // Two outside names, both resolved to this machine, everything else to
      // nothing. The project host goes to the stack's stand-in. The cloud gets
      // a name too instead of 127.0.0.1: the app sends a loopback address
      // through its Rust proxy (which the Tauri mock answers itself), and a
      // named host through the WebView with CORS, the way it reaches the real
      // cloud.
      args: [`--host-resolver-rules=MAP ${need('LU_STACK_SUPABASE_HOST')} 127.0.0.1:${need('LU_STACK_SUPABASE_PORT')}, MAP ${new URL(need('LU_STACK_CLOUD')).hostname} 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost`],
    },
  },
  webServer: {
    command: `npx vite --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
    env: {
      VITE_LU_CLOUD_URL: need('LU_STACK_CLOUD'),
      VITE_LU_SUPABASE_URL: `https://${need('LU_STACK_SUPABASE_HOST')}`,
      VITE_LU_SUPABASE_ANON_KEY: need('LU_STACK_ANON_KEY'),
    },
  },
})
