import { describe, expect, it } from 'vitest'
import { LOCAL_VOICE_TOOLS, voiceContextLimit, voiceToolSet } from '../tool-set'
import type { MCPToolDefinition } from '../../../api/mcp/types'

function tool(name: string, source: MCPToolDefinition['source'] = 'builtin'): MCPToolDefinition {
  return { name, source, category: 'web', description: name, inputSchema: { type: 'object', properties: {} } } as MCPToolDefinition
}

const names = (defs: MCPToolDefinition[]) => defs.map((d) => d.name)

describe('voiceToolSet', () => {
  const catalog = [tool('web_search'), tool('file_read'), tool('image_generate'), tool('computer_use'), tool('computer_task'), tool('notion_search', 'mcp' as MCPToolDefinition['source'])]

  it('gives a local model the short set and keeps tools the user added', () => {
    expect(names(voiceToolSet(catalog, true))).toEqual(['web_search', 'file_read', 'computer_task', 'notion_search'])
  })

  it('gives a cloud model everything except the tool that answers with pictures', () => {
    expect(names(voiceToolSet(catalog, false))).toEqual(['web_search', 'file_read', 'image_generate', 'computer_task', 'notion_search'])
  })

  it('keeps computer_use out of a local set also when the task tool is missing', () => {
    const without = catalog.filter((t) => t.name !== 'computer_task')
    expect(names(voiceToolSet(without, true))).toEqual(['web_search', 'file_read', 'notion_search'])
    // A cloud model keeps it then: it is the only way to the screen.
    expect(names(voiceToolSet(without, false))).toContain('computer_use')
  })

  it('offers the screen task to a local model', () => {
    expect(LOCAL_VOICE_TOOLS.has('computer_task')).toBe(true)
    expect(LOCAL_VOICE_TOOLS.has('computer_use')).toBe(false)
  })

  it('keeps a local conversation short enough for a small window', () => {
    expect(voiceContextLimit(true)).toBeLessThan(4096)
    expect(voiceContextLimit(false)).toBeGreaterThan(voiceContextLimit(true))
  })
})
