// MIRRORED from the web app (lib/create/chat-origin.ts), without its comments. Do not edit here.
// scripts/create-chat-mirror.mjs writes this file, and web-parity.test.ts
// holds it to its source. Only the import paths differ, the places listed
// under PATCHES in that script, and the classes under CLASSES.
export const CREATE_TOOL_NAMES = ['create_options', 'create_order'] as const

export function isCreateToolName(name: string): boolean {
  return (CREATE_TOOL_NAMES as readonly string[]).includes(name)
}

export const JOB_ORIGIN_HEADER = 'x-lu-origin'
export const CREATE_CHAT_ORIGIN = 'create-chat'
export type JobOrigin = typeof CREATE_CHAT_ORIGIN

export function originHeaders(origin?: JobOrigin): Record<string, string> {
  return origin ? { [JOB_ORIGIN_HEADER]: origin } : {}
}

export function carriesCreateTools(tools: unknown): boolean {
  if (!Array.isArray(tools)) return false
  return tools.some((t) => {
    const name = (t as { function?: { name?: unknown } } | null)?.function?.name
    return typeof name === 'string' && isCreateToolName(name)
  })
}
