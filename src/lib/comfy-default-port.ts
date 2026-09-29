/**
 * Default ComfyUI listen port: ComfyUI's own 8188, on every OS.
 *
 * The Mac app only connects to a ComfyUI the user already runs; if that one
 * listens elsewhere, Settings → ComfyUI stores the port. `LU_COMFY_PORT` /
 * `COMFYUI_PORT` win when they name a real port, so `npm run dev` and the
 * Vite proxy can follow the same instance the desktop app talks to.
 */

export const COMFY_DEFAULT_PORT = 8188

export function defaultComfyPort(opts?: {
  isMac?: boolean
  platform?: string
  env?: NodeJS.ProcessEnv
}): number {
  const env = opts?.env ?? (typeof process !== 'undefined' ? process.env : undefined)
  const raw = Number(env?.LU_COMFY_PORT || env?.COMFYUI_PORT || '')
  if (Number.isInteger(raw) && raw > 0 && raw < 65536) return raw
  return COMFY_DEFAULT_PORT
}
