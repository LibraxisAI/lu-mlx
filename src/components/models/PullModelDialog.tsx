import { useState } from 'react'
import { Download } from 'lucide-react'
import { Modal } from '../ui/Modal'
import { ModalActions, ModalButton } from '../ui/ModalActions'
import { useModels } from '../../hooks/useModels'

interface Props {
  open: boolean
  onClose: () => void
}

export function PullModelDialog({ open, onClose }: Props) {
  const [modelName, setModelName] = useState('')
  const { pullModel } = useModels()

  const handlePull = () => {
    if (!modelName.trim()) return
    pullModel(modelName.trim())
    setModelName('')
  }

  return (
    <Modal open={open} onClose={onClose} title="Pull Model">
      <div className="space-y-4">
        <div>
          <label className="text-sm text-gray-400 mb-1 block">Model Name</label>
          <input
            value={modelName}
            onChange={(e) => setModelName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handlePull()}
            placeholder="e.g. llama3.1:8b or mannix/llama3.1-8b-abliterated"
            className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-white placeholder-gray-500 focus:outline-none focus:border-white/20 text-sm"
          />
          <p className="t-micro text-gray-500 mt-1">Progress appears in the download icon in the header.</p>
        </div>

      </div>
      <ModalActions>
        <ModalButton variant="primary" onClick={handlePull} disabled={!modelName.trim()}>
          <Download size={14} />
          Pull Model
        </ModalButton>
      </ModalActions>
    </Modal>
  )
}
