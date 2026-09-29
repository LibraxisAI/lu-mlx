import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { homedir } from 'os'
import type { RouteMount } from './routes'
import { APP_CONFIG_DIR } from '../src/lib/app-identity'
import { requirePost, withJsonBody, sendJson } from './http'
import { bodyString } from '../src/dev/http-body'

/**
 * Browser-dev mirror of `get_models_root` / `set_models_root`.
 *
 * The desktop app writes `config.json` via Rust `os_paths::app_config_json()`.
 * `npm run dev` has no Tauri, so Settings would otherwise fail with
 * "Unknown backend command". Same file, same key, same empty-path-clears-key
 * rule as the packaged command.
 */
export function appConfigJsonPath(): string {
  const home = process.env.HOME || homedir()
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', APP_CONFIG_DIR, 'config.json')
  }
  if (process.platform === 'win32') {
    const roaming = process.env.APPDATA || join(home, 'AppData', 'Roaming')
    return join(roaming, APP_CONFIG_DIR, 'config.json')
  }
  const xdg = process.env.XDG_CONFIG_HOME || join(home, '.config')
  return join(xdg, APP_CONFIG_DIR, 'config.json')
}

function readConfig(): Record<string, unknown> {
  const file = appConfigJsonPath()
  if (!existsSync(file)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function writeConfig(config: Record<string, unknown>): void {
  const file = appConfigJsonPath()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(config, null, 2), 'utf8')
}

export function registerConfigRoutes(routes: RouteMount): void {
  routes.use('/local-api/get-models-root', (_req, res) => {
    const config = readConfig()
    const path = typeof config.models_root === 'string' ? config.models_root : null
    sendJson(res, 200, { path })
  })

  routes.use('/local-api/set-models-root', (req, res) => {
    if (!requirePost(req, res)) return
    withJsonBody(req, res, (body) => {
      const next = (bodyString(body, 'path') ?? '').trim()
      const config = readConfig()
      if (!next) delete config.models_root
      else config.models_root = next
      writeConfig(config)
      sendJson(res, 200, { status: 'saved', path: next || null })
    })
  })
}
