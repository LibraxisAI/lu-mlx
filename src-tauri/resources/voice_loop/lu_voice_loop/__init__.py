"""Voice loop sidecar for Locally Uncensored.

A loopback Pipecat service: speech in, tool-capable LLM, speech out. The app
owns the microphone, the speaker and every tool. This process never executes
a tool; it only relays the call to the app over RTVI and waits for the result.
"""

__version__ = "0.1.0"
