/**
 * Stands in for `@daily-co/daily-js` in everything LU builds.
 *
 * `@pipecat-ai/websocket-transport` imports the client of the Daily video
 * call service, and that package brings the Sentry browser client along and
 * loads its call code from c.daily.co. The transport needs it for one class
 * only, `DailyMediaManager`, and LU never constructs that class: the voice
 * session hands the transport its own media manager (`voice-media.ts`).
 *
 * LU is local and private, so that code must not be in the app at all. The
 * build, the dev server and the tests resolve the package name to this file
 * (`src/dev/absent-packages.ts`). The two functions below are the ones
 * `DailyMediaManager` calls in its constructor. Creating a call object
 * throws, so a transport that is built without LU's media manager fails
 * loudly instead of reaching for a network service.
 *
 * Held in place by `__tests__/voice-ships-no-call-client.test.ts`.
 */
const absentCallClient = {
  getCallInstance(): undefined {
    return undefined
  },
  createCallObject(): never {
    throw new Error('The Daily call client is not part of LU. Voice uses its own microphone and speaker handling.')
  },
}

export default absentCallClient
