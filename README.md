# Webster Isolated-Intersection Timing Service

An HTTP backend that solves **analytical signal timing for a single isolated
intersection** with the Webster formulas — both for a single instant and for a
**full time-of-day plan** with cycle-length transitions between adjacent
periods. No network simulation, no UI. It is called by upstream signal-timing
tools.

* Node.js 20 + TypeScript (strict)
* Fastify 5 web layer
* PostgreSQL 16 for the named scenario & day-plan archives
* Docker Compose: database + API in one build; automated tests (including the
  PG integration tests) run via the `tests` profile

## What it computes

For each phase `i` the request carries arrival flow `q_i` (veh/h), saturation
flow `s_i` (veh/h) and, per cycle, the total lost time `L` (s).

1. Flow ratios `y_i = q_i / s`, total `Y = Σ y_i`.
2. Webster optimum `C0 = (1.5·L + 5) / (1 − Y)` when no cycle is specified.
3. Effective green by flow ratio `g_i = (C − L)·y_i/Y`; with minimum greens
   the minima are protected first and the remainder is split by flow ratio.
   The identity `Σ g_i + L = C` is enforced to a `1e-9` residual — an
   unbalanced split is an error, never carried downstream.
4. Green ratio `λ_i = g_i/C`, degree of saturation `x_i = q_i/(λ_i·s_i)`.
5. Webster uniform (first-term) delay
   `d_i = 0.5·C·(1−λ_i)² / (1−λ_i·x_i)` (s/veh), phase delay rate
   `q_i·d_i` (veh·s/h), and the intersection total `Σ q_i·d_i`.

### Saturation is guarded on two levels, before the formulas

* **Intersection:** if `Y ≥ 0.99` (within 0.01 of 1) the optimum diverges.
  The service refuses with `OVERSATURATED_Y` and the computed `Y` — on **both**
  the automatic and the explicit-cycle paths. No negative or giant fake cycle.
* **Phase:** even with `Y < 1`, a short cycle or green captured by other
  phases / minimum greens can give `x_i ≥ 1`. The phase is reported with
  `PHASE_SATURATED` instead of producing a non-physical delay.
* If minimum greens do not fit the cycle the request fails with
  `MIN_GREEN_INFEASIBLE`; a phase is never silently zeroed.

### A note on the delay-vs-cycle shape

Under proportional green allocation every phase has the same degree of
saturation at a given cycle, `x = C/(C − Ccrit)` with
`Ccrit = L/(1−Y)`, which diverges at the critical cycle. The first
(uniform) Webster term stays finite there and, over the feasible region,
grows mildly with `C` (longer reds per vehicle). The familiar textbook
picture — total delay falling steeply as `C` moves away from the critical
cycle, bottoming near `C0`, then rising again as green is wasted — is the
**full** Webster curve with its second (random/overflow) term, which
diverges as `x → 1`. This service implements exactly what was specified:
the first term only. Short/over-saturated candidate cycles on a scan are
returned as `error` points (`PHASE_SATURATED` / `CYCLE_TOO_SHORT`), so the
feasible frontier is visible without emitting physically meaningless
delays. Per-phase saturation is still genuinely reachable with `Y < 1`
when minimum greens capture usable time from the other phases.

## Modules

```
src/domain    types, structured errors, thresholds, request validation
src/timing    flowRatios · cycle (C0) · greenSplit · delay · saturation · timing orchestrator
src/scan      fresh per-cycle evaluation + interruptible ScanManager
src/store     ScenarioStore interface, MemoryScenarioStore, PgScenarioStore (16), seed
src/http      Fastify routes (timing, evaluate, scans, scenarios, health)
src/app.ts    application builder (web layer is only an adapter)
src/server.ts entrypoint: DB connect/retry, migrate, seed, listen
```

The timing chain uses **one** arrival-rate array: the same `q` builds `y`,
`saturation` and the `q·d` rate. The structure makes “timing with one q set,
delay with another” impossible.

## Running

```bash
docker compose up --build            # db + API on http://localhost:8080
docker compose --profile tests run --rm tests   # full test suite incl. PG

# local dev (in-memory archive):
npm ci
npm test
npm run build && STORE=memory node dist/server.js
```

On startup the service waits for PostgreSQL, applies the idempotent schema and
seeds `demo-four-phase`: four phases, `Y = 0.70`, `L = 12 s`,
`C0 = 76.67 s` (literature 50–80 s range).

## API

Errors always look like `{ "error": { "code", "message", "details?" } }`
(400 malformed, 404 unknown, 409 scan already finished, 422 physics —
oversaturated / phase saturated / minimum greens infeasible).

### `POST /api/timing` — Y, C0, green ratios
```json
{
  "lostTime": 12,
  "phases": [
    {"q": 720, "s": 1800, "label": "NB/SB through"},
    {"q": 225, "s": 1500, "label": "NB/SB left"},
    {"q": 180, "s": 1800, "label": "EB/WB through"},
    {"q": 90,  "s": 1800, "label": "EB/WB left"}
  ]
}
```
→ `Y`, `optimalCycle`, per-phase `y`, `g`, `lambda`, `x` (split evaluated at C0).

### `POST /api/evaluate` — delays (same body, optional `cycle`)
With `cycle` omitted, uses `C0`. → per-phase `uniformDelay`, `x`, `g`,
`delayRate`, `totalDelayRate`, `greenBalanceResidual`.

### `POST /api/scans` — delay-vs-cycle curve, interruptible
```json
{"lostTime": 12, "phases": [...], "cycles": [45, 60, 77, 120, 200], "pointDelayMs": 0}
```
Returns `202 {id, state:"pending" ...}`. Poll `GET /api/scans/:id`. Each point
is computed **fresh** at its own cycle (`lambda` recomputed); infeasible
candidates appear as `{cycle, status:"error", errorCode}` while the sweep
continues. `DELETE /api/scans/:id` cancels — a cancelled job returns
`state:"cancelled"` and **never** the half-computed points.

### Named scenarios (PostgreSQL)
```
PUT    /api/scenarios/:name           create/replace a definition
GET    /api/scenarios                 list
GET    /api/scenarios/:name           fetch
DELETE /api/scenarios/:name           remove
POST   /api/scenarios/:name/timing    recompute Y/C0/split
POST   /api/scenarios/:name/evaluate  body {"cycle"?: number}; recompute delays
POST   /api/scenarios/:name/scan      body {"cycles": [...]}; recompute sweep
```
Only definitions persist; every fetch re-solves from the stored q/s/L.

### Health
`GET /health` (liveness), `GET /ready` (database reachable).

## Tests lock these relations

* validation precedes formulas (`<2` phases, `q<0`, `s≤0`, `L≤0`)
* `Σg + L = C` within tolerance for automatic and explicit cycles
* larger `L`, everything else fixed ⇒ larger `C0`, no lower per-phase delay
* doubling one phase's `q` (still `Y<1`) ⇒ its `y`/`λ` rise, others' `λ` and
  usable-green shares fall
* `Y → 1` ⇒ `C0` grows sharply; past the 0.99 limit **both** paths refuse
* explicit cycle `= C0` reproduces the automatic `λ` and delays
* zero-flow phase is unsaturated (`x=0`) and needs no green
* phase saturation reported for `C ≤ Ccrit = L/(1−Y)`
* minimum greens protected; infeasible minimums rejected
* scan points are recomputed per cycle, short cycles marked, cancellation
  never publishes a partial curve, parallel scans/cases isolated
* `delayRate` uses the same `q` as the flow ratio
