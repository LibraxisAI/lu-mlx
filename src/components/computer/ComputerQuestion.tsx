import { useEffect, useId, useRef } from 'react'
import { ModalButton } from '../ui/ModalActions'
import { StatusGlyph } from '../status/StatusGlyph'
import { ToggleSwitch } from '../ui/ToggleSwitch'
import { setComputerAutonomy } from '../../api/computer-use'
import { answerComputerPrompt } from '../../lib/computer/prompts'
import { ComputerPermissionRows, PERMISSION_STALE_HINT, allPermissionsGranted, useComputerPermissions } from './ComputerPermissions'
import { useComputerStore } from '../../stores/computerStore'
import type { ComputerPrompt } from '../../stores/computerStore'

const hintCls = 't-micro leading-relaxed text-gray-500 dark:text-gray-400'

/** The title of a question, also its name for a screen reader. */
export function questionTitle(prompt: ComputerPrompt): string {
  if (prompt.kind === 'app') return `Allow LU to control ${prompt.app.name || prompt.app.key}?`
  if (prompt.kind === 'permission') return 'macOS has to allow this first'
  return 'Confirm this action'
}

/** What "no" is for this question. Escape and a stop give the same answer. */
function refusal(prompt: ComputerPrompt): 'deny' | false {
  return prompt.kind === 'app' ? 'deny' : false
}

/**
 * A question of computer control: may LU use this app, may it run this
 * action, and on macOS the permissions the system has to grant first.
 *
 * It stands directly above an input field, as a surface of its own and never
 * as a message in the conversation: above the chat input in the main window,
 * above the voice controls, and at the bottom of the panel while LU is
 * shrunk (`inPanel`: the panel is its frame, so it brings none of its own).
 * This is the one thing that may stand there. Escape means no.
 */
