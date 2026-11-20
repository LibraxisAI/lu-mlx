/**
 * Discord 2026-09-28: every agent permission on Auto, and the model
 * still could not open the user's files. The file tools only work inside the
 * chat's working folder; the refusal for anything else is recognised here, so
 * the user gets the way out above the chat and the model a hint it can pass on.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isOutsideWorkspaceRefusal, OUTSIDE_WORKSPACE_NOTICE } from '../workspace-refusal'
import { explainError } from '../../api/agents/error-hints'

const root = join(__dirname, '..', '..', '..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')

// The two refusals as the jail words them (commands/filesystem.rs).
const ESCAPE = 'Path escapes the allowed workspace.\n  workspace root: C:\\Users\\x\\agent-workspace\\chat\n  requested path: C:\\Users\\x\\Documents\\report.txt'
const NOT_A_ROOT = 'Not an allowed workspace folder (a home or mount container is not a workspace): C:\\Users\\x'

describe('the refusal is recognised', () => {
  it('in the wording the Rust jail and its dev-server mirror really use', () => {
    for (const file of ['src-tauri/src/commands/filesystem.rs', 'src/lib/dev-fs-jail.ts']) {
      const src = read(file)
      expect(src, file).toContain('Path escapes the allowed workspace.')
      expect(src, file).toContain('Not an allowed workspace folder (')
    }
  })

  it.each(['file_read', 'file_write', 'file_edit', 'file_list', 'file_search'])('for %s', (tool) => {
    expect(isOutsideWorkspaceRefusal(tool, ESCAPE)).toBe(true)
    expect(isOutsideWorkspaceRefusal(tool, NOT_A_ROOT)).toBe(true)
    // file_edit hands its refusal back as text, and the call's error is the first line.
    expect(isOutsideWorkspaceRefusal(tool, `Error: file_edit could not read C:\\x.txt: ${ESCAPE.split('\n')[0]}`)).toBe(true)
  })

  it('and nothing else', () => {
    expect(isOutsideWorkspaceRefusal('file_read', 'File not found: C:\\x.txt')).toBe(false)
    expect(isOutsideWorkspaceRefusal('file_read', undefined)).toBe(false)
    expect(isOutsideWorkspaceRefusal('shell_execute', ESCAPE)).toBe(false)
    expect(isOutsideWorkspaceRefusal('web_fetch', ESCAPE)).toBe(false)
  })
})

describe('what the user is told', () => {
  it('names the buttons that exist, in their own words', () => {
    expect(read('src/components/chat/AgentWorkspaceDialog.tsx')).toContain("'Pick a folder…'")
    expect(read('src/components/chat/AgentWorkspaceBadge.tsx')).toContain(": 'Sandbox'")
    expect(read('src/components/chat/AgentModeToggle.tsx')).toContain('<span>Agent</span>')
    expect(OUTSIDE_WORKSPACE_NOTICE).toContain('"Pick a folder…"')
    expect(OUTSIDE_WORKSPACE_NOTICE).toContain('Sandbox')
    expect(OUTSIDE_WORKSPACE_NOTICE).toContain('next to Agent')
  })

  it('carries no dash the house style forbids', () => {
    expect(OUTSIDE_WORKSPACE_NOTICE).not.toMatch(/[\u2013\u2014]/)
  })
})

describe('what the model is told', () => {
  it.each(['file_read', 'file_write', 'file_edit', 'file_list', 'file_search'])('%s gets the working-folder hint first', (tool) => {
    expect(explainError(tool, ESCAPE)).toMatch(/working folder/)
    expect(explainError(tool, NOT_A_ROOT)).toMatch(/working folder/)
  })

  it('a NEW file outside the folder: write it inside instead of asking for a path (3.0.4 box run)', () => {
    expect(explainError('file_write', ESCAPE)).toMatch(/Write the file inside it instead/)
    // NEGATIVE CONTROL: a refused working folder is not fixed by writing inside it,
    // and a read of a file that lives elsewhere still needs the user's folder.
    expect(explainError('file_write', NOT_A_ROOT)).not.toMatch(/Write the file inside it instead/)
    expect(explainError('file_read', ESCAPE)).not.toMatch(/Write the file inside it instead/)
  })

  it('never sends the model to the user home, which the jail refuses', () => {
    for (const tool of ['file_read', 'file_list']) {
      expect(explainError(tool, 'EACCES: permission denied')).not.toMatch(/home/i)
    }
  })
})
