"""Spoken yes, no, stop and wait, for the moments when the app waits for exactly that.

A voice session can hand a long task to the app (computer control). While it
runs, two things the user says are not conversation:

  - "stop" or "wait" holds the task at once (the app pauses it and asks the
    user on the screen whether to take over or to let it continue), and
  - "yes" or "no" answers a question the app has open (may it use this app,
    may it run this action).

Such an utterance is taken out of the pipeline here. It never reaches the
model, so the model neither answers "Yes what?" nor acts on a word that was
meant for the dialog. The app is told with a server message and decides what
the word does; nothing is decided in this process.

Matching is on the whole utterance. "Yes" answers, "yes but first tell me
what you will click" is conversation and goes to the model. Outside of an
open question, yes and no are ordinary words; outside of a running task,
stop is one too.

The speech recognition hears in pieces: a breath after the first word and
"Wait, what is two plus two?" arrives as "Wait" and, a moment later, the
rest. So "wait", "hold on" and "pause" count only when the user does not go
on speaking (HOLD_GRACE_SECS). "Stop", "cancel" and "abort" are never held
back: a stop that comes late is worse than a pause too many, and the pause
is undone with one click.
"""

import asyncio

import re
from collections.abc import Awaitable, Callable

from pipecat.frames.frames import (
    Frame,
    TranscriptionFrame,
    TTSSpeakFrame,
    VADUserStartedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.turns.empty_user_turn import DEFAULT_EMPTY_USER_TURN_INTERRUPTED_PROMPT
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

YES = frozenset({
    "yes", "yes please", "yeah", "yep", "ok", "okay", "sure", "go ahead", "do it",
    "yes do it", "yes go ahead", "confirm", "allow", "allow it",
})
NO = frozenset({
    "no", "no thanks", "no thank you", "nope", "dont", "do not", "deny", "decline", "no dont",
})
STOP = frozenset({
    "stop", "stop it", "stop that", "stop now", "please stop", "stop please",
    "stop everything", "stop the task", "cancel", "cancel that", "cancel it", "abort",
    # Meant the same while a task runs: hold it. The app pauses for all of them.
    "wait", "wait a moment", "wait a second", "hold on", "pause", "pause it",
})

# The words of STOP that also open a sentence: "Wait, what is two plus two?".
HOLD = frozenset({"wait", "wait a moment", "wait a second", "hold on", "pause", "pause it"})

# How long the user may take to go on speaking after such a word before it
# counts as the command. The voice detection ends a piece of speech after 0.2
# seconds of silence and reports new speech 0.2 seconds into it, and the
# recognition of the word takes about 0.3 seconds, so this covers a breath of
# up to about a second after the word.
HOLD_GRACE_SECS = 0.6

# What is left of an utterance that was a command. Not empty: the turn
# detection only counts a transcript that has text, and the conversation
# only keeps one that is more than whitespace.
BLANK = " "

# Said once when the user answers by voice a question that needs a click.
NEEDS_CLICK = "This one needs your click on the screen."


def normalize(text: str) -> str:
    """Lower case words without punctuation: "Yes, please." -> "yes please"."""
    return " ".join(re.sub(r"[^a-z ]+", "", text.lower().replace("-", " ")).split())


def holds_only(text: str) -> bool:
    """The utterance is one of the words that may be the start of a sentence."""
    return normalize(text) in HOLD


def spoken_command(text: str) -> str | None:
    """"yes", "no", "stop" or None for one whole utterance."""
    words = normalize(text)
    if words in STOP:
        return "stop"
    if words in YES:
        return "yes"
    if words in NO:
        return "no"
    return None


class VoiceCommandGate(FrameProcessor):
    """Sits between speech recognition and the conversation."""

    def __init__(self, notify: Callable[[dict], Awaitable[None]], *, hold_grace_secs: float = HOLD_GRACE_SECS, **kwargs):
        super().__init__(**kwargs)
        self._notify = notify
        self._hold_grace_secs = hold_grace_secs
        self._speaking = False
        # A "wait" that is held back until it is clear that nothing follows.
        self._held: tuple[TranscriptionFrame, FrameDirection] | None = None
        self._holding: asyncio.Task | None = None
        self._question: tuple[str, bool] | None = None
        self._task_active = False
        self._told_to_click = False
        self._took_command = False

    # ---- what the app says is going on ----------------------------------

    def open_question(self, question_id: str, voice_ok: bool) -> None:
        self._question = (question_id, voice_ok)
        self._told_to_click = False

    def close_question(self, question_id: str | None = None) -> None:
        if question_id is None or (self._question and self._question[0] == question_id):
            self._question = None

    def set_task_active(self, active: bool) -> None:
        self._task_active = active
        if not active:
            self._question = None

    @property
    def armed(self) -> bool:
        return self._question is not None or self._task_active

    @property
    def took_command(self) -> bool:
        """The words of the user's current turn were a command, taken out here."""
        return self._took_command

    # ---- the pipeline ----------------------------------------------------

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, VADUserStartedSpeakingFrame):
            self._speaking = True
            # New speech: what was taken before belongs to an earlier turn,
            # and a "wait" that was held back was the start of a sentence.
            self._took_command = False
            await self._release_held()
        elif isinstance(frame, VADUserStoppedSpeakingFrame):
            self._speaking = False
        if isinstance(frame, TranscriptionFrame):
            # More words: the "wait" before them was not the whole utterance.
            await self._release_held()
            if self.armed and holds_only(frame.text):
                if self._speaking:
                    # The user is already saying the rest.
                    await self.push_frame(frame, direction)
                    return
                self._held = (frame, direction)
                self._holding = self.create_task(self._take_held_after_grace())
                return
        if isinstance(frame, TranscriptionFrame) and self.armed and await self._take(frame.text):
            self._took_command = True
            # The words are gone, the turn is not: the conversation still
            # waits for a transcript before it lets the user's turn end, for
            # up to five seconds. A blank one ends it now and adds nothing to
            # the context.
            await self.push_frame(
                TranscriptionFrame(
                    BLANK, frame.user_id, frame.timestamp, frame.language, finalized=frame.finalized,
                ),
                direction,
            )
            return
        await self.push_frame(frame, direction)

    async def cleanup(self):
        await super().cleanup()
        if self._holding is not None:
            await self.cancel_task(self._holding)
            self._holding = None
        self._held = None

    async def _release_held(self) -> None:
        """The user went on speaking: the word goes to the model with the rest."""
        if self._held is None:
            return
        frame, direction = self._held
        self._held = None
        if self._holding is not None:
            await self.cancel_task(self._holding)
            self._holding = None
        await self.push_frame(frame, direction)

    async def _take_held_after_grace(self) -> None:
        await asyncio.sleep(self._hold_grace_secs)
        if self._held is None:
            return
        frame, direction = self._held
        self._held = None
        self._holding = None
        if not self.armed:
            # The task ended meanwhile: an ordinary word again.
            await self.push_frame(frame, direction)
            return
        await self._take(frame.text)
        self._took_command = True
        await self.push_frame(
            TranscriptionFrame(BLANK, frame.user_id, frame.timestamp, frame.language, finalized=frame.finalized),
            direction,
        )

    async def _take(self, text: str) -> bool:
        command = spoken_command(text)
        if command is None:
            return False
        if command == "stop":
            # The app pauses the task. A question that was open is not open
            # for the voice while paused; the app asks it again afterwards.
            self._question = None
            await self._notify({"type": "voice-stop"})
            return True
        if self._question is None:
            # A task runs and nothing is asked: yes and no are conversation.
            return False
        question_id, voice_ok = self._question
        if command == "yes" and not voice_ok:
            # Sending, buying, deleting, changing permissions: the app wants
            # the click. The word is swallowed and the user is told, once.
            if not self._told_to_click:
                self._told_to_click = True
                await self.push_frame(TTSSpeakFrame(NEEDS_CLICK, append_to_context=False))
            return True
        self._question = None
        await self._notify({"type": "voice-answer", "id": question_id, "answer": command})
        return True


class EmptyTurnUnlessCommand:
    """What the conversation does with a user turn that ends without words.

    Pipecat answers such a turn when it cut the assistant off: the model is
    told that the user may have said something that was not recognized, and
    asks them to repeat it. That is right for a cough. It is wrong for a turn
    whose words the gate took: the "yes" was understood and answered the
    question on the screen, and the model would talk about it anyway (Windows
    run A22: "I'll wait for the computer control task to complete" after
    every spoken yes).

    Stands in for Pipecat's EmptyUserTurnConfig, which is read once per empty
    turn, at its end.
    """

    idle_prompt: str | None = None
    max_consecutive_recoveries: int = 1

    def __init__(self, gate: VoiceCommandGate):
        self._gate = gate

    @property
    def interrupted_prompt(self) -> str | None:
        return None if self._gate.took_command else DEFAULT_EMPTY_USER_TURN_INTERRUPTED_PROMPT
