---
summary: "Typed workflow runtime for OpenClaw with resumable approval and input gates."
title: Lobster
read_when:
  - You want repeatable multi-step workflows with approvals or structured questions
  - You need to resume a workflow without re-running earlier steps
---

Lobster runs multi-step tool pipelines as one repeatable tool call, with
explicit approval/input checkpoints and resume tokens. Checkpoints belong
to the Lobster runner, not a separate orchestration registry.

## Why

Without Lobster, a multi-step job means many round-trip tool calls, with the
model orchestrating every step. Lobster moves that orchestration into a typed
runtime:

- **One call instead of many**: a single Lobster tool call returns a structured
  result for the whole pipeline.
- **Approvals built in**: side effects (send, post, delete) halt the workflow
  until explicitly approved.
- **Resumable**: a halted workflow returns a token; approve and resume without
  re-running earlier steps.

Lobster is a small, constrained DSL rather than a general scripting language:
approve/resume is a durable, built-in primitive; pipelines are data (easy to
log, diff, replay, review); the tiny grammar limits "creative" code paths so
validation stays realistic; timeouts, output caps, sandbox checks, and
allowlists are enforced by the runtime, not by each script. Each step can still
call any CLI or script - generate `.lobster` files from other tooling if you
want a richer authoring language.

Without Lobster, a recurring email triage looks like:

```text
User: "Check my email and draft replies"
→ openclaw calls gmail.list
→ LLM summarizes
→ User: "draft replies to #2 and #5"
→ LLM drafts
→ User: "send #2"
→ openclaw calls gmail.send
(repeat daily, no memory of what was triaged)
```

With Lobster, the same job is one call that halts for approval and resumes:

```json
{ "action": "run", "pipeline": "email.triage --limit 20", "timeoutMs": 30000 }
```

```json
{
  "ok": true,
  "status": "needs_approval",
  "output": [{ "summary": "5 need replies, 2 need action" }],
  "requiresApproval": {
    "type": "approval_request",
    "prompt": "Send 2 draft replies?",
    "items": [],
    "resumeToken": "..."
  }
}
```

## How it works

The separately installed official `@openclaw/lobster` plugin runs Lobster
workflows **in-process** using its embedded `@clawdbot/lobster` runtime. No
external `lobster` subprocess is spawned; the tool call returns a JSON envelope
directly. If the pipeline halts for approval or input, Lobster saves its
continuation and returns a resume token. Approval requests can also carry a
short approval ID. The call ends at the checkpoint; no process waits for the
user's answer.

Lobster validates workflow input and LLM output schemas on Node, Bun, and AOT
standalone hosts. Schema validation uses the host runtime profile automatically;
there is no extra setting to enable it.

## Enable

Lobster is an **optional** plugin tool, not installed or enabled by default.
Install the official plugin:

```bash
openclaw plugins install @openclaw/lobster
```

