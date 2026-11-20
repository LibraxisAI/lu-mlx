import { ImagePlus, Loader2 } from 'lucide-react'
import { useImagePartOffer, type ImagePartModel } from '../../hooks/useImagePartOffer'
import { IMAGE_INPUT_MISSING } from '../../lib/image-part'

interface Props {
  model: ImagePartModel | null | undefined
  /** Name of the download in the download list. */
  label?: string
  /** `row`: the small button of an installed model's row. `inline`: the
   *  button alone, inside a sentence somebody else wrote. */
  variant?: 'row' | 'inline'
}

/**
 * The one click that adds the image part to an installed model.
 *
 * Draws nothing for a model that has its part, has none to offer, or is not a
 * GGUF of the LU Engine. While the part downloads it shows the progress in
 * the place of the button, and the download list carries the full row.
 */
export function AddImageInput({ model, label, variant = 'row' }: Props) {
  const part = useImagePartOffer(model, label)
  const percent = part.downloading && part.downloading.total > 0
    ? Math.round((part.downloading.progress / part.downloading.total) * 100)
    : null

  if (!part.offer && !part.downloading && !part.error) return null

  const control = part.downloading ? (
    <span data-testid="add-image-input-progress" className="inline-flex items-center gap-1 px-2 py-0.5 t-micro text-gray-500 dark:text-gray-400 whitespace-nowrap">
      <Loader2 size={9} className="animate-spin" />
      Adding image input{percent !== null ? ` ${percent}%` : '…'}
    </span>
  ) : part.offer ? (
    <button
      onClick={(e) => { e.stopPropagation(); part.add() }}
      data-testid="add-image-input"
      title={`${IMAGE_INPUT_MISSING} One click downloads it next to the model.`}
      className="px-2 py-0.5 rounded t-micro font-medium bg-gray-100 dark:bg-white/10 text-gray-700 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-white/15 border border-gray-200 dark:border-white/10 transition-colors inline-flex items-center gap-1 whitespace-nowrap"
    >
      <ImagePlus size={10} />
      {part.label}
    </button>
  ) : null

  if (variant === 'inline') {
    return (
      <span className="inline-flex items-center gap-1 ml-1 align-middle">
        {control}
        {part.error && !part.downloading && <span className="text-red-400">{part.error}</span>}
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 mr-1" title={part.error ?? undefined}>
      {control}
      {part.error && !part.downloading && <span className="t-micro text-red-400 whitespace-nowrap">Download failed</span>}
    </span>
  )
}
