---
summary: "CLI reference for `openclaw workboard` cards, dispatch, and worker runs"
read_when:
  - You want to inspect or create Workboard cards from the terminal
  - You want to dispatch Workboard worker runs from the CLI
  - You are debugging Workboard CLI or slash command behavior
title: "Workboard CLI"
---

`openclaw workboard` is the terminal surface for the bundled [Workboard plugin](/plugins/workboard). It lets an operator list cards, create a card, inspect one card, and ask the running Gateway to dispatch ready work into subagent worker runs.

Enable the plugin before using the command:

```bash
openclaw plugins enable workboard
openclaw gateway restart
```

## Usage

```bash
openclaw workboard list [--board <id>] [--status <status>] [--include-archived] [--json]
openclaw workboard create <title...> [--notes <text>] [--status <status>] [--priority <priority>] [--agent <id>] [--board <id>] [--labels <items>] [--replaces <name>] [--parallelizable] [--max-concurrent-per-owner <count>] [--dispatch-mode <mode>] [--json]
openclaw workboard show <id> [--json]
openclaw workboard move <id> --status <status> [--json]
openclaw workboard update <id> [--labels-add <items>] [--labels-remove <items>] [--replaces <name>] [--parallelizable [value]] [--max-concurrent-per-owner <count>] [--dispatch-mode <mode>] [--json]
openclaw workboard dispatch [--board <id>] [--max-starts <count>] [--admin] [--url <url>] [--token <token>] [--timeout <ms>] [--json]
```

The command uses the same plugin-owned SQLite database as the dashboard and Workboard agent tools. When a local Gateway owns the state directory, commands route through that Gateway before opening the store. With the Gateway stopped, commands acquire exclusive offline ownership and close the store before releasing it. An unavailable, older, or rejecting live Gateway never triggers a local write fallback; fix its connection or stop it through its service owner and retry. Card ids are UUIDs. Commands that accept a card id also accept an unambiguous id prefix. The compact text output shows the first 8 characters.

Valid `status` values: `triage`, `backlog`, `todo`, `scheduled`, `ready`, `running`, `review`, `blocked`, `done`. Valid `priority` values: `low`, `normal`, `high`, `urgent`.

## `list`

```bash
openclaw workboard list
openclaw workboard list --board default --status ready
openclaw workboard list --json
```

Text output is compact:

```text
7f4a2c10  ready     high    default agent-a  Fix stale worker heartbeat
```

Columns are id prefix, status, priority, board id, optional agent id, and title.

An invalid `--status` exits with an error listing the allowed values instead of returning an empty list.

| Flag                 | Purpose                                       |
| -------------------- | --------------------------------------------- |
| `--board <id>`       | Limit results to one board namespace          |
| `--status <status>`  | Limit results to one Workboard status         |
| `--include-archived` | Include archived cards in compact text output |
| `--json`             | Print the full card list as machine JSON      |

Compact text output hides archived cards by default so the CLI matches `/workboard list`. Pass `--include-archived` to show them. JSON output always keeps the full card list, including archived cards, for existing automation.

## `create`

```bash
openclaw workboard create "Fix stale worker heartbeat" --priority high --labels bug,workboard
openclaw workboard create "Write Workboard docs" --status ready --agent docs-agent --board docs --notes "Cover CLI, slash command, dispatch, and SQLite state."
```

| Flag                                 | Purpose                                                                           |
| ------------------------------------ | --------------------------------------------------------------------------------- |
| `--notes <text>`                     | Initial card notes                                                                |
| `--status <status>`                  | Initial status, default `todo`                                                    |
| `--priority <priority>`              | Priority, default `normal`                                                        |
| `--agent <id>`                       | Assign the card to an agent or owner id                                           |
| `--board <id>`                       | Store the card on a board namespace                                               |
| `--labels <items>`                   | Comma-separated labels; classification labels follow the board's palette          |
| `--replaces <name>`                  | Classification a new label overwrites when the board palette is full (10)         |
| `--parallelizable`                   | Add the `parallelizable` label so the card can run beside cards of the same owner |
| `--max-concurrent-per-owner <count>` | Owner slot ceiling for parallelizable cards, default `1`, maximum `16`            |
| `--dispatch-mode <mode>`             | `native` (default, the local dispatcher places and starts it) or `external`       |
| `--json`                             | Print the created card as machine JSON                                            |