Installation applies to a running Gateway automatically; otherwise it takes effect
on the next startup. See [Apply changes and inspect](/plugins/manage-plugins#apply-changes-and-inspect).

Then allow the tool globally:

```json
{
  "tools": {
    "alsoAllow": ["lobster"]
  }
}
```

Or per-agent:

```json
{
  "agents": {
    "entries": {
      "main": {
        "tools": {
          "alsoAllow": ["lobster"]
        }
      }
    }
  }
}
```

<Note>
`alsoAllow` adds `lobster` on top of the active tool profile without
restricting other core tools. Use `tools.allow` only if you want a restrictive
allowlist mode instead.
</Note>

The tool is disabled entirely for sandboxed tool contexts.

If you need the standalone Lobster CLI for development or external pipelines
(outside the embedded gateway runner), install it from the
[Lobster repo](https://github.com/openclaw/lobster) and put `lobster` on
`PATH`.

## Pattern: small CLI + JSON pipes + approvals

Build tiny commands that speak JSON, then chain them into one Lobster call.
(Example command names below - swap in your own.)

```bash
inbox list --json
inbox categorize --json
inbox apply --json
```

```json
{
  "action": "run",
  "pipeline": "exec --json --shell 'inbox list --json' | exec --stdin json --shell 'inbox categorize --json' | exec --stdin json --shell 'inbox apply --json' | approve --preview-from-stdin --limit 5 --prompt 'Apply changes?'",
  "timeoutMs": 30000
}
```

If the pipeline requests approval, resume with the token:

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

Example: map input items into tool calls:

```bash
gog.gmail.search --query 'newer_than:1d' \
  | openclaw.invoke --tool message --action send --each --item-key message --args-json '{"provider":"telegram","to":"..."}'
```

## JSON-only LLM steps (llm-task)

For a **structured LLM step** inside a workflow, enable the optional
`llm-task` plugin tool and call it from Lobster:

```json
{
  "plugins": {
    "entries": {
      "llm-task": { "enabled": true }
    }
  },
  "agents": {
    "entries": {
      "main": {
        "tools": { "alsoAllow": ["llm-task"] }
      }
    }
  }
}
```

### Important limitation: embedded Lobster vs `openclaw.invoke`

The installed Lobster plugin runs workflows **in-process** inside the gateway.
In that embedded mode, `openclaw.invoke` does **not** automatically inherit a
gateway URL/auth context for nested OpenClaw CLI tool calls.

That means this pattern is **not currently reliable in the embedded runner**:

```lobster
openclaw.invoke --tool llm-task --action json --args-json '{ ... }'
```

Use the example below only when running the **standalone Lobster CLI** in an
environment where `openclaw.invoke` is already configured with the correct
gateway/auth context.

For `openclaw.invoke` and `clawd.invoke`, ambient `OPENCLAW_TOKEN` or
`CLAWD_TOKEN` credentials are accepted only for `localhost`, `127.0.0.1`, or
`[::1]` destinations. To send credentials to another HTTP(S) endpoint, pass
`--token` explicitly. This rule also applies to embedded workflows that
explicitly configure a remote connection. This command argument is the remote
Gateway credential, not the Lobster tool's approval-resume `token` parameter.
If an invocation times out or fails after dispatch,
Lobster does not retry it automatically, because the Gateway may already have
performed the action.

```lobster
openclaw.invoke --tool llm-task --action json --args-json '{
  "prompt": "Given the input email, return intent and draft.",
  "thinking": "low",
  "input": { "subject": "Hello", "body": "Can you help?" },
  "schema": {
    "type": "object",
    "properties": {
      "intent": { "type": "string" },
      "draft": { "type": "string" }
    },
    "required": ["intent", "draft"],
    "additionalProperties": false
  }
}'
```

If you are using the embedded Lobster plugin today, prefer either:

- a direct `llm-task` tool call outside Lobster, or
- non-`openclaw.invoke` steps inside the Lobster pipeline. For a **typed decision**, use the
  embedded `decision.evaluate` bridge below rather than an LLM step.

See [LLM Task](/tools/llm-task) for details and configuration options.

## Decision-layer steps (decision.evaluate)

The embedded Lobster plugin injects one extra command, `decision.evaluate`, which asks the
agent's selected **decision model** a typed question and resolves a **route** a workflow can
branch on. It runs the decision layer **in-process** through the host's bound runtime: no
`openclaw.invoke`, no gateway URL, no LLM envelope. A decision is not a completion, so the
answer is never a free-text string the workflow has to parse.

The command emits **exactly one item**, so `$step.json.route` resolves:

```json
{
  "status": "ok",
  "type": "choice",
  "question": "route",
  "route": "A",
  "answer": { "type": "choice", "choice": "A", "probabilities": { "A": 0.83, "B": 0.17 } },
  "policy": { "minConfidence": 0.5 },
  "model": "kev-latest",
  "provenance": {
    "providerId": "typesafe",
    "rubricVersion": "lobster-bridge-v1-...",
    "runtimeGeneration": "..."
  }
}
```

`route` is always a string: a choice label, `"true"`/`"false"` for a boolean question, or the
decimal level index for a score question. A workflow branches on it with the symbolic
operators (`==`, `!=`, `<`, `<=`, `>`, `>=`, `&&`, `||`, `!` — word operators such as `gt` are
rejected):

```yaml
name: route-a-or-b
args:
  evidence:
    default: "a routine dependency bump with green CI"
steps:
  - id: route
    pipeline: 'decision.evaluate --questions-json ''{"route":{"type":"choice","criteria":{"A":"safe to proceed automatically","B":"needs human review"}}}'' --state-json ''{"evidence":"a routine dependency bump with green CI"}'' --min-confidence 0.5'
  - id: proceed
    command: "deploy --lane auto"
    condition: $route.json.route == 'A'
  - id: review
    command: "open-review"
    condition: $route.json.route == 'B'
```

### Arguments

| Flag                      | Meaning                                                                                                                                 |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `--questions-json <json>` | Required. Non-empty map of `boolean`, `choice`, or `score` questions (the host decision contract).                                      |
| `--state-json <json>`     | The state to evaluate. Omitted: the command consumes the pipeline input instead (one item becomes the state, several become the array). |
| `--question <id>`         | Required when the map has more than one entry; must be a key of the map.                                                                |
| `--min-confidence <n>`    | Acceptance floor in `[0, 1]` for the answer's provider-reported confidence.                                                             |
| `--min-probability <n>`   | Boolean questions only, in `(0.5, 1]`.                                                                                                  |
| `--min-margin <n>`        | Minimum top-two probability gap in `[0, 1)`.                                                                                            |
| `--timeout-ms <n>`        | Host evaluation timeout; bounded to the plugin's maximum.                                                                               |

At least one acceptance flag is required, and a route is only resolved when it is **declared**:
a route with no threshold would be a guess. `--min-confidence` and `--min-margin` apply to choice
and score questions; a boolean question takes `--min-probability` only, and an unsupported flag for
the question type is refused rather than silently ignored. The command requires a bound agent
identity; a run without one fails instead of borrowing another agent's decision model.

### Fail-closed semantics

The bridge never guesses a route. Each case below **stops the workflow terminally**, so **no branch
runs**:

- the decision layer is unreachable, unavailable, or returns a malformed/unexpected result;
- the selected answer is missing, or its type does not match the declared question;
- no acceptance flag was supplied, or a flag is outside its bounds;
- **choice**: the provider label is not a key of `probabilities`, a required confidence is
  missing or below `--min-confidence`, the label is not the distribution's unique strict argmax
  (a tie, or a label that disagrees with the argmax), or the margin is below `--min-margin`;
- **boolean**: `probabilityTrue` falls in the ambiguous middle band (above `1 - min` and below
  `min`), `--min-probability` was not supplied, or an unsupported `--min-confidence`/`--min-margin`
  was declared for the boolean question;
- **score**: a required confidence is missing/low, the probability array length disagrees with
  the rubric, there is no unique strict argmax level, or the margin is below `--min-margin`.

The rejection is returned as a **halted pipeline stage**, not as an ordinary error. That matters:
the run engine rethrows a halted stage _before_ a step's own `on_error`/`retry` handling, so a
workflow cannot recover a route it never resolved. With a plain error, `on_error: continue` would
swallow the rejection and a later negated condition (`$route.json.route != 'A'`) could run anyway.
The embedded runner additionally refuses to report a stopped decision as a successful run: a
rejected pipeline fails even though the engine treats the halt as a normal end. A genuine caller
cancellation or step timeout is rethrown as a cancellation, not reported as a rejected decision.

Two rules are **bridge policy**, not provider semantics, and are named as such in the code: the
choice route follows the label only when the label is also the unique argmax (the host contract
explicitly allows a provider label that differs from the rounded distribution's argmax, and the
bridge refuses to silently prefer one over the other), and the score route is the argmax level
index while the provider's fractional `score` is passed through unchanged and never rounded.

Because results never authorize actions, the branch bodies remain an ordinary, separately
authorised step: the bridge decides _which_ branch, not _whether_ the action is permitted.

## Workflow files (.lobster)

Lobster can run YAML/JSON workflow files with `name`, `args`, `steps`, `env`,
`condition`, and `approval` fields. Set `pipeline` to the file path in the tool
call.

```yaml
name: inbox-triage
args:
  tag:
    default: "family"
steps:
  - id: collect
    command: inbox list --json
  - id: categorize
    command: inbox categorize --json
    stdin: $collect.stdout
  - id: approve
    command: inbox apply --approve
    stdin: $categorize.stdout
    approval: required
  - id: execute
    command: inbox apply --execute
    stdin: $categorize.stdout
    condition: $approve.approved
```

Notes:

- `stdin: $step.stdout` and `stdin: $step.json` pass a prior step's output.
- `condition` (or `when`) can gate steps on `$step.approved`.

### Injected environment variables

Every step shell inherits the parent environment plus these Lobster-injected
variables, so commands can reference resolved workflow args without embedding
raw values into the command string:

- `LOBSTER_ARG_<NAME>` - one per workflow arg. The name is uppercased with each
  run of non-alphanumeric characters collapsed to `_`, so arg `user-id` becomes
  `LOBSTER_ARG_USER_ID`.
- `LOBSTER_ARGS_JSON` - every resolved arg as a single JSON string.

That is the complete injected set. There are **no** per-step output variables
such as `LOBSTER_STEP_<id>_STDOUT` or `LOBSTER_STEP_<id>_JSON_<field>`; shells
treat those names as unset, so parameter-expansion defaults can hide the error.
Read a prior step's output through step references instead - `$step.stdout`,
`$step.json`, or `$step.json.<field>` - in a `stdin:`, `env:`, or `condition:`
value. (`LOBSTER_STATE_DIR` is a separate runtime setting for the state
directory, not a per-run arg.)

## Tool parameters

### `run`

```json
{
  "action": "run",
  "pipeline": "gog.gmail.search --query 'newer_than:1d' | email.triage",
  "cwd": "workspace",
  "timeoutMs": 30000,
  "maxStdoutBytes": 512000
}
```

Run a workflow file with args:

```json
{
  "action": "run",
  "pipeline": "/path/to/inbox-triage.lobster",
  "argsJson": "{\"tag\":\"family\"}"
}
```

| Field            | Default     | Notes                                                                                                        |
| ---------------- | ----------- | ------------------------------------------------------------------------------------------------------------ |
| `pipeline`       | required    | Inline pipeline string, or a path ending in `.lobster`/`.yaml`/`.yml`/`.json` for a workflow file.           |
| `cwd`            | gateway cwd | Relative working directory; must resolve inside the gateway working directory (absolute paths are rejected). |
| `timeoutMs`      | `20000`     | Aborts the run if exceeded.                                                                                  |
| `maxStdoutBytes` | `512000`    | Aborts if captured stdout, stderr, or the embedded JSON result exceeds this size.                            |
| `argsJson`       | -           | JSON string of args for a workflow file (ignored for inline pipelines).                                      |

### `resume`

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

For approvals, use `token` or `approvalId` from `requiresApproval` and a boolean
`approve`. For input, use `token` from `requiresInput` and `responseJson`.
To cancel either kind of checkpoint, use `cancel: true` instead of a decision.
Supply exactly one of `approve`, `responseJson`, or `cancel: true`.

### Structured input

A workflow `input` step or an inline `ask` stage returns `needs_input` with the
question, a JSON Schema and a resume token. Optional `defaults` and `subject`
provide suggested values and material to review. For example:

```json
{
  "status": "needs_input",
  "requiresInput": {
    "type": "input_request",
    "prompt": "What feedback should be included?",
    "responseSchema": { "type": "string" },
    "resumeToken": "<resumeToken>"
  }
}
```

The agent presents the question in chat, then sends the user's answer as JSON:

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "responseJson": "\"Please shorten the introduction.\""
}
```

`responseJson` can encode any value allowed by the returned schema, not just an
object. Lobster validates the answer before continuing. Invalid JSON or an
answer that does not match the schema leaves the checkpoint available for
correction. A resume can return another question or approval request.

This is a chat/tool interaction, not an Inbox card or form. The plugin does not
list pending checkpoints; retain the returned token to resume later. As with
approval tokens, possession of an input token permits resume by a caller allowed
to use the tool; tokens are not bound to an OpenClaw user or session.

## Output envelope

Lobster returns a JSON envelope with one of four statuses:

- `ok` - finished successfully
- `needs_approval` - paused; `requiresApproval` carries a `resumeToken` and a
  short `approvalId`, either of which can resume the run
- `needs_input` - paused; `requiresInput` carries the question, answer schema
  and `resumeToken`
- `cancelled` - explicitly denied or cancelled

The tool surfaces the envelope in both `content` (pretty JSON) and `details`
(raw object).

## Approvals

If `requiresApproval` is present, inspect the prompt and decide:

- `approve: true` - resume and continue side effects
- `approve: false` - cancel and finalize the workflow

Use `approve --preview-from-stdin --limit N` to attach a JSON preview to
approval requests without custom jq/heredoc glue. Resume state is stored as
small JSON files under the Lobster state directory (`~/.lobster/state` by
default, override with `LOBSTER_STATE_DIR`); the token itself only encodes a
pointer to that state, not the full pipeline state.

## Safety

- **Local in-process only** - workflows execute inside the gateway process; no
  network calls from the plugin itself.
- **No secrets** - Lobster doesn't manage OAuth; it calls OpenClaw tools that
  do.
- **Sandbox-aware** - disabled when the tool context is sandboxed.
- **Hardened** - timeouts and output caps enforced by the embedded runner.

## Troubleshooting

| Error                                                         | Cause / fix                                                                      |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `lobster runtime timed out`                                   | Pipeline exceeded `timeoutMs`. Increase it or split the pipeline.                |
| `lobster stdout exceeded maxStdoutBytes` (or `stderr`)        | Captured output exceeded the cap. Raise `maxStdoutBytes` or reduce output.       |
| `lobster runtime result exceeded maxStdoutBytes`              | The JSON result exceeded the cap. Raise `maxStdoutBytes` or reduce output.       |
| `run --args-json must be valid JSON`                          | `argsJson` (workflow-file runs) failed to parse. Fix the JSON string.            |
| `lobster runtime failed` (or another `runtime_error` message) | The embedded runtime returned an error envelope. Check gateway logs for details. |

## Learn more

- [Plugins](/tools/plugin)
- [Plugin tool authoring](/plugins/building-plugins#registering-agent-tools)

## Case study: community workflows

One public example: a "second brain" CLI + Lobster pipelines that manage three
Markdown vaults (personal, partner, shared). The CLI emits JSON for stats,
inbox listings, and stale scans; Lobster chains those commands into workflows
like `weekly-review`, `inbox-triage`, `memory-consolidation`, and
`shared-task-sync`, each with approval gates. AI handles judgment
(categorization) when available and falls back to fixed rules when
not.

- Thread: [https://x.com/plattenschieber/status/2014508656335770033](https://x.com/plattenschieber/status/2014508656335770033)
- Repo: [https://github.com/bloomedai/brain-cli](https://github.com/bloomedai/brain-cli)

## Related

- [Automation](/automation) - all automation mechanisms
- [Tools Overview](/tools) - all available agent tools
- [Lobster plugin reference](/plugins/reference/lobster) - manifest, config, and tool reference for the plugin
