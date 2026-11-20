// The two tools of Create in chat (Cloud mode).
//
// create_options only reads and costs nothing; create_order puts an order in
// front of the customer, who has to approve it, and never starts anything
// itself. The executors live in lib/create/chat-tools.ts (mirrored from the
// web app) and are loaded late, because only the cloud chat needs them.
// 'system' and not 'image': neither call spends credits, the approval is the
// order card, a second prompt would ask twice.
//
// They stand apart from BUILTIN_TOOLS (builtin-tools.ts) on purpose. That list
// is the agent's catalogue: it is mirrored to the mobile remote, classified as
// reading or changing, and offered in Code. These two are none of that. They
// exist only while the Create switch of the cloud chat is on, and the chat
// hands them to a turn by name.
//
// The definitions are the web's, character for character
// (lib/create/__tests__/web-parity.test.ts compares them): they are what the
// model reads, and the server's own gate knows the tools by these names.
import type { MCPToolDefinition, ToolArgs } from './types'
import type { ToolRegistry } from './tool-registry'
import { getActiveConversationId, type AgentRunContext } from '../agent-context'

export const CREATE_TOOLS: MCPToolDefinition[] = [
  {
    name: 'create_options',
    description:
      'What Create can make in this chat: images, clips, voices and music. Read only and free. '
      + 'No arguments: a short overview of subcategories (intent), presets, credits left and the handles of results, gallery entries and attachments of this chat. '
      + 'With intent or preset: the allowed models, what each does in one run (start from text or image, end image, sound, lengths, resolution, voices), their options and a price hint. '
      + 'Add model for the full option values of one model. Call this before create_order.',
    inputSchema: {
      type: 'object',
      properties: {
        intent: { type: 'string', description: 'A subcategory: image, video (clip from text), animate (clip from an image), edit, removebg, upscale, extend, video_upscale, lipsync, motion, music, character, or speech.' },
        preset: { type: 'string', description: 'A preset id from the overview.' },
        model: { type: 'string', description: 'Optional, with intent or preset: one model id for its full details.' },
      },
      required: [],
    },
    category: 'system',
    source: 'builtin',
  },
  {
    name: 'create_order',
    description:
      'Put a Create order in front of the customer. It does NOT start anything: the customer sees every item with its price and the total and has to approve it. '
      + 'Each item is one of: {"intent","prompt","model","inputs","options"}, {"preset","steps":[{"prompt","model","inputs","options"}]} or {"speech","model","reference","options"}. '
      + 'Inputs are handles from create_options (job:, gal:, att:) or item:<n> for the result of an earlier item of the same order, so items can be chained. '
      + 'Returns the price breakdown; tell the customer what it contains and what it costs.',
    inputSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: 'The items, in the order they run.',
          items: {
            type: 'object',
            properties: {
              intent: { type: 'string', description: 'Subcategory: image, video (clip from text), animate (clip from an image), edit, removebg, upscale, extend, video_upscale, lipsync, motion, music, character.' },
              preset: { type: 'string', description: 'Preset id instead of intent.' },
              speech: { type: 'string', description: 'The words to speak, instead of intent.' },
              prompt: { type: 'string', description: 'What to create.' },
              model: { type: 'string', description: 'Model id from create_options. Omit for the default.' },
              inputs: { type: 'object', description: 'Input name -> handle, e.g. {"image":"item:1"}.' },
              options: { type: 'object', description: 'Option name -> value, from create_options.' },
              steps: { type: 'array', description: 'Preset only: one entry per step.' },
              reference: { type: 'string', description: 'Speech only: handle of a voice to clone.' },
            },
          },
        },
      },
      required: ['items'],
    },
    category: 'system',
    source: 'builtin',
  },
]

async function createToolEnv(run?: AgentRunContext) {
  const { defaultCreateToolEnv } = await import('../../lib/create/chat-context')
  return defaultCreateToolEnv(getActiveConversationId(run))
}

async function executeCreateOptions(args: ToolArgs, run?: AgentRunContext): Promise<string> {
  const { runCreateOptions } = await import('../../lib/create/chat-tools')
  return runCreateOptions(args ?? {}, await createToolEnv(run))
}

async function executeCreateOrder(args: ToolArgs, run?: AgentRunContext): Promise<string> {
  const { runCreateOrder } = await import('../../lib/create/chat-tools')
  return runCreateOrder(args ?? {}, await createToolEnv(run))
}

const CREATE_TOOL_EXECUTORS: Record<string, (args: ToolArgs, run?: AgentRunContext) => Promise<string>> = {
  create_options: executeCreateOptions,
  create_order: executeCreateOrder,
}

/** Sets the registry to the Create switch (lib/create/chat-switch.ts,
 *  createActive): on registers the two tools, off withdraws them. Withdrawn,
 *  they are in no catalogue and every call is refused as an unknown tool;
 *  their names stay reserved, so no MCP server can take them over. */
export function syncCreateTools(registry: ToolRegistry, on: boolean): void {
  for (const tool of CREATE_TOOLS) {
    if (on) registry.registerBuiltin(tool, CREATE_TOOL_EXECUTORS[tool.name])
    else registry.withdrawBuiltin(tool.name)
  }
}

/** At start: the registry learns the two names as its own and holds them
 *  withdrawn. */
export function reserveCreateTools(registry: ToolRegistry): void {
  syncCreateTools(registry, true)
  syncCreateTools(registry, false)
}
