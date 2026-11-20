import { AlertTriangle } from 'lucide-react'
import { Hinweis } from '../ui/Hinweis'
import { REFUSAL_NOTICE } from '../../lib/refusal-detect'
import { newChatWithSameModel } from '../../lib/new-chat-same-model'

/**
 * The line under an answer in which the model declined (lib/refusal-detect).
 *
 * It stands under the answer and not at the prompt field: nothing is written
 * in or above the prompt field. Quiet tone, because nothing is broken; the
 * triangle marks it as the line that asks the user to do something.
 */
export function RefusalNotice() {
  return (
    <div data-testid="refusal-notice" className="pl-1">
      <Hinweis icon={<AlertTriangle size={11} className="mt-0.5 shrink-0" aria-hidden="true" />}>
        {REFUSAL_NOTICE}{' '}
        <button
          onClick={newChatWithSameModel}
          className="font-medium underline underline-offset-2 hover:no-underline"
        >
          New chat
        </button>
      </Hinweis>
    </div>
  )
}
