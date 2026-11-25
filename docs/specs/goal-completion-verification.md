---
title: Goal completion verification
summary: "Adversarial, opt-in verification gate that keeps a session goal open until an independent verifier finds the objective met."
read_when:
  - Changing goal completion, goal continuation, or update_goal behavior
  - Adding an opt-in verification or judgment step to the goal loop
  - Working on the per-goal verification opt-in or its config switch
---

# Goal completion verification

## Goal

An opt-in per-goal gate that stops a session goal from being marked `complete`
on the executor's own say-so. Until the gate passes, the goal stays open and the
existing continuation loop keeps working on the listed gaps.

The feature is **default off**. With the opt-in absent, goal behavior,
continuation scheduling, tool results, and goal state are unchanged. The only
difference on the model-facing surface is that `create_goal` offers the optional
`verify_completion` parameter while the global switch
(`agents.defaults.experimental.goalCompletionVerification`) is on; with the switch
off the parameter is not offered at all and the tool schema is exactly the
pre-feature schema.

## Current state (measured on `origin/prod`, 2026-11-07)

- Goal state lives on the session entry (`SessionEntry.goal`), typed by
  `packages/gateway-protocol/src/schema/sessions-goal.ts`. It already carries an
  unused `continuationTurns: number` field (set to `0` at creation, never
  incremented).
- Transitions are pure functions in `src/config/sessions/goals-transitions.ts`;
  the store wrappers are `src/config/sessions/goals.ts`.
- The model-facing surface is `src/agents/tools/goal-tools.ts`:
  `get_goal`, `create_goal`, `update_goal`. `update_goal` accepts `complete` or
  `blocked` and is applied at face value.
- Turn end is `src/auto-reply/reply/goal-continuation.ts::enqueueGoalContinuation`,
  called from `agent-runner-result.ts` and `followup-runner.ts`. It already
  checks: the run ended normally, no unsettled requester children, the follow-up
  queue is empty, the goal is still `active` and unchanged (session id +
  lifecycle revision + goal id), and placement (local/worker). It returns
  `false` when ineligible — a fail-closed eligibility check with no path that
  blocks the session.
- Precedent for a bounded judgment call with fail-open semantics:
  `src/auto-reply/reply/reply-gate.ts`, which asks a cheap decision model a typed
  boolean through `evaluateDecisionInRegistry`. A fresh, tool-free one-shot LLM
  call is available as `runIsolatedCompletion` (`src/agents/isolated-completion.ts`).

## Design

Two enforcement points, one shared coordinator:

- **Turn end (`enqueueGoalContinuation`)** derives a completion claim from the
  turn's final assistant text, runs the cheap pre-filter, and (only above the
  threshold) runs the verifier. A non-passing verdict turns into the
  continuation nudge, which carries the verbatim objective and the missing
  points.
- **`update_goal`** refuses `complete` without a passing verdict that is still
  current; it returns the missing points instead. This is what makes
  "complete only after PASS" true even when the model claims completion by tool
  call rather than by prose.

Both enforcement points treat an unavailable cheap pre-filter as "run the
verifier", not as "no claim": a classified `false` suppresses the verifier run
(the negative control), while an unavailable, timed-out, or malformed pre-filter
answer still reaches the verifier. Verification fails open; completion fails
closed.

Both read and write the same single-flight verdict record, so a check is never
performed twice for the same goal revision and a stale verdict is never reused.

### Verdict lifetime

The revision is `id:updatedAt:continuationTurns`. An objective edit or a status
transition moves `updatedAt`, and every automatic continuation turn increments
`continuationTurns`; verdict bookkeeping and the attention marker deliberately
preserve it. Ordinary user turns and tool work move none of those, so a recorded
verdict is additionally **dropped when a user-originated turn ends**: at turn end
the coordinator clears the stored verdict (and its attempt count) unless the turn
is an automatic goal continuation. A pass therefore never survives later work
that may have undone the verified result, while the passing handoff and the
normal advance turn keep the verdict they need.

An explicit resume to `active` also clears the stored verification record, so a
resumed goal starts a fresh verification episode instead of inheriting a spent
attempt budget or a prior pass.

### Truth table (binding)

`opt-in` = the per-goal flag is set **and** the global switch is on. Both must
hold; either alone is off. A goal created without the flag is never opted in by
a later global switch.

