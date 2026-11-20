import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { safeJSONStorage } from '../lib/storage-quota'
import { releaseNoteFor } from '../lib/release-notes'

/**
 * "What is new" popup, once per VERSION (B4, 2026-08-04).
 *
 * Deliberately NOT hung off `cloudTeasersEnabled`. That flag is the user's own
 * switch for the Cloud features in Local mode, and once off it stays off, not
 * even an update turns it back on (2026-07-19). This is the
 * opposite by design: once per version, every version. Two layers, two flags.
 */
interface ReleaseNotesState {
  /** The version whose notes this user has already seen. */
  lastNotesVersion: string | null
  /** The user asked for the sheet again (Settings, Updates). Lives only while
   *  the app runs: a restart never opens a sheet nobody asked for. */
  reopened: boolean
  markNotesSeen: (version: string) => void
  reopen: () => void
}

export const useReleaseNotesStore = create<ReleaseNotesState>()(
  persist(
    (set) => ({
      lastNotesVersion: null,
      reopened: false,
      markNotesSeen: (version) => set({ lastNotesVersion: version, reopened: false }),
      reopen: () => set({ reopened: true }),
    }),
    {
      name: 'lu_release_notes',
      storage: safeJSONStorage(),
      partialize: (s) => ({ lastNotesVersion: s.lastNotesVersion }),
    },
  ),
)

/**
 * Whether to show the notes now. Pure so the rule is provable in a unit test
 * rather than only through a live click, the same reason
 * shouldShowRetentionNotice is a function and not a JSX condition.
 *
 * `lastNotesVersion === null` is genuinely ambiguous: it is what a fresh
 * install looks like AND what an upgrade from any build before this feature
 * existed looks like, because the store did not exist there either. That is why
 * onboarding is the second signal and why the stamp happens at the END of
 * onboarding rather than at startup:
 *
 *   fresh install   -> onboarding runs -> finish() stamps the current version
 *                      -> null never survives to be read as "upgraded"
 *   upgrade to 2.6.3 -> onboarding does not run -> nothing stamps
 *                      -> null means "has not seen 2.6.3 notes" -> show
 *
 * The NSIS-recovery path in AppShell that flips onboardingDone back on for a
 * user whose settings were reset deliberately does NOT stamp: that user is an
 * upgrader and has notes coming.
 */
export function shouldShowReleaseNotes(
  currentVersion: string,
  lastNotesVersion: string | null,
  onboardingDone: boolean,
): boolean {
  // Onboarding owns the whole screen; the app tree this modal lives in is not
  // even mounted yet. Stacking the two would put a sheet over a wizard.
  if (!onboardingDone) return false
  // A version nobody wrote notes for stays quiet rather than showing a headline
  // with nothing under it.
  if (!releaseNoteFor(currentVersion)) return false
  return lastNotesVersion !== currentVersion
}
