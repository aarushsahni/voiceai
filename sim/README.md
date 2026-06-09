# IVR Test Harness

Automated testing so you can iterate on the IVR **without speaking to it**.

| Tier | Command | What it tests | Speed |
|------|---------|---------------|-------|
| **1 — logic/conversation** | `npm run sim` | Option matching, branching, prompt adherence, generate/summary output | Fast |
| **2 — audio (multi-turn)** | `npm run sim:audio` | Real `gpt-realtime` voice calls + turn-taking + branching, full multi-turn, headless over WebSocket | Medium (~1 min/scenario) |
| **Browser smoke** | `npm run sim:e2e` | The actual React app + real WebRTC + ephemeral-token flow connects and exchanges a turn | Slow (~1 min) |
| **👀 Watch a call** | `npm run sim:watch` | Live web viewer — watch & hear a simulated call happen, turn by turn | open http://localhost:4400 |

All tiers need `OPENAI_API_KEY` in `.env.local` at the repo root:

```
OPENAI_API_KEY=sk-...
```

(The harness loads `.env.local` itself — no need to export it.)

### Quickest way to watch a call

Double-click **`sim/watch.command`** in Finder (or run `npm run sim:watch`). It starts the
local server and opens your browser to the viewer automatically — pick a scenario, press
Start, and watch + hear the call. Runs entirely on your machine; your key never leaves it.

## Tier 1 — logic & conversation

```bash
npm run sim            # everything
npm run sim matcher    # option-matching cases (cheap, fast)
npm run sim flow       # /api/generate + /api/summary structural checks
npm run sim convo      # persona-driven full conversations
npm run sim convo -v   # verbose: print every transcript
```

- **Matcher cases** — [`sim/cases/matcher.cases.ts`](cases/matcher.cases.ts). Add tricky phrasings, phonetic errors, negations, Spanish, etc. Each asserts which option `/api/match` should pick.
- **Personas** — [`sim/cases/personas.ts`](cases/personas.ts). Each is an LLM-played patient with `expectedSteps`, `expectCallback`, `expectGoodbye`. Runs the real IVR system prompt (`src/utils/scripts.ts`) turn-by-turn and asserts the flow.

> **Fidelity note:** Tier 1 uses a chat model (`gpt-4o`) as a stand-in for the IVR agent (the realtime model is API-only). Faithful for **branching / prompt / matching**, not audio. For real audio behavior use Tier 2. Override with `IVR_MODEL=... PATIENT_MODEL=... npm run sim convo`.

The matcher/flow/summary suites call the **real** `api/*.ts` handlers in-process (same code + models as production) via a mocked req/res.

## Tier 2 — audio (the real turn-taking test)

```bash
npm run sim:audio        # all scenarios
npm run sim:audio -v     # print agent transcripts
```

Drives **full multi-turn voice conversations against the real `gpt-realtime` model**, headless over a WebSocket (no browser). It replicates the app's exact session config — `server_vad`, `create_response: false`, manual `response.create` per turn — and injects one patient TTS clip per turn, paced in real time like a live mic. Each scenario asserts the agent branched correctly and reached the right ending, and reports turn-taking latency.

- Scenarios live in [`sim/realtime/runAudio.ts`](realtime/runAudio.ts) (cooperative, callback, wrong-number). Add patient turn lists + `expectAgentSaid` / `expectGoodbye` assertions.
- Core driver: [`sim/realtime/audioConvo.ts`](realtime/audioConvo.ts).
- This is the place to validate turn-taking changes: tweak the session config / timing and watch the latency + completion numbers.

## Watch a call live

```bash
npm run sim:watch     # then open http://localhost:4400
```

A small web page where you pick a scenario, press **Start call**, and watch the
conversation appear as chat bubbles **with the real audio playing** — agent (gpt-realtime)
voice and patient (TTS) voice, in sequence, with per-turn response latency shown. It runs
the same [`audioConvo.ts`](realtime/audioConvo.ts) driver as `sim:audio` and streams
transcript + audio to the browser over SSE. Scenarios come from `runAudio.ts`; clips are
cached under `sim/realtime/clips/<scenario>/`.

## Browser smoke — the real app over WebRTC

```bash
npm run sim:e2e
```

On first run it builds the app (`dist/`) and synthesizes patient clips, then launches headless Chromium, overrides `getUserMedia` with a synthetic mic, clicks *Start Call*, and verifies the **actual app** path: app loads → real WebRTC connects → assistant greets → first patient turn is heard & transcribed by `gpt-realtime`. Full browser console (events, mic mute/unmute, latency) → `sim/e2e/last-run.log`.

This is a **one-turn smoke test on purpose.** Injecting synthetic audio into the live WebRTC stream reliably stalls after the first answer — the manual `response.create` after an audio turn returns `response.created`, then the event stream goes silent. We confirmed this is **not a product bug**: the identical session config + manual-response flow runs full multi-turn calls fine in Tier 2 (`sim:audio`). It's an artifact of feeding clean synthetic audio into WebRTC rather than a live mic (the server fires `conversation.item.truncated` and the follow-up response never generates). So multi-turn audio lives in Tier 2; the browser test just proves the real app/WebRTC/token flow works.

## Layout

```
sim/
  lib/        env loader, in-process handler invoker, chat helper
  cases/      matcher cases + personas (Tier 1 — edit these most)
  runMatcher.ts / runConversation.ts / runFlowChecks.ts / index.ts   (Tier 1)
  realtime/   audioConvo.ts (WebSocket driver) + runAudio.ts (Tier 2 scenarios) + viewer.ts (live web viewer)
  e2e/        server + TTS clip gen + Playwright browser smoke
```
