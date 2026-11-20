import { Check, Loader2, X } from 'lucide-react'
import { useComputerStore } from '../../stores/computerStore'

/** How many of the latest steps stay visible while the task runs. */
const SHOWN = 4

/**
 * The steps of the screen task that is running right now, under its tool
 * line in the chat, the way agent steps show. One task runs at a time, so
 * the running `computer_task` block is the one these belong to. When the
 * task ends the list goes and the result of the tool call says what happened.
 */
export function ScreenTaskSteps() {
  const task = useComputerStore((s) => s.task)
  if (!task) return null
  const hidden = Math.max(0, task.steps.length - SHOWN)
  return (
    <div className="ml-3.5 mb-1 pl-2 border-l border-gray-200 dark:border-white/10" data-testid="screen-task-steps">
      {hidden > 0 && <p className="t-micro text-gray-500">{hidden} earlier {hidden === 1 ? 'step' : 'steps'}</p>}
      {task.steps.slice(-SHOWN).map((step) => (
        <p key={step.n} className="t-micro text-gray-600 dark:text-gray-400 flex items-center gap-1.5 min-w-0">
          {step.ok === null
            ? <Loader2 size={9} className="animate-spin shrink-0 text-gray-500" />
            : step.ok
              ? <Check size={9} className="shrink-0 text-gray-400 dark:text-gray-500" />
              : <X size={9} className="shrink-0 text-red-400/60" />}
          <span className="truncate">Step {step.n}: {step.label}</span>
        </p>
      ))}
      {task.steps.length === 0 && <p className="t-micro text-gray-500">{task.blind ? 'Reading the window with' : 'Looking at the screen with'} {task.modelLabel}</p>}
    </div>
  )
}