| Opt-in | Claim signal                | Verifier outcome | Continuation queued                     | `update_goal complete`   | Visible effect                                              |
| ------ | --------------------------- | ---------------- | --------------------------------------- | ------------------------ | ----------------------------------------------------------- |
| off    | any                         | not run          | as today                                | as today                 | unchanged behavior; `create_goal` omits `verify_completion` |
| on     | below threshold             | not run          | as today                                | refused: no verdict      | unchanged                                                   |
| on     | at/above threshold          | pass             | yes (handoff to `update_goal complete`) | accepted                 | goal completes on the executor's own tool call              |
| on     | at/above threshold          | fail             | yes (missing points)                    | refused (missing points) | goal stays open                                             |
| on     | at/above threshold          | unknown          | yes (missing points)                    | refused (missing points) | goal stays open                                             |
| on     | at/above threshold          | error/timeout    | yes (unchanged nudge)                   | refused (unverified)     | turn ends normally                                          |
| on     | explicit `complete` request | not run          | as today                                | refused: no verdict      | goal stays open                                             |

`unknown != pass`. An error or timeout is `unverified`, never `pass`: session
availability fails open, completion authorization fails closed.

A **pass is a bounded executive handoff, never a completion**. On a passing
verdict the coordinator queues exactly one continuation whose prompt tells the
executor that the verifier passed and that it must now call
`update_goal(status: "complete")`. The verifier never completes a goal itself.
Because that handoff is an ordinary goal continuation it consumes the same
continuation budget and the loop ends as soon as the goal is no longer `active`.
The pass is re-bound to the revision the handoff turn runs at, since spending a
continuation turn moves `continuationTurns` and therefore the goal revision.

A verdict the store refuses (`{recorded:false}` — the goal was replaced, cleared,
or moved while the verifier ran) never drives the turn in either direction: no
completion is authorized and automation does not stop. The coordinator re-reads
the current goal state and falls back to today's continuation behavior.

### Trigger gates

The verifier runs only when all hold: opt-in; goal `active`; no unsettled
requester children; no pending operator approval; the goal identity and revision
are unchanged since the claim; no check already in flight for this goal; and
something changed since the last check (the recorded verdict is not already for
this revision).

### Loop protection

Verification never decides whether a session's turn survives. The coordinator call
sits behind a fail-open boundary: any bookkeeping failure (a store write after a
verifier timeout, a registry error) is logged and the turn proceeds exactly as it
would have without the gate — no completion authorized, no stuck session, no
rejected turn finalization.

The existing `continuationTurns` field is the loop budget: it is incremented
once per automatic continuation turn actually started. A separate counter bounds
verifier attempts, including errors, so a failing verifier cannot spin.

When the continuation budget is reached, OpenClaw stops queueing automatic goal
turns, records a "needs attention" marker on the goal, and surfaces the
unresolved criteria, the latest verdict or verification error, and why
automation stopped — once, as a visible message. The goal stays `active` and
incomplete. Exhaustion is never reported as `complete` and never implicitly
becomes `blocked`; resuming is an explicit operator action.

### Verifier contract

One fresh, tool-free call. Input is bounded and delimited as data, never as
instructions: the objective verbatim, the claim, and the evidence the executor
reported (labelled as a claim, not an independent observation). No transcript
dump, no secrets. Output is strict JSON — `pass | fail | unknown`, missing
points, evidence considered, risks — and anything that does not validate to that
shape is `unverified`, never `pass`. The verifier model is configurable and is
not the executing model.

Validation is strict about the whole documented shape: all three arrays must be
present and must hold only strings, and the visible answer must be exactly one
JSON object (a single Markdown code fence around it is tolerated, prose is not).
`{"outcome":"pass"}` is `unverified`.

The **objective is verbatim or not verified at all**. Goal objectives are capped
at 16,000 characters by the protocol; the verifier bound is 4,000 characters, and
an objective longer than that returns `unverified` (`objective-too-long`) rather
than being clipped, because a clipped objective would let a partial objective be
approved. The continuation nudge carries the goal's full objective, bounded only
by the protocol's 16,000-character cap.

## Accepted edges

- **A delivery failure of the stopped-loop notice is logged, not retried.** The
  attention marker is committed before the goal-changed notice is recorded. If
  that second write fails, the marker is already durable, so the loop stays
  stopped and the failure is recorded as a warning
  (`goal attention notice could not be recorded`) instead of being swallowed.
  The failed notice never changes goal state, and it is not retried because the
  marker is the once-only delivery guard; the stop is still visible in the goal's
  status and in the log, and resuming is an explicit operator action.

## Out of scope

- Any automatic merging of a verdict into goal completion without the
  `update_goal` path.
- Full artifact/diff manifests as verifier evidence.
- Changing the default-off behavior of existing goals.