export function ComputerQuestion({ prompt, inPanel = false, className = '' }: { prompt: ComputerPrompt; inPanel?: boolean; className?: string }) {
  const autonomous = useComputerStore((s) => s.autonomous)
  const box = useRef<HTMLDivElement>(null)
  const permission = prompt.kind === 'permission' ? prompt : null
  // The system grants it, not a button here: the question watches, and the
  // call that waits goes on by itself the moment everything is there.
  const granted = useComputerPermissions(!!permission)
  const permissionId = permission?.id ?? null
  const allGranted = allPermissionsGranted(granted)
  useEffect(() => {
    if (permissionId && allGranted) answerComputerPrompt(permissionId, true)
  }, [permissionId, allGranted])

  // The button that has the focus at the start is the way out, in every
  // question. The question takes the focus from wherever the user was typing,
  // so a key that was on its way to a message must never be a yes.
  useEffect(() => {
    box.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus({ preventScroll: true })
  }, [prompt.id])

  const title = questionTitle(prompt)
  return (
    <div
      ref={box}
      role="group"
      aria-label={title}
      data-testid="computer-question"
      data-kind={prompt.kind}
      className={`lu-computer-question ${inPanel ? 'lu-computer-question--panel' : 'lu-elevated rounded-xl'} space-y-2.5 text-left ${className}`}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.stopPropagation()
        answerComputerPrompt(prompt.id, refusal(prompt))
      }}
    >
      <h3 className="t-body font-medium text-gray-900 dark:text-white flex items-center gap-2">
        {/* In the panel the head already carries the sign. */}
        {!inPanel && <StatusGlyph tone="edge" kind="approval" size={16} className="shrink-0" />}
        <span className="min-w-0">{title}</span>
      </h3>

      {prompt.kind === 'app' && (
        <div className="space-y-2.5" data-testid="computer-app-prompt">
          <p className="t-body text-gray-600">
            LU will be able to click and type in this app. You can stop it at any time.
          </p>
          <dl className="rounded-lg border border-gray-200 dark:border-white/10 px-3 py-2 space-y-1">
            <div className="flex gap-2">
              <dt className={`${hintCls} w-14 shrink-0`}>App</dt>
              <dd className="t-body text-gray-900 dark:text-white min-w-0 break-words">{prompt.app.name || prompt.app.key}</dd>
            </div>
            <div className="flex gap-2">
              <dt className={`${hintCls} w-14 shrink-0`}>Program</dt>
              <dd className="t-micro font-mono text-gray-600 dark:text-gray-400 min-w-0 break-all">{prompt.app.exe || prompt.app.bundleId || prompt.app.key}</dd>
            </div>
          </dl>
          <p className={hintCls}>
            Terminals, password managers, system dialogs and LU itself stay off limits, whatever you choose here.
          </p>
          <div className="lu-computer-answers">
            <ModalButton data-autofocus onClick={() => answerComputerPrompt(prompt.id, 'deny')}>Deny</ModalButton>
            <ModalButton onClick={() => answerComputerPrompt(prompt.id, 'always')}>Always allow</ModalButton>
            <ModalButton onClick={() => answerComputerPrompt(prompt.id, 'once')}>Allow once</ModalButton>
            <ModalButton variant="primary" onClick={() => answerComputerPrompt(prompt.id, 'session')}>Allow for this session</ModalButton>
          </div>
        </div>
      )}

      {prompt.kind === 'permission' && (
        <div className="space-y-2.5" data-testid="computer-permission-prompt">
          <p className="t-body text-gray-600">
            LU needs two permissions from macOS before it can work on the screen. Click Open System Settings, switch LU on in the list, and come back. LU notices by itself and carries on.
          </p>
          <ComputerPermissionRows granted={granted} />
          <p className={hintCls}>{PERMISSION_STALE_HINT}</p>
          <div className="flex justify-end">
            <ModalButton variant="quiet" data-autofocus onClick={() => answerComputerPrompt(prompt.id, false)}>Not now</ModalButton>
          </div>
        </div>
      )}

      {prompt.kind === 'confirm' && (
        <div className="space-y-2.5" data-testid="computer-confirm-prompt">
          <p className="t-body text-gray-900 dark:text-white whitespace-pre-wrap break-words max-h-32 overflow-y-auto scrollbar-thin">
            {prompt.description}
          </p>
          {prompt.reason && (
            <p className="t-micro leading-relaxed text-red-600 dark:text-red-300" data-testid="computer-confirm-reason">
              {prompt.reason}
            </p>
          )}
          {prompt.sensitive ? (
            <p className={hintCls}>
              LU asks before anything that sends, buys, deletes or changes permissions, also in an autonomous session.
            </p>
          ) : (
            <AutonomyOffer autonomous={autonomous} />
          )}
          <div className="lu-computer-answers">
            <ModalButton data-autofocus onClick={() => answerComputerPrompt(prompt.id, false)}>Decline</ModalButton>
            <ModalButton variant="primary" onClick={() => answerComputerPrompt(prompt.id, true)}>Confirm</ModalButton>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * The way out of being asked for every action, where the user is asked. The
 * row is as high with the switch on as with it off: nothing around it moves
 * when it is pressed.
 */
function AutonomyOffer({ autonomous }: { autonomous: boolean }) {
  return (
    <div className="lu-computer-autonomy flex items-center gap-3 rounded-lg border border-gray-200 dark:border-white/10 px-3" data-on={autonomous}>
      <p className={`${hintCls} min-w-0 flex-1`} data-testid="computer-autonomy-state">
        {autonomous
          ? 'On for this session: LU asks only before sensitive actions.'
          : 'Supervised: you confirm every action.'}
      </p>
      <ToggleSwitch size="md" enabled={autonomous} onChange={(next) => void setComputerAutonomy(next)} label="Autonomous" />
    </div>
  )
}

/**
 * A place above an input field where the question may stand. Several can be
 * mounted (the chat, the voice surface); the question shows in the first
 * one, and only while LU is its ordinary window. Shrunk to the panel, the
 * question stands in the panel instead.
 */
export function ComputerQuestionSlot({ className = '' }: { className?: string }) {
  const id = useId()
  const prompt = useComputerStore((s) => s.prompt)
  const surface = useComputerStore((s) => s.surface)
  const first = useComputerStore((s) => s.questionSlots[0] === id)
  useEffect(() => {
    useComputerStore.getState().addQuestionSlot(id)
    return () => useComputerStore.getState().removeQuestionSlot(id)
  }, [id])
  if (!prompt || surface !== 'window' || !first) return null
  return <ComputerQuestion prompt={prompt} className={className} />
}
