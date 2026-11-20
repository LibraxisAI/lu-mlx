/**
 * Discord 2026-09-28: every agent permission on Auto, and the model
 * still said it could not access his files. Replayed on the installed 3.0.3 on
 * a Windows test machine: in plain chat the request never reaches a tool, because Chat Tools
 * carry no file_read. The chat now says that the agent reads files, and how to
 * turn it on.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { asksForLocalFiles, LOCAL_FILES_NOTICE } from '../local-file-intent'
import { CHAT_TOOLS } from '../chat-tool-intent'

const root = join(__dirname, '..', '..', '..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')

describe('a request to read files on this computer is recognised', () => {
  it.each([
    // The sentence replayed on the box, word for word.
    'Read the file C:\\Windows\\win.ini and tell me its first line.',
    'can you access my files?',
    'Open my documents folder and tell me what is in it',
    'please look at the files on my desktop',
    'list the files in my Downloads folder',
    'summarize D:/notes/meeting.txt',
    'scan ~/projects for TODO comments',
    'read /home/sam/notes.md',
    'check \\\\nas\\share\\report.docx',
    'lies die Datei C:\\Users\\x\\notizen.txt',
    'kannst du auf meine Dateien zugreifen?',
    'öffne meinen Ordner Bilder',
    'schau dir die Dateien auf meinem PC an',
  ])('%s', (msg) => {
    expect(asksForLocalFiles(msg)).toBe(true)
  })
})

describe('and nothing else', () => {
  it.each([
    'hi',
    'What is a file system?',
    'How do I open a file in Python?',
    'Write a file called notes.txt with a todo list',
    'Create a markdown file with my shopping list',
    // A pasted stack trace is full of paths and asks for nothing.
    'My script crashes: File "C:\\Users\\x\\app.py", line 3, in <module>',
    'summarize https://example.com/home/news/today',
    'read www.example.org/home/index.html',
    // Documents attached through Docs are read by the chat itself.
    'summarize my documents',
    'read my mind',
    // Hardware, not files.
    'Why does my computer see only 8 GB of RAM?',
    'check my laptop battery',
    'meine Festplatte ist voll, schau mal was ich tun kann',
    'Wie spät ist es?',
    '',
  ])('%s', (msg) => {
    expect(asksForLocalFiles(msg)).toBe(false)
  })
})

describe('the line the user gets', () => {
  it('names the buttons as they are labelled', () => {
    expect(read('src/components/chat/AgentModeToggle.tsx')).toContain('<span>Agent</span>')
    expect(read('src/components/chat/AgentWorkspaceDialog.tsx')).toContain("'Pick a folder…'")
    expect(LOCAL_FILES_NOTICE).toContain('Turn on Agent')
    expect(LOCAL_FILES_NOTICE).toContain('"Pick a folder…"')
  })

  it('carries no dash and no curly quote', () => {
    expect(LOCAL_FILES_NOTICE).not.toMatch(/[\u2013\u2014\u201c\u201d\u2018\u2019]/)
  })

  it('rests on plain chat having no tool that reads files', () => {
    // If Chat Tools ever get file_read, this line would be wrong: revisit it.
    expect(CHAT_TOOLS as readonly string[]).not.toContain('file_read')
    expect(CHAT_TOOLS as readonly string[]).not.toContain('file_list')
  })
})

describe('where the line comes and goes', () => {
  const chat = read('src/hooks/useChat.ts')
  const toggle = read('src/components/chat/AgentModeToggle.tsx')

  it('plain chat shows it, after the agent branch has returned and before the Chat Tools route', () => {
    const show = chat.indexOf("show('agent-for-local-files', LOCAL_FILES_NOTICE)")
    expect(show).toBeGreaterThan(0)
    expect(chat).toContain('if (asksForLocalFiles(content)) {')
    expect(show).toBeGreaterThan(chat.indexOf('return sendAgentMessage(content, images, { files })'))
    expect(show).toBeLessThan(chat.indexOf('resolveChatToolRoute(content'))
  })

  it('a send in agent mode takes it away', () => {
    const agentBranch = chat.indexOf('useAgentModeStore.getState().isActive(store.activeConversationId)')
    const dismiss = chat.indexOf("dismiss('agent-for-local-files')")
    expect(dismiss).toBeGreaterThan(agentBranch)
    expect(chat).toContain('return sendAgentMessage(content, images, { files })')
    expect(dismiss).toBeLessThan(chat.indexOf('return sendAgentMessage(content, images, { files })'))
  })

  it('turning Agent on takes it away, in a new agent chat and in this one', () => {
    expect(toggle.split("dismiss('agent-for-local-files')").length - 1).toBe(2)
  })
})
