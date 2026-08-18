import http from 'node:http'
import https from 'node:https'
import { afterAll, vi } from 'vitest'
import { closeTestServers } from './helpers/http.ts'

vi.mock('@langfuse/openai', () => ({
  observeOpenAI: (client: any) => client
}))

// Every server tests/helpers/http.ts opened stays listening for the whole file,
// so the worker only shuts down cleanly if they are closed here.
afterAll(closeTestServers)

/**
 * Runs in every test worker before any test file.
 *
 * Node 19+ ships `http.globalAgent.keepAlive = true`, and supertest starts a NEW
 * ephemeral server for every `request(app)` call, closing it once the response is
 * delivered. Those two facts race: a test that fires two requests back to back
 * with no await in between can be handed, for its second server, the very port
 * the first server just released — while the agent still holds an idle pooled
 * socket keyed to that same `127.0.0.1:<port>`. Reusing that dead socket surfaces
 * as `socket hang up` or `Parse Error: Expected HTTP/, RTSP/ or ICE/`, on a test
 * whose assertions are perfectly correct.
 *
 * Reproduced at roughly 1 run in 15 on `tests/surface.test.ts`'s
 * "422s on a malformed body", which is the tightest back-to-back pair in the
 * suite. Connection pooling buys nothing here — every request is to a
 * single-use, in-process server — so turning it off costs no real time and
 * removes the only shared state between two supertest calls.
 *
 * Replacing the agents rather than assigning `globalAgent.keepAlive = false`:
 * `keepAlive` is a constructor option, not a public property on `Agent`, so the
 * assignment form does not typecheck.
 *
 * This narrows the failure but does not eliminate it — see the ECONNRESET note
 * in tests/helpers/app.ts.
 */
http.globalAgent = new http.Agent({ keepAlive: false })
https.globalAgent = new https.Agent({ keepAlive: false })
