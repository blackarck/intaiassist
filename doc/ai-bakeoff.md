# AI model bake-off, 2026-11-19

Run: `backend/test/ai.live.test.ts` (see `doc/coaching.md`). Each model alone (primary = fallback), 3 runs per task, from the
developer machine over the internet, on ONE built-in sample input per task.

**What this measures:** the model returns valid JSON that passes our schema and the task's `finalize` checks (real quotes, no
repeats, score fits dimensions, no verdict), and how long it takes. **What it does not measure:** whether the *score or advice is
good*. That needs the calibration set (strong / weak / confident-but-wrong answers). Treat latency as indicative: one sample,
three runs, no concurrency, one network path.

All 105 calls (7 models x 3 fast tasks x 3, 5 models x 2 slow tasks x 3) returned valid, accepted output.

## Fast tasks (median ms; limit is about 6 s for `next_questions` / `assist`)

| Model | opening_questions | next_questions | assist |
|---|---|---|---|
| azure:gpt-5.4-nano | 4725 | 2692 | 1661 |
| **azure:gpt-5.4-mini** | **3978** | **1478** | **1229** |
| azure:gpt-5.6-luna | 7033 | 1733 | 2406 |
| azure:gpt-6-luna | 15590 | 2427 | 2492 |
| anthropic:haiku | 10189 | 2727 | 1939 |
| azure:llama-4-maverick | 4535 | 2298 | 1654 |
| azure:gpt-oss-120b | 5820 | 1902 | 1435 |

## Slow tasks (median ms; background, deadline 60-90 s)

| Model | score_answer | scorecard |
|---|---|---|
| **anthropic:sonnet** | **4649** | **6564** |
| azure:gpt-5.4 | 3632 | 21278 |
| azure:gpt-6-astra | 10761 | 7413 |
| anthropic:haiku | 3133 | 4260 |
| azure:gpt-5.6-terra | 3455 | 6454 |

## Conclusions

- Every candidate is fast enough for the suggestion tasks; the choice there is about **quality and cost**, not speed.
  Defaults stay: primary `azure:gpt-5.4-mini` (fastest in all three), fallback `anthropic:haiku` (different provider, so an
  outage at one does not take both).
- Scoring is not latency-bound at all (3 to 11 s), so pick it on **quality**: default stays `anthropic:sonnet`, fallback
  `azure:gpt-5.4`. The calibration eval decides whether a cheaper model (haiku, gpt-5.4-mini) scores as consistently.
- `opening_questions` is slow on gpt-6-luna (15 s) and haiku (10 s); it runs once at room setup with a 20 s deadline, so only
  the fast models are comfortable.
- Not tried: deepseek, qwen, mai-code, microsoft-decision (not deployed on our Foundry resource).
