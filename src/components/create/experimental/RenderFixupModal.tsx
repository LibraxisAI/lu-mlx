import { Download } from 'lucide-react'
import { useCreateStore } from '../../../stores/createStore'
import { Modal } from '../../ui/Modal'
import { ModalActions, ModalButton } from '../../ui/ModalActions'

/**
 * Discord 2026-09-28: a model that needs a text encoder / VAE that is not on
 * disk, or a newer ComfyUI, gets the fix offered right here instead of a
 * sentence pointing at the Model Manager. api/render-fixup-deps.ts sets
 * `fixupPrompt`, this resolves it. Mounted in the app shell, because the
 * agent's image tool asks the same question from Chat.
 */
export function RenderFixupModal() {
  const prompt = useCreateStore((s) => s.fixupPrompt)
  const choose = (go: boolean) => prompt?.resolve(go)
  return (
    <Modal open={prompt !== null} onClose={() => choose(false)} title={prompt?.title ?? ''}>
      <div className="space-y-4 text-sm text-gray-200">
        <p className="text-[12px] text-gray-300 leading-relaxed">{prompt?.detail}</p>
        <ModalActions>
          <ModalButton variant="quiet" onClick={() => choose(false)}>
            Cancel
          </ModalButton>
          <ModalButton variant="primary" onClick={() => choose(true)} data-autofocus>
            <Download size={14} />
            {prompt?.confirm}
          </ModalButton>
        </ModalActions>
      </div>
    </Modal>
  )
}
