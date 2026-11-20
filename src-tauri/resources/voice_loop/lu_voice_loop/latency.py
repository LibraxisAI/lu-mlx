"""The latency readout the app shows: how long the user waited for the answer.

Pipecat's observer reports the wait twice. `on_latency_measured` is the plain
interval from the end of the user's sentence to the first sound of the answer.
`on_latency_breakdown` splits a cycle into stages and sums them, but it picks
its own starting point: an interruption that arrives after the user stopped
speaking (a second sentence cutting into the first answer does that) clears the
start of the turn, and the breakdown then counts from the moment the client
connected. The sum grows with the age of the session and has nothing to do with
the wait. So the total always comes from the plain interval, and the stages are
only passed on when they describe the same stretch of time.
"""

from pipecat.observers.user_bot_latency_observer import MeasuredFrom

# Stages may differ from the wait by rounding and by the last frame hop.
STAGE_TOLERANCE_SECS = 0.25


class LatencyReport:
    """Pairs the measured wait with its breakdown and builds the app message."""

    def __init__(self) -> None:
        self._measured: float | None = None

    def measured(self, latency_secs: float) -> None:
        """The observer measured a wait. Its breakdown follows right after."""
        self._measured = latency_secs

    def message(self, breakdown) -> dict | None:
        """The message for the app, or None when no user was waiting.

        A breakdown without a measured wait is the greeting cycle, counted from
        the connection. Nobody asked anything, so there is nothing to show.
        """
        measured, self._measured = self._measured, None
        if measured is None or measured < 0:
            return None
        stages = []
        same_stretch = (
            breakdown.measured_from is MeasuredFrom.USER_SILENCE
            and abs(breakdown.total_secs - measured) <= STAGE_TOLERANCE_SECS
        )
        if same_stretch:
            stages = [
                {"key": c.key, "owner": c.owner, "secs": round(c.duration_secs, 3)}
                for c in breakdown.contributions
            ]
        return {"type": "latency", "total_secs": round(measured, 3), "stages": stages}
