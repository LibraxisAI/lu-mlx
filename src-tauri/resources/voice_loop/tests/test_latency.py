"""The latency readout counts from the end of the user's sentence, never from
the start of the session. Driven through Pipecat's real observer, in the frame
order a real session produces."""

from types import SimpleNamespace

from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    ClientConnectedFrame,
    InterruptionFrame,
    VADUserStartedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.observers.base_observer import FramePushed
from pipecat.observers.user_bot_latency_observer import UserBotLatencyObserver
from pipecat.processors.frame_processor import FrameDirection

from lu_voice_loop.latency import LatencyReport

STOP_SECS = 0.2


class Session:
    """An observer on a hand-moved clock, wired the way the pipeline wires it."""

    def __init__(self) -> None:
        self.now = 1000.0
        self.sent: list[dict] = []
        self.raw_totals: list[float] = []
        self.observer = UserBotLatencyObserver(time_source=lambda: self.now)
        report = LatencyReport()

        @self.observer.event_handler("on_latency_measured")
        async def on_measured(_observer, secs):
            report.measured(secs)

        @self.observer.event_handler("on_latency_breakdown")
        async def on_breakdown(_observer, breakdown):
            self.raw_totals.append(breakdown.total_secs)
            message = report.message(breakdown)
            if message is not None:
                self.sent.append(message)

    async def push(self, frame, after: float = 0.0) -> None:
        self.now += after
        source = SimpleNamespace(name="stage")
        await self.observer.on_push_frame(FramePushed(
            source=source, destination=source, frame=frame,
            direction=FrameDirection.DOWNSTREAM, timestamp=0,
        ))

    async def user_speaks(self, after: float, length: float = 1.0) -> None:
        await self.push(VADUserStartedSpeakingFrame(), after=after)
        self.now += length + STOP_SECS
        await self.push(VADUserStoppedSpeakingFrame(stop_secs=STOP_SECS, timestamp=self.now))

    async def flush(self) -> None:
        # Event handlers run as tasks.
        import asyncio
        for _ in range(5):
            await asyncio.sleep(0)


async def test_a_plain_turn_reports_the_wait_after_the_sentence():
    s = Session()
    await s.push(ClientConnectedFrame())
    await s.user_speaks(after=20.0)
    await s.push(BotStartedSpeakingFrame(), after=1.5)
    await s.flush()
    assert [m["total_secs"] for m in s.sent] == [1.7]


async def test_an_interruption_after_the_sentence_does_not_count_from_the_connection():
    # The second sentence cuts into the first answer. The interruption reaches
    # the observer after the VAD stop, which is the order that made the readout
    # show the age of the session ("Answered in 27.5 s", later 266 s).
    s = Session()
    await s.push(ClientConnectedFrame())
    await s.user_speaks(after=20.0)
    await s.push(BotStartedSpeakingFrame(), after=1.0)
    await s.user_speaks(after=0.5)
    await s.push(InterruptionFrame(), after=0.1)
    await s.push(BotStartedSpeakingFrame(), after=1.2)
    await s.flush()
    assert len(s.sent) == 2
    assert s.sent[1]["total_secs"] == 1.5
    # The observer's own sum is the trap this module exists for.
    assert s.raw_totals[1] > 20
    assert s.sent[1]["stages"] == []


async def test_the_wait_does_not_grow_with_the_age_of_the_session():
    s = Session()
    await s.push(ClientConnectedFrame())
    for _ in range(3):
        await s.user_speaks(after=120.0)
        await s.push(InterruptionFrame(), after=0.1)
        await s.push(BotStartedSpeakingFrame(), after=0.9)
    await s.flush()
    assert [m["total_secs"] for m in s.sent] == [1.2, 1.2, 1.2]


async def test_a_user_who_keeps_talking_is_timed_from_the_last_sentence():
    s = Session()
    await s.push(ClientConnectedFrame())
    await s.user_speaks(after=5.0)
    await s.user_speaks(after=0.6)
    await s.push(BotStartedSpeakingFrame(), after=2.0)
    await s.flush()
    assert [m["total_secs"] for m in s.sent] == [2.2]


async def test_a_greeting_reports_nothing():
    s = Session()
    await s.push(ClientConnectedFrame())
    await s.push(BotStartedSpeakingFrame(), after=3.0)
    await s.flush()
    assert s.sent == []


async def test_stages_are_passed_on_when_they_cover_the_same_wait():
    s = Session()
    await s.push(ClientConnectedFrame())
    await s.user_speaks(after=20.0)
    await s.push(BotStartedSpeakingFrame(), after=1.5)
    await s.flush()
    stages = s.sent[0]["stages"]
    assert stages and abs(sum(x["secs"] for x in stages) - 1.7) < 0.01