`create` writes through the selected state owner. The card is immediately visible in the Control UI Workboard tab and to Workboard tools.

## `show`

```bash
openclaw workboard show 7f4a2c10
openclaw workboard show 7f4a2c10 --json
```

Text output prints the compact card line and notes. JSON output returns the full card record, including execution metadata, attempts, comments, links, proof, artifacts, worker logs, protocol state, diagnostics, and automation metadata.

Proof statuses in JSON are worker-reported outcomes. `passed` records the worker's
self-assessment of the attached command or check. It is not an independent verification
result.

## `move`

```bash
openclaw workboard move 7f4a2c10 --status review
openclaw workboard move 7f4a2c10 --status done --json
```

`move` changes the card's status using the same manual-operator path as dragging a card in the dashboard. It accepts a full card id or an unambiguous prefix. Active dependency and schedule holds still apply. Operators may move a claimed card without its agent claim token. Claim tokens remain scoped to agent-tool mutations, and JSON output redacts them.

This command writes through the selected state owner, using Gateway RPC while
the Gateway is running and exclusive offline ownership when it is stopped.

## `update`

```bash
openclaw workboard update 7f4a2c10 --labels-add bug,docs
openclaw workboard update 7f4a2c10 --labels-remove stale --labels-add docs
openclaw workboard update 7f4a2c10 --labels-add security --replaces chore
openclaw workboard update 7f4a2c10 --parallelizable --max-concurrent-per-owner 3
openclaw workboard update 7f4a2c10 --max-concurrent-per-owner 0
openclaw workboard update 7f4a2c10 --dispatch-mode external
openclaw workboard update 7f4a2c10 --parallelizable=false --json
```

`update` edits an existing card's labels by name, opts it in or out of [parallel owner slots](/plugins/workboard#owner-slots-and-opt-in-parallelism), or moves it between [external placement](/plugins/workboard#external-placement) and the local dispatcher. It accepts a full card id or an unambiguous prefix and needs at least one of the flags below.

| Flag                                 | Purpose                                                                                                                     |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `--labels-add <items>`               | Add comma-separated labels that are not already on the card; new names follow the board palette                             |
| `--labels-remove <items>`            | Remove comma-separated labels, matched case-insensitively                                                                   |
| `--replaces <name>`                  | Palette classification a new `--labels-add` name overwrites when the board palette is full (`10`); with `--labels-add` only |
| `--parallelizable [value]`           | Turn the opt-in on (bare, `true`, `1`, `yes`) or off (`false`, `0`, `no`)                                                   |
| `--max-concurrent-per-owner <count>` | Set the owner slot ceiling to an integer from `1` to `16`; `0` clears it back to default                                    |
| `--dispatch-mode <mode>`             | `native` (default) keeps local placement; `external` hands the card to a controller outside this Gateway                    |
| `--json`                             | Print the updated card as machine JSON                                                                                      |

