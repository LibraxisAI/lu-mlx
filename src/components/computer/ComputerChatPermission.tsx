import { Check, Monitor, X } from 'lucide-react'
import { useComputerStore, type ComputerChatAsk } from '../../stores/computerStore'
import { answerComputerChatAsk } from '../../api/computer-chat'
import { isMacOS } from '../../api/backend'
import { BetaMark } from '../ui/BetaMark'
import { computerControlMacNote } from '../../lib/beta'

/** The stop shortcut as Rust registers it (commands/computer.rs). */
const stopShortcut = () => (isMacOS() ? 'Control+Option+Esc' : 'Ctrl+Alt+Esc')

/**
 * "Allow computer control in this chat?" The first use of computer control
 * in a chat stops here, in the card of the tool call, until the user clicks.
 * Only the click on Allow lets it through: no key, no spoken word, no
 * setting. In a voice session a spoken no declines, like Deny.
 */
export function ComputerChatPermission({ ask }: { ask: ComputerChatAsk }) {
  return (
    <div
      role="group"
      aria-label="Allow computer control in this chat"
      data-testid="computer-chat-permission"
      className="mt-1 mb-1.5 max-w-xl rounded-lg border border-gray-200 dark:border-white/[0.1] bg-gray-50 dark:bg-white/[0.03] px-3 py-2.5"
    >
      <div className="flex items-center gap-1.5">
        <Monitor size={13} className="shrink-0 text-gray-500 dark:text-gray-400" />
        <p className="t-body font-medium text-gray-900 dark:text-gray-100">Allow computer control in this chat?</p>
        <BetaMark feature="computer-control" className="shrink-0" />
      </div>
      <p className="mt-1 t-micro leading-relaxed text-gray-600 dark:text-gray-400">
        LU may look at your screen and use the mouse and the keyboard, in this chat only. It still asks before it touches an app. Stop at any time with {stopShortcut()}.
      </p>
      {computerControlMacNote(isMacOS()) && (
        <p className="mt-1 t-micro leading-relaxed text-gray-600 dark:text-gray-400" data-testid="computer-chat-mac-note">
          {computerControlMacNote(isMacOS())}
        </p>
      )}
      <div className="mt-2 flex items-center gap-1.5">
        <button
          type="button"
          data-testid="computer-chat-allow"
          onClick={(e) => { e.stopPropagation(); answerComputerChatAsk(ask.id, true) }}
          className="flex items-center gap-1 px-2.5 py-1 rounded t-micro font-medium text-emerald-700 dark:text-emerald-300 bg-emerald-500/10 hover:bg-emerald-500/15 border border-emerald-500/20 dark:border-emerald-500/25 transition-colors"
        >
          <Check size={10} /> Allow
        </button>
        <button
          type="button"
          data-testid="computer-chat-deny"
          onClick={(e) => { e.stopPropagation(); answerComputerChatAsk(ask.id, false) }}
          className="flex items-center gap-1 px-2.5 py-1 rounded t-micro font-medium text-red-700 dark:text-red-300 bg-red-500/10 hover:bg-red-500/15 border border-red-500/20 dark:border-red-500/25 transition-colors"
        >
          <X size={10} /> Deny
        </button>
      </div>
    </div>
  )
}

/** The open question, if the tool call of this card is the one that waits for it. */
export function useComputerChatAsk(toolName: string, running: boolean, conversationId: string | null): ComputerChatAsk | null {
  const ask = useComputerStore((s) => s.chatAsk)
  if (!ask || ask.voice || !running) return null
  if (toolName !== 'computer_use' && toolName !== 'computer_task') return null
  return ask.conversationId === null || ask.conversationId === conversationId ? ask : null
}
