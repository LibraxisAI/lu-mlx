import { backendCall, isTauri } from './backend'

/**
 * GH #135 (2026-09-15): "Install engine" under Models, Image ran
 * in the plain Vite dev server and answered "Unknown backend command:
 * install_mlx_diffusion", which reads like a broken build. MLX image and
 * video run in a Python sidecar the Rust side spawns, and `npm run dev` has
 * no Rust side. Remote Access says the same thing the same way
 * (stores/remoteStore REMOTE_DEV_MODE_ERROR).
 */
export const MLX_DEV_MODE_ERROR =
  "Local image and video generation on a Mac needs the installed desktop app. The plain `npm run dev` server has no Rust process to run the MLX engine in. Use `npm run tauri:dev` instead."

/**
 * Invoke an in-process MLX media Tauri command. The Rust wrappers
 * (`src-tauri/src/commands/media_cmds.rs`) each take a single
 * `args: serde_json::Value` parameter, matching the `shell_task_*`
 * convention (see `src/api/agents/bg-tasks.ts`), so the payload is nested
 * under an `args` key, not passed at the top level.
 */
export async function invokeMedia<T = unknown>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (!isTauri()) throw new Error(MLX_DEV_MODE_ERROR)
  return backendCall<T>(command, { args: args ?? {} })
}