Label edits mirror [`workboard_update`](/plugins/workboard#labels-and-the-classification-palette): removals and additions run against the card that was read, other labels stay, and an empty patch (a removal that matched nothing) is a no-op. An added name that already exists on the board palette reuses the palette's spelling; a new name takes the next free slot; on a full palette the write is refused and names the current classifications and the `replaces` step, unless `--replaces <name>` names an existing classification to overwrite. `--replaces` without `--labels-add` is an error. Label edits and the parallel opt-in can be combined in one write.

Turning parallelism on sets `metadata.automation.parallelizable` and adds the `parallelizable` label. `create --parallelizable` only adds the label, so an `update` card carries both markers while a created card may carry the label alone; either marker opts the card in. Turning parallelism off clears the flag and also removes the `parallelizable` label in any letter case, because the label alone keeps a card opted in. Other labels are kept. Without `--parallelizable`, labels are left alone.

Labels are capped at 12 entries, so a card that already carries 12 other labels keeps the automation flag but not the added label. The card still runs in parallel; only the visible label is skipped.

Clearing the ceiling with `0` removes `maxConcurrentPerOwner` from the card, so the owner falls back to a single slot even if the card stays parallelizable. An invalid value, such as a negative, fractional, or non-numeric count or a count above `16`, exits with an error before anything is written.

`--dispatch-mode external` writes `metadata.automation.dispatchMode` and hands the card to a controller outside this Gateway: the local dispatcher then never claims or starts it, and `dispatch` and the card's **Start** refuse it with a message naming the external mode. `--dispatch-mode native` (or omitting the field) returns it to local placement. An unknown mode is rejected before anything is written. Dependency promotion and claim cleanup still apply to external cards, and the external controller claims, heartbeats, and completes them through the normal flow.

`update` writes through the selected state owner like `move`. A card changed by someone else between the read and the write is rejected instead of overwritten; run the command again.

## `dispatch`

```bash
openclaw workboard dispatch
openclaw workboard dispatch --json
openclaw workboard dispatch --max-starts 10
openclaw workboard dispatch --admin
openclaw workboard dispatch --url http://127.0.0.1:18789 --token "$OPENCLAW_GATEWAY_TOKEN"
```

`dispatch` selects the active Gateway before opening local Workboard state. Implicit local requests use the owner-bound `workboard.cards.dispatch.owner` RPC. That method uses the same subagent runtime as the dashboard dispatch action. Ready cards therefore become task-tracked worker runs with linked session keys. `--max-starts` uses `workboard.cards.dispatchWithOptions.owner` for the implicit local Gateway. Older Gateways or Workboard plugins without owner routing refuse before starting workers; explicit remote targets retain the existing `workboard.cards.dispatch` and `workboard.cards.dispatchWithOptions` contracts. Restart the Gateway after upgrading, before you use the flag. Cards with an assigned agent use agent-scoped subagent session keys. Unassigned cards keep an unscoped subagent key, so the Gateway's configured default agent is preserved.

The dispatch loop:

1. Promotes dependency-ready children to `ready`.
2. Blocks expired claims or timed-out worker runs.
3. Selects a small batch of unclaimed ready cards.
4. Claims each selected card for the dispatcher or assigned agent.
5. Starts a subagent worker run with bounded card context and the card claim token.
6. Stores the worker run id, session key, execution status, and worker log on the card.

Idle scans leave ready-card history unchanged. Existing dispatch counters and
timestamps remain as historical values; new launches use the card's launch,
attempt, and execution history.

Selection is conservative. One dispatch starts at most three workers by default. It skips archived or already-claimed cards. Each owner or agent may hold one active (running or claimed) card at a time, counted across boards; a board's `maxActivePerOwner` orchestration setting raises that limit for its cards (see [Worker selection](/plugins/workboard#worker-selection)). Cards over the limit are left for a later dispatch. Pass `--max-starts <count>` with a positive integer to change the per-pass cap. The per-owner limit still applies, so the effective number of starts can be lower.

If worker start fails after a card is claimed, Workboard blocks that card and clears the claim. It records the failure in card execution and worker-log metadata. Failed starts stay visible instead of returning the card to the queue silently.

If the card's fixed worker session is archived, dispatch refuses before claiming
the card, leaves its retry budget unchanged, and records recovery guidance in the
card's worker log and dispatch result. Run `openclaw sessions delete <worker key>`
so the next dispatch starts a fresh worker, or restore the session to continue it.
The diagnostic includes the exact worker key. Dispatch does not change the session.

The CLI falls back to data-only dispatch against local Workboard state when both of these are true:

- You give no explicit Gateway target.
- The local Gateway is stopped and the CLI can acquire exclusive offline state ownership.

Data-only dispatch can still promote dependencies, clean stale claims, and block timed-out runs, but it does not start workers. A live owner that cannot be reached, lacks the required method, or rejects the request never triggers local fallback. Auth, permission, validation, and explicit-target failures are reported directly. After an uncertain reply, inspect the board before retrying.

Data-only dispatch requires the Gateway to be stopped. A connection error or
missing RPC method alone does not establish that it stopped. A running Gateway
does not poll for mutations made by another process.

Text output reports worker starts:

```text
dispatch complete: started=2 failures=0
```

When a worker cannot start, text output also prints its card id prefix and the failure reason. JSON output includes the same reason in `startFailures`.

For a card already authorized for full-host workspace access, a refusal because the current caller is limited to configured workspaces includes a `--admin` hint. This requests `operator.admin`; the Gateway must approve that scope. The hint does not apply to cards with restricted, read-only, or unknown persisted workspace authority, and `--admin` does not override those limits.

Fallback output is explicit:

```text
gateway unavailable; data dispatch only: promoted=1 blocked=0
```

JSON output includes the dispatch result. Gateway-backed dispatch can include `started` and `startFailures`. Data-only fallback includes `gatewayUnavailable: true` and empty `started` and `startFailures` arrays. Claim tokens are redacted from card JSON output.

In the dashboard, the same dispatch result appears as a short summary. An operator can see how many cards started, promoted, blocked, reclaimed, or failed without opening card details.

## Slash command parity

Command-capable channels can use the matching slash command:

```text
/workboard list
/workboard show 7f4a2c10
/workboard create Fix stale worker heartbeat
/workboard move 7f4a2c10 --status review
/workboard dispatch
```

Slash command dispatch also uses the Gateway subagent runtime. It follows the same claim, worker-start, and failure behavior as the dashboard and CLI Gateway path.

`/workboard list` and `/workboard show` are read commands for authorized command senders. `/workboard create`, `/workboard move`, and `/workboard dispatch` mutate board state and require owner status on chat surfaces or a Gateway client with `operator.write` or `operator.admin`.

## Permissions

The CLI dispatch path normally requests Gateway `operator.write` and `operator.read` scopes. Workspace-bound cards run directly in an exact configured agent workspace. A worktree request is narrowed to that directory, so the host does not materialize repository-controlled code. The selected worker must have writable, non-shared Docker sandbox access to that exact workspace, a live container hash matching the requested mounts and policy, and no host escape capability. Pass `--admin` to explicitly request `operator.admin`, allow another host checkout, and use normal managed-worktree setup. The connection fails if that scope is not approved for the client. A read-only Gateway token can inspect Workboard data through read methods, but it cannot create cards or dispatch workers. Workspace limits do not otherwise change manual card movement for callers with Workboard mutation permission.

Local `list`, `create`, `show`, `move`, and `update` commands operate on the local OpenClaw state directory used by the current profile. Use `--dev` or `--profile <name>` on the top-level `openclaw` command when you need a different state root.

## Troubleshooting

### No cards appear

Check that the plugin is enabled for the same profile and state root:

```bash
openclaw plugins inspect workboard --runtime --json
```

If the dashboard shows cards but the CLI does not, check that both commands use the same `--dev` or `--profile` setting.

### Dispatch says data-only

Start or restart the Gateway:

```bash
openclaw gateway restart
openclaw gateway status --deep
```

Then retry `openclaw workboard dispatch`. Data-only fallback is useful for local state cleanup, but worker runs need a live Gateway.

### Dispatch starts nothing

Check for at least one `ready` card without an active claim:

```bash
openclaw workboard list --status ready
```

Cards can also be skipped when the same owner already holds as many active cards as the board allows. Move completed work to `done`, release stale claims through the Workboard tools, raise the board's `maxActivePerOwner`, or run dispatch again after the active worker finishes.

## Related

- [Workboard plugin](/plugins/workboard)
- [CLI reference](/cli)
- [Slash commands](/tools/slash-commands)
- [Control UI](/web/control-ui)
