// Runs the desktop UI against the local web stack of the web repository.
//
//   1. In the web repository (the web app), with ports of your own:
//        LU_E2E_PORT_BASE=5602 node e2e-local/create-chat/stack.mjs build
//        LU_E2E_PORT_BASE=5602 LU_E2E_DESKTOP_ORIGIN=http://localhost:5611 node e2e-local/create-chat/stack.mjs up
//   2. Here:
//        LU_E2E_PORT_BASE=5602 node scripts/create-chat-stack-probe.mjs <path to the web repo>
//
// Addresses, the anon key and the seeded test accounts are read from the web
// repository's own lib/env.mjs, so nothing of them is written down twice.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const web = process.argv[2] && resolve(process.argv[2], 'apps/web/e2e-local/create-chat/lib/env.mjs')
if (!web || !existsSync(web)) {
  process.stderr.write('Usage: node scripts/create-chat-stack-probe.mjs <path to the web repo> [playwright arguments]\n')
  process.exit(1)
}
const stack = await import(pathToFileURL(web).href)
const desktopPort = Number(process.env.LU_STACK_DESKTOP_PORT) || 5611
const account = (u) => JSON.stringify({ email: u.email, password: u.password })
const env = {
  ...process.env,
  LU_STACK_DESKTOP_PORT: String(desktopPort),
  LU_STACK_WEB: stack.APP_URL,
  // The name the desktop knows the same server by (playwright.stack.config.ts).
  LU_STACK_CLOUD: `http://lu-cloud.test:${stack.PORTS.web}`,
  LU_STACK_SUPABASE_HOST: stack.SUPABASE_HOST,
  LU_STACK_SUPABASE_PORT: String(stack.PORTS.supabase),
  LU_STACK_ANON_KEY: stack.ANON_KEY,
  LU_STACK_RELEASED: account(stack.USERS.max),
  LU_STACK_UNRELEASED: account(stack.USERS.dark),
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const run = spawnSync('npx', ['playwright', 'test', '-c', 'playwright.stack.config.ts', ...process.argv.slice(3)], { cwd: root, env, stdio: 'inherit' })
process.exit(run.status ?? 1)
