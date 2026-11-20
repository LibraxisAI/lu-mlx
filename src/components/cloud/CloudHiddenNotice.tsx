import { useEffect } from 'react'
import { useUIStore } from '../../stores/uiStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { Hinweis } from '../ui/Hinweis'

/** How long the line stays if nobody closes it. */
export const CLOUD_HIDDEN_NOTICE_MS = 12_000
export const CLOUD_HIDDEN_NOTICE = 'Cloud features are hidden. Turn them back on in Settings, General.'

/**
 * The answer to "Don't show Cloud features in Local mode" on the Cloud sheet
 * (the box, 04.10.2026: the click closed the sheet, the Cloud tabs and rows
 * were gone, and nothing said where they went). One quiet line at the top of
 * Create, where the sheet was opened from. It leaves on its X, after a few
 * seconds, and at once when the switch is turned back on.
 */
export function CloudHiddenNotice() {
  const shown = useUIStore((s) => s.cloudHiddenNotice)
  const setShown = useUIStore((s) => s.setCloudHiddenNotice)
  const cloudFeatures = useSettingsStore((s) => s.settings.cloudTeasersEnabled)
  const visible = shown && !cloudFeatures

  useEffect(() => {
    if (!shown) return
    if (cloudFeatures) { setShown(false); return }
    const t = setTimeout(() => setShown(false), CLOUD_HIDDEN_NOTICE_MS)
    return () => clearTimeout(t)
  }, [shown, cloudFeatures, setShown])

  if (!visible) return null
  return (
    <Hinweis className="px-4 py-2 shrink-0" onDismiss={() => setShown(false)}>
      {CLOUD_HIDDEN_NOTICE}
    </Hinweis>
  )
}
