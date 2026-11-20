// Discord 2026-09-23: "is there a way to limit download speed
// that this app does whenever it downloads anything?" One number, under the
// folder the downloads go to. App.tsx hands it to the downloader.
import { useState } from 'react'
import { useSettingsStore } from '../../stores/settingsStore'
import { parseDownloadLimit } from '../../lib/download-limit'

export function DownloadLimitSetting() {
  const limit = useSettingsStore((s) => s.settings.downloadLimitMBps)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const [draft, setDraft] = useState<string | null>(null)
  const apply = () => {
    if (draft === null) return
    updateSettings({ downloadLimitMBps: parseDownloadLimit(draft) })
    setDraft(null)
  }

  return (
    <div className="space-y-1 py-1">
      <div className="flex items-center justify-between">
        <span className="t-micro font-semibold text-gray-700 dark:text-gray-300">Download speed limit</span>
        <div className="flex items-center gap-1.5">
          <input
            aria-label="Download speed limit in MB/s"
            type="number"
            min={0}
            step={0.5}
            value={draft ?? String(limit)}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={apply}
            onKeyDown={(e) => { if (e.key === 'Enter') apply() }}
            className="w-20 px-1.5 py-0.5 rounded bg-transparent border border-white/8 t-mono text-right text-gray-300 focus:outline-none focus:border-white/20"
          />
          <span className="t-micro text-gray-500">MB/s</span>
        </div>
      </div>
      <div className="t-micro text-gray-500 leading-relaxed">
        {limit > 0
          ? `Model downloads share ${limit} MB/s between them. 0 removes the limit.`
          : '0 = no limit. Applies to the model files LU downloads itself, all of them together. Ollama pulls and installs are not limited.'}
      </div>
    </div>
  )
}
