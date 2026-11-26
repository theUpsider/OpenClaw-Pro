---
summary: "Optional Workboard boards for agent-owned cards and rule-based session views"
read_when:
  - You want a Kanban-style workboard in the Control UI
  - You are enabling or disabling the bundled Workboard plugin
  - You want to track planned agent work without an external project manager
  - You want sessions grouped by session status, observer health, and pull-request state
title: "Workboard plugin"
doc-schema-version: 1
---

The Workboard plugin adds an optional Kanban-style board to the
[Control UI](/web/control-ui): agent-sized work cards, assignment to agents,
and a link back to the card's task, run, and Control UI session. A separate
**Sessions board** groups existing sessions into editable columns using rules over
Gateway-owned facts.

Workboard is intentionally small: it tracks local operating work for one
OpenClaw Gateway. It is not a replacement for GitHub Issues, Linear, Jira, or
other team project management systems.

## Enable it

Workboard is bundled but disabled by default:

1. Open **Plugins** in the Control UI, or use `/plugins` relative to the
   configured Control UI base path. For example, a base path of `/openclaw`
   uses `/openclaw/plugins`.
2. Open the **Workboard** plugin, select **Lifecycle**, and turn on the enabled
   switch. Because Workboard is included with OpenClaw, it does not need an
   **Install** action.
3. Wait for the lifecycle action to finish, then open the Workboard tab.

The Workboard tab appears in the Control UI nav after the plugin runtime loads.
While it is disabled, the tab stays hidden from navigation. Opening the
`/workboard` route directly while the plugin is disabled or blocked by
`plugins.allow`/`plugins.deny` shows a plugin-unavailable state instead of card
data.

The equivalent CLI workflow is:

```bash
openclaw plugins enable workboard
openclaw dashboard
```

Enablement applies to a running Gateway automatically. If it is offline, start
it before opening the dashboard. See [Apply changes and inspect](/plugins/manage-plugins#apply-changes-and-inspect).

## Configuration

Workboard has no plugin-specific config. Enable/disable it with the standard
plugin entry:

```json5
{
  plugins: {
    entries: {
      workboard: {
        enabled: true,
        config: {},
      },
    },
  },
}
```

```bash
openclaw plugins disable workboard
```

## Storage recovery

If a SQLite worker fails, Workboard reopens its store through the database worker
owner on the next call, after native cleanup finishes. An operation already in
flight can still report a failure or an unknown write outcome; Workboard does not
replay that operation. A Gateway restart is not needed once the underlying storage
problem is resolved. Updates require no configuration or data migration.

## Board appearance

While Workboard is open, its sidebar entry expands to show both Cards and
Sessions boards, with the open board highlighted. Select a nested board to open it.
Sidebar labels use the board name; boards with the same name include their kind
in parentheses, such as **Planning (cards)** and **Planning (sessions)**.
Boards you create in the Control UI are pinned in the sidebar immediately.
Right-click a board, or focus its link and press **Shift+F10** or the context-menu
key, to **Pin to sidebar**, **Unpin from sidebar**, or **Delete board…**.
Deleting asks for confirmation naming the board and requires write access.
The default board and boards that still contain cards cannot be deleted.
Deleting the open board returns to the Workboard root page. You can also use
**Customize** to manage pins; removed pins stay removed.
Pinned boards remain available as top-level entries when you leave Workboard,
and you can drag them to reorder them.

Choose **New board**, then **Cards** (the default) or **Sessions**. A Sessions
board starts with the columns described below. A board's kind is permanent;
create another board to use the other kind. Existing boards remain Cards boards.

Use **Edit board** to change a board's name, icon, and color. **Reset to default**
clears the icon and color when you save; canceling leaves the saved board unchanged.
For Sessions boards, the same dialog also edits column labels, colors,
descriptions, column order, and the fallback column. Ask the Board agent to edit
column rules. Saving only the name, icon, or color leaves the saved columns unchanged,
including column edits made by another operator while the dialog was open.

For a Cards board, the same dialog also edits the board's
[classification palette](#classification-palette): up to ten slots, each a name and
one of the eight session colors. Rename, recolor, reorder, add, or remove a slot and
save. Editing the palette never rewrites card labels: a renamed or removed name
leaves the labels already on cards in place as plain chips, exactly as a `replaces`
overwrite does; new labels pick from the palette through the card label editor. The
list is validated at the field (empty name, duplicate name ignoring case, the
`parallelizable` system label, more than ten), so Save is refused there instead of
round-tripping a rejection. The write goes through `workboard.boards.classifications`
with the whole list; the board record's palette then applies to the next card write.
Sessions boards keep no palette and show no editor.

For `workboard.boards.upsert`, omitting `icon` or `color`, passing `null`, or passing
an empty string preserves the existing value, including for older clients. To clear
appearance explicitly, send `clearAppearance: ["icon", "color"]`, or list only the
field you want to clear. Listed fields are cleared even if the request also supplies
a replacement value for them. Other fields retain their ordinary update behavior.
`clearAppearance` must be an array containing only `"icon"` and `"color"`; an empty
array changes nothing. Clients using this argument need a Gateway version that
supports explicit appearance clearing; older Gateways do not implement this reset.

`workboard.cards.list` returns up to 100 cards, with claim tokens redacted. When
`nextCursor` is present, pass that `{ position, createdAt, id }` object as `after`
with the same filters to request the next page. The final page omits `nextCursor`.
The first page returns `revision`; repeat the same query with
`{ sinceRevision: revision }` for `{ unchanged: true, revision }` when current.
`sinceRevision` does not apply to continuation pages. CLI lists follow all pages
automatically; full-population reads remain available to explicit tool and
internal export workflows.
The revision includes the store epoch and, for scoped queries, the normalized
`boardId` and requested `sessionKey`. The optional `sessionKey` filter takes a
nonempty canonical session key and selects cards linked directly, through their
execution, or through a recorded attempt or event. It can be combined with
`boardId`; omitting it pages across all cards in the selected board scope. Selection happens in the
database before card notes, comments, events, and other details are loaded.
Ordinary keys and Matrix/Signal structural segments compare without case;
opaque peer IDs and catalog source identifiers retain their exact identity. The
Control UI and server filter share `normalizeSessionKeyForComparison` from
`@openclaw/normalization-core`, exposed to the plugin through
`openclaw/plugin-sdk/session-key-runtime`. Candidate matching reads only session-link
fields before loading matching cards. Reconnects request a fresh snapshot of the
same scope. `plugin.workboard.changed` includes
an event `revision` and a separate `cardsRevision`: session-fact notifications
advance the event sequence without invalidating unchanged cards.

## Sessions board

Use a Sessions board to see where your conversations stand without creating
cards. By default, it includes sessions from all configured agents with activity
in the last 72 hours and excludes archived sessions, automation (cron) sessions,
system sessions, dock conversations, and each agent's home session. Subagent sessions remain included.
Set `scope.includeAutomation: true` to include automation and system sessions, or
`scope.includeHome: true` to include home sessions. The Board agent can set these
options. Existing boards use the same defaults without a migration. Each session appears in
exactly one column. Open a tile to continue its conversation; the tile also shows
its agent, run state, observer headline when available, pull requests, and recent
activity. Message previews are plain text: Markdown formatting and HTML are removed,
link labels are retained, and whitespace is collapsed before the 400-character limit.
Tiles link up to four pull requests, ordered by open, draft, merged,
then closed state, with a count for any additional pull requests. The agent filter
narrows the loaded sessions without changing the saved board scope. **Load more
sessions** extends the view in pages of 100; the board displays the loaded and
total matching session counts. People filters apply to the complete authorized
session population before paging.

Dock conversations stay excluded even when automation is included.

**People filter:** Choose **Everyone** (the default), **Involving me**, or a person
beside the agent filter. Involving me shows sessions you own or previously prompted;
a person selects their profile associations. The choice is remembered per viewer,
device, Gateway, and board. It does not change the shared board, rules, or
the Board agent. API clients can pass `view: { involvingMe?: boolean,
involvingProfileId?: string, includePeople?: boolean }` to
`workboard.sessionsBoard.read`; `includePeople` returns the people facet for the picker.

Columns are rules over Gateway-owned run state, observer health, and
pull-request state. Run state comes from the live run registry and queued inputs;
a saved `running` status without an active run is idle. Health comes from the Gateway session observer: live digests
for sessions someone is watching in the Control UI, and a terminal digest when an
observed run ends. Sessions nobody watches have no health, so they match only run
and pull-request rules. Reads follow the current caller's session visibility; board specs and
pins follow the Gateway's trusted-operator model. Interactive edits are admitted
under the caller's live authority immediately before the write. Draft and
incognito sessions never enter a Sessions board or its facts reads.

New Sessions boards use these columns, in this order:

| Column      | Rule                                                              |
| ----------- | ----------------------------------------------------------------- |
| Needs input | Observer health is `waiting-on-user`.                             |
| Stuck       | Observer health is `stuck` or `failed`, or run state is `failed`. |
| Working     | Run is active.                                                    |
| In review   | A pull request is open or draft.                                  |
| Merged      | A pull request is merged.                                         |
| Done        | Observer health is `done`. This is also the fallback column.      |

Placement uses an operator pin when its column still exists, then the first
matching column in saved order, then the fallback column. `match` accepts one
rule or an any-of array such as Stuck's
`[{health:["stuck","failed"]},{run:["failed"]}]`, with every field within a rule
required to match. Values within a field are alternatives. Column names
and descriptions help people understand the board; `match` rules decide placement.

Drag a session into another column, or ask the Board agent to move it, to pin
its placement. Pins remain in effect when session facts change. If a pinned
column is removed, the board applies its rules again. Tile tooltips distinguish
**by rule** and **pinned**.

Facts update live from session changes, with automatic board rereads at most once
every five seconds. Category-only session updates and card-only changes do not
reload Sessions boards. The Gateway selects the authorized roster once and reuses
immutable facts for unchanged sessions. The board keeps one frozen snapshot per
board and people view, replacing only rows whose facts changed. Live run state,
background previews, and time-dependent subagent state remain current; profile,
configuration, topology, and access changes refresh authorization. Age-window and
unavailable-PR retry deadlines still refresh the snapshot. Tool callers obtain
their own caller-scoped roster; sharing never expands session visibility.
`workboard.sessionsBoard.read` returns up to 100 sessions, a `total` matching count,
and a `revision`. Pass the string `nextCursor` as `after` with the same board and
view to continue; the final page omits `nextCursor`. Repeat a first-page query with
`{ sinceRevision: revision }` for `{ unchanged: true, revision }` when current.
Continuation pages ignore `sinceRevision`. Pages reflect current session state;
if a cursor's session is no longer present, the request returns an explicit
refresh error. Refresh reconciles sessions reordered between page requests.
Reconnects and view changes request a fresh first page. The Workboard change event's
`sessionsRevision` advances for board edits, operator pins, and session fact
invalidations independently of `cardsRevision`.

Pull-request facts come from the Gateway's shared PR owner, independently of
which sessions appear in a Control UI sidebar. Reads use prepared Gateway facts
without waiting for Git or pull-request requests. Missing snapshots load through
that owner's bounded background loader and announce a board change when ready.
If PR facts become unavailable or GitHub rate limits requests, the Gateway's
selected-facts owner retains the last ready PR list for board cards and column
rules while updating run state and health. Unavailable PR reads retry per session, starting after one minute
and doubling to a 15-minute maximum; a successful read resets the delay.
Redaction changes omit retained PR titles until fresh source text is available,
without changing known PR states or their retry schedule.
An inline warning distinguishes stale PR facts from facts not loaded yet and
identifies GitHub rate limiting. A failed facts read keeps the last known facts
and placement; sessions with no known facts use the fallback column with reason
`facts-unavailable`. A session whose available facts match no rule also uses that
reason while its pull-request facts are unknown. Opening a board starts any needed
background refresh. Shared snapshots reuse prepared facts until a publication,
redaction change, board age-window expiry, or a pull-request retry becomes due; failure fallback
retains the last known facts. If redaction rules change during a facts outage,
the board discards retained text while keeping known run, health, and PR states.

When the Control UI host supports a session dock, **Board agent** opens a
conversation beside the board. Its first use creates and saves a dedicated
conversation named **Sessions board · &lt;board name&gt;**. This is a dock conversation:
it stays out of session lists, Involving me views, and people counts. Open it from
the **Board agent** button. Its human creator, sharing, and sandbox rules are the
same as an ordinary conversation.

For boards with an older Board agent conversation, the next **Board agent** use
creates a new dock conversation and saves its reference. The old conversation
keeps its history and remains an ordinary session that you can archive; its
creation surface and provenance are not rewritten.

The Board agent is the only model used by the board, invoked on demand to change
columns, rules, scope, or pins using these tools:

| Tool                              | Arguments and behavior                                                                                                        |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `workboard_sessions_board_read`   | Optional `boardId`; returns board, columns, sessions, and any warning.                                                        |
| `workboard_sessions_board_update` | Optional `boardId`, plus `columns` or `scope`. `columns` replaces the complete ordered list; retain ids when renaming labels. |
| `workboard_sessions_board_move`   | Optional `boardId`, required `sessionKey` and `columnId`; pins that session's placement.                                      |

These three tools are available to every agent once the plugin is enabled; unlike
the card tools they need no `tools.allow` entry, so the Board agent works out of
the box. Omit `boardId` only when exactly one Sessions board exists. The dock attaches page
context to the conversation, but plugin tools do not receive that context as a
structured argument. With several Sessions boards, the agent must pass the board
id from that context or from `workboard_boards`.

Workboard tools also read an optional `openclawVoiceBoard` run tool binding,
`{ boardId, boardKind: "cards" | "sessions" }`. It is quoted reference data,
not authority: it only fills a missing `boardId`, an explicit argument wins, and
it never widens scope or permissions. The Gateway admits run tool bindings only
from a paired browser copilot client, so the Control UI microphone (see
[Voice control](#voice-control)) cannot send this binding and passes the same
board as Working context instead.

Specs allow 2–12 columns with unique lowercase slug ids (1–48 characters), labels
(1–60), and descriptions (1–400). Exactly one column must have `fallback: true`.
Optional colors use the board palette. `scope` accepts `agentIds`,
`includeArchived`, `includeAutomation`, `includeHome`, and a positive `maxAgeHours`.
The include options default to false. Rules can match `health`, `run`
(`active`, `idle`, `failed`), `pullRequest` (`none`, `open`, `draft`, `merged`,
`closed`), and `archived`. Unknown pull-request state does not count as `none`.

The Gateway methods are `workboard.sessionsBoard.read` (`operator.read`) and
`workboard.sessionsBoard.update` and `.move` (`operator.write`). All require
`boardId`. Update takes a `patch` object with the spec fields, including the
dock's `agentSessionKey`; move additionally requires `sessionKey` and `columnId`.
Move returns the first page of the updated board, with the same 100-session limit,
`total`, and optional `nextCursor` as read.
Create with `workboard.boards.upsert` and `kind: "sessions"`, or with
`workboard_board_create`. Changing an existing board's kind is rejected.

Workboard stores board specs and operator pins in SQLite. Session status,
observer digests, and pull-request state remain owned by the Gateway. On plugin
startup, older automatic placements are removed; operator pins are preserved.
Boards whose rules still match the previous defaults receive the new run-based
rules; only the old default column order is reordered. Customized rules, labels,
descriptions, and custom column order are preserved.
Sessions boards never hold cards: card creation, capture, and dispatch reject a
Sessions board destination. Deleting one removes its pins without deleting any
sessions or its Board agent conversation.

## Card fields

<<<<<<< OURS/upstream-11.10
| Field       | Values                                                                                                                                 |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `title`     | required, up to 180 characters                                                                                                         |
| `notes`     | optional, up to 4000 characters                                                                                                        |
| `status`    | `triage`, `backlog`, `todo`, `scheduled`, `ready`, `running`, `review`, `blocked`, `done`                                              |
| `priority`  | `low`, `normal`, `high`, `urgent`                                                                                                      |
| `labels`    | free-form strings, up to 40 characters each; duplicates are removed and only the first 12 distinct labels are kept, extras are dropped |
| `agentId`   | optional assigned agent                                                                                                                |
| linked refs | optional task, run, session, or source URL                                                                                             |
| `execution` | optional metadata for a Codex/Claude run started from the card (engine, mode, model, session, run id, status)                          |

Values over a length limit are rejected with an error such as `labels must be 40 characters or fewer.`
Labels after the 12th distinct one are ignored without being checked, so an over-long label in that
position does not cause an error.
When creating cards (for example with `workboard_create`), `parents` (card ids, up to 120 characters
each) and `skills` (up to 80 characters each) accept at most 20 distinct entries; more
are rejected.
||||||| BASE/v11.4
| Field       | Values                                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------------------- |
| `status`    | `triage`, `backlog`, `todo`, `scheduled`, `ready`, `running`, `review`, `blocked`, `done`                     |
| `priority`  | `low`, `normal`, `high`, `urgent`                                                                             |
| `labels`    | free-form strings                                                                                             |
| `agentId`   | optional assigned agent                                                                                       |
| linked refs | optional task, run, session, or source URL                                                                    |
| `execution` | optional metadata for a Codex/Claude run started from the card (engine, mode, model, session, run id, status) |
=======
| Field       | Values                                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------------------- |
| `status`    | `triage`, `backlog`, `todo`, `scheduled`, `ready`, `running`, `review`, `blocked`, `done`                     |
| `priority`  | `low`, `normal`, `high`, `urgent`                                                                             |
| `labels`    | strings; classification labels come from the board's [palette](#classification-palette)                       |
| `agentId`   | optional assigned agent                                                                                       |
| linked refs | optional task, run, session, or source URL                                                                    |
| `execution` | optional metadata for a Codex/Claude run started from the card (engine, mode, model, session, run id, status) |
>>>>>>> THEIRS/pro-main

Cards also carry compact metadata:

| Metadata      | Values                                                                                                                                                                                                                                                                                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| card state    | attempts, comments, links, proof, artifacts, automation settings, attachments, worker logs, worker protocol state, claims, diagnostics, notifications, template id, archive state, stale-session detection                                                                                                                                                               |
| recent events | `created`, `edited`, `moved`, `linked`, `specified`, `decomposed`, `claimed`, `heartbeat`, `execution_updated`, `attempt_started`, `attempt_updated`, `comment_added`, `link_added`, `unlinked`, `proof_added`, `artifact_added`, `attachment_added`, `diagnostic`, `notification`, `dispatch`, `orchestration`, `protocol_violation`, `archived`, `unarchived`, `stale` |

This metadata lets an operator see how a card moved through the board without
opening the linked session. It is local operating context, not a replacement for session
transcripts or GitHub issue history.

Card create/update RPCs reject unsupported top-level `metadata` keys with an error
naming the keys, rather than accepting data that will not be stored.

New and edited comments are limited to 2000 characters. Unchanged stored comment
bodies, including older oversized comments, retain their exact text during dispatch
and other card updates. The existing per-card metadata budget still applies.

### Classification palette

Each Cards board keeps a closed palette of at most 10 classifications. An entry is
a name plus one of the eight session colors (`red`, `blue`, `green`, `yellow`,
`purple`, `orange`, `pink`, `cyan`), so a full palette repeats two colors; the
name is the identity. Cards still carry several labels.

When a card is created or its labels change, each newly added label is checked
against the card's board:

- A name already in the palette, ignoring case, is accepted with the palette's spelling.
- An unknown name takes the next free slot. Its color follows the slot index.
- With 10 entries, an unknown name is rejected. The error lists the current
  classifications and asks for `replaces`, the existing classification to overwrite.
  The overwritten slot keeps its position and color. Cards that still carry the
  old name keep it as a plain chip.
- `replaces` must name a classification, and is an error when no new name needs
  a slot. One write can replace one classification; bulk updates cannot replace.

Labels a card already carried are not checked again, and status, claim, and
metadata writes never consult the palette. The system label `parallelizable`
never takes a slot and cannot become a classification.

A board created before palettes existed is seeded on its first card write
(a create, or an update that changes labels). The seed takes the distinct labels
of the board's non-archived cards, most-used first, ties broken by first
appearance in card creation order, capped at 10. Card labels are never
rewritten: labels beyond the first 10 stay on their cards as plain chips, and a
board without labels seeds an empty palette. The seed is stored, so later
writes do not reorder it.

`workboard_boards` and `workboard.boards.list` return each board's
`classifications`. `workboard_create` and `workboard_update` return the board's
palette with the card, plus `classificationsAdded` or `classificationReplaced`
when the write changed it. Board metadata updates keep the palette.

`workboard.boards.classifications` replaces a cards board's whole palette after
validation, and is what the board editor's palette section writes. It never
rewrites card labels; a name removed from the palette leaves the labels still on
cards as plain chips, exactly as a `replaces` overwrite does. The CLI reaches the
same card-level gate through `workboard update --labels-add/--labels-remove`, and a
full palette is refused with the `--replaces` step named, so an operator can reuse
or overwrite a classification from the terminal too.

The plugin and Control UI use one Workboard card contract. Control UI refreshes
therefore preserve workspace provenance and authority, claim state, diagnostic
actions, and notification sequence numbers instead of projecting a smaller
UI-only copy of the card. Unknown diagnostic kinds, diagnostic severities, and
notification kinds are ignored until both surfaces support them. They are never
rewritten into another valid state.

The open Workboard tab updates from `plugin.workboard.changed` invalidations. Each
event contains only a store epoch and revision. The UI then rereads stored
cards through the normal `operator.read` RPC. Multiple revisions coalesce into
one follow-up read. Workboard defers that read while a card is being dragged,
edited, or written, then resumes after the local interaction finishes. A
reconnect always performs a reload from the store. There is no routine full-card
poll, and **Refresh** remains available as manual recovery.

The sidebar catalog reads names and summaries from `workboard.boards.list`.
The session-header chip reads only cards linked to its session through the
`workboard.cards.list` session filter; neither downloads unrelated card history.
These narrower reads preserve the existing rendering.

The Gateway shares the first `workboard.cards.list` page per board filter at each
store revision, including concurrent reads. Board summaries are shared across
`workboard.boards.list` and all card-list queries at that same revision.
Session-filtered and continuation reads do not retain a card payload cache.
Card and board writes invalidate cached pages and summaries before the next
read. Each response includes all board summaries, so a change to another board
invalidates the page too.

The Control UI and dashboard widgets show when more cards are available and
offer **Load more cards**. Card search, filters, and widget counts apply to loaded
cards. Load all cards before reordering them. Refresh reconciles cards reordered
between page requests.

When more than one board exists, the toolbar includes a **Board** filter backed
by persisted board metadata rather than only the currently visible cards. Empty
and archived boards therefore remain selectable. Cards without an explicit
board id belong to the primary `default` board. Each board has a primary
`/workboard/<boardId>` page that can be bookmarked, shared, or pinned in the
sidebar. The previously shipped `/workboard?board=<boardId>` form remains a
compatibility alias and redirects to that page while preserving other query
parameters. Choosing **All boards** returns to `/workboard`.

A board can store an `automationJobId` reference to the automation job that
owns its AI-categorization prompt, model, schedule, and run history. The board
page shows an **Automation** link when that reference is present. The board
header and card details show **Disabled** when the linked automation is disabled,
not a suspended run. Opening the link does not enable or run it. Matching
session events nudge the attached automation through the active Workboard service's
scheduler authority, including after the worker's tool authority closes, with events
for the same board coalesced for 60 seconds. If an attempt ends while its run is
still active, the lifecycle sweep nudges the automation when it records the terminal
outcome. The automation's schedule remains the backstop. Disabled and auto-disabled
automations are never nudged. Deleting
the board does not delete or otherwise mutate the
operator-owned automation job.

Cards are stored in the plugin's own Gateway state and move with the rest of
that Gateway's OpenClaw state (see [Storage](#storage)).

## Starting work from a card

Unlinked cards without an active or unresolved task association can start work directly:

- **Run Claude** / **Run OpenAI** starts a task-tracked agent run with an
  explicit engine, sends the card prompt, and marks the card `running`. Claude
  runs use `anthropic/claude-sonnet-4-6`. OpenAI runs use `openai/gpt-6-astra`.
- **Open Claude** / **Open OpenAI** creates a linked Control UI session without
  sending the card prompt, for manual work that stays attached to the board.
  Opening it clears any schedule and moves a `scheduled` card to `todo`.
  Other cards keep their status.

Autonomous starts use the Gateway's task-tracked agent run path (default agent
and model unless Claude/OpenAI is chosen explicitly). Workboard then links the
resulting run id and session key back onto the card. Each linked
execution also records an attempt summary (engine, mode, model, run id,
timestamps, status, rolling failure count) so repeated failures stay visible.

The Control UI reads lifecycle from the card's linked session. Card status changes are persisted by the Gateway-side Workboard
plugin using the linked run and session lifecycle (see
[Session lifecycle sync](#session-lifecycle-sync)).

## Agent tools

The card tools below are optional plugin tools. Enabling Workboard exposes only
the three Sessions board tools to agents; an agent that should create, claim, or
complete cards needs the card tools allowed for it. Add the plugin id to the
agent's tool policy to allow every Workboard tool, or list individual tool names
or a pattern such as `workboard_*`:

```json5
{
  agents: {
    entries: {
      main: {
        tools: { alsoAllow: ["workboard"] },
      },
    },
  },
}
```

Without that entry the agent sees only `workboard_sessions_board_*` and cannot
manage cards. Workers that Workboard starts from a card (**Start** or dispatch)
do not need it: each worker run is granted `workboard_heartbeat`,
`workboard_complete`, and `workboard_block` for its card.

<<<<<<< OURS/upstream-11.10
| Tool                                                                                                                                             | Purpose                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workboard_list`                                                                                                                                 | List compact cards with claim/diagnostic state; optional board filter.                                                                                                                                                          |
| `workboard_read`                                                                                                                                 | Return one card plus bounded worker context from the same card read (notes, attempts, comments, links, proof, artifacts, parent results, recent assignee work, active diagnostics).                                             |
| `workboard_create`                                                                                                                               | Create a card with optional parents, tenant, skills, board, workspace metadata, idempotency key, runtime limit, retry budget.                                                                                                   |
| `workboard_link`                                                                                                                                 | Link a parent to a child card. With open parents, `backlog`/`triage` children normalize to `todo`; when all parents are `done`, eligible children reach `ready` on dispatch. See Dependency promotion under Dispatch for holds. |
| `workboard_claim`                                                                                                                                | Claim a card for the calling agent; moves `backlog`/`todo`/`ready` into `running`.                                                                                                                                              |
| `workboard_heartbeat`                                                                                                                            | Refresh the claim heartbeat during a longer run.                                                                                                                                                                                |
| `workboard_release`                                                                                                                              | Release the claim; omitting `status` preserves the current status, including `running`. Pass `status` to pause or hand off.                                                                                                     |
| `workboard_complete` / `workboard_block`                                                                                                         | Structured lifecycle tools for final summaries, proof, artifacts, and created-card manifests (must reference cards linked back to the completed card) or blocker reasons.                                                       |
| `workboard_attachment_add` / `workboard_attachment_read` / `workboard_attachment_delete`                                                         | Store small card attachments in plugin SQLite state, index on the card, expose in worker context.                                                                                                                               |
| `workboard_worker_log` / `workboard_protocol_violation`                                                                                          | Record worker log lines and block a card when an automated worker stops without calling `workboard_complete`/`workboard_block`.                                                                                                 |
| `workboard_board_create` / `workboard_board_archive` / `workboard_board_delete`                                                                  | Manage persisted board metadata (display name, description, archive state, default workspace).                                                                                                                                  |
| `workboard_sessions_board_read` / `workboard_sessions_board_update` / `workboard_sessions_board_move`                                            | Read Sessions board placements, edit columns, rules, or scope, or pin a session in a column.                                                                                                                                    |
| `workboard_runs`                                                                                                                                 | Return the persisted run-attempt history for a card.                                                                                                                                                                            |
| `workboard_specify`                                                                                                                              | Turn a rough triage/backlog card into a clarified `todo` card; records the spec summary on the card.                                                                                                                            |
| `workboard_decompose`                                                                                                                            | Fan a parent orchestration card into linked children, inheriting board/tenant metadata; can complete the parent with a created-card manifest.                                                                                   |
| `workboard_notify_subscribe` / `workboard_notify_list` / `workboard_notify_events` / `workboard_notify_advance` / `workboard_notify_unsubscribe` | Manage notification subscriptions. Event reads are replay-safe; `advance` moves the durable cursor so callers resume without losing or double-reading completed/failed/stale card events.                                       |
| `workboard_boards` / `workboard_stats`                                                                                                           | Inspect board namespaces and queue stats.                                                                                                                                                                                       |
| `workboard_promote` / `workboard_reassign` / `workboard_reclaim`                                                                                 | Recover or hand off stuck work.                                                                                                                                                                                                 |
| `workboard_comment` / `workboard_proof`                                                                                                          | Add handoff notes or attach proof/artifact references.                                                                                                                                                                          |
| `workboard_verify`                                                                                                                               | Record what a checker checked on a card and what it concluded. Evidence only; see Result evidence.                                                                                                                              |
| `workboard_unblock`                                                                                                                              | Move blocked work back to `todo`.                                                                                                                                                                                               |
| `workboard_move`                                                                                                                                 | Move a card to another status; claimed cards require the caller's agent claim scope.                                                                                                                                            |
| `workboard_dispatch`                                                                                                                             | Nudge dependency promotion or stale-claim cleanup without launching workers; worker launch uses Gateway or slash-command dispatch.                                                                                              |
||||||| BASE/v11.4
| Tool                                                                                                                                             | Purpose                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workboard_list`                                                                                                                                 | List compact cards with claim/diagnostic state; optional board filter.                                                                                                                    |
| `workboard_read`                                                                                                                                 | Return one card plus bounded worker context from the same card read (notes, attempts, comments, links, proof, artifacts, parent results, recent assignee work, active diagnostics).       |
| `workboard_create`                                                                                                                               | Create a card with optional parents, tenant, skills, board, workspace metadata, idempotency key, runtime limit, retry budget.                                                             |
| `workboard_link`                                                                                                                                 | Link a parent to a child card. Children stay `todo` until every parent reaches `done`, then dispatch promotion moves them to `ready`.                                                     |
| `workboard_claim`                                                                                                                                | Claim a card for the calling agent; moves `backlog`/`todo`/`ready` into `running`.                                                                                                        |
| `workboard_heartbeat`                                                                                                                            | Refresh the claim heartbeat during a longer run.                                                                                                                                          |
| `workboard_release`                                                                                                                              | Release the claim after completion, pause, or handoff; can move the card to a next status.                                                                                                |
| `workboard_complete` / `workboard_block`                                                                                                         | Structured lifecycle tools for final summaries, proof, artifacts, and created-card manifests (must reference cards linked back to the completed card) or blocker reasons.                 |
| `workboard_attachment_add` / `workboard_attachment_read` / `workboard_attachment_delete`                                                         | Store small card attachments in plugin SQLite state, index on the card, expose in worker context.                                                                                         |
| `workboard_worker_log` / `workboard_protocol_violation`                                                                                          | Record worker log lines and block a card when an automated worker stops without calling `workboard_complete`/`workboard_block`.                                                           |
| `workboard_board_create` / `workboard_board_archive` / `workboard_board_delete`                                                                  | Manage persisted board metadata (display name, description, archive state, default workspace).                                                                                            |
| `workboard_sessions_board_read` / `workboard_sessions_board_update` / `workboard_sessions_board_move`                                            | Read Sessions board placements, edit columns, rules, or scope, or pin a session in a column.                                                                                              |
| `workboard_runs`                                                                                                                                 | Return the persisted run-attempt history for a card.                                                                                                                                      |
| `workboard_specify`                                                                                                                              | Turn a rough triage/backlog card into a clarified `todo` card; records the spec summary on the card.                                                                                      |
| `workboard_decompose`                                                                                                                            | Fan a parent orchestration card into linked children, inheriting board/tenant metadata; can complete the parent with a created-card manifest.                                             |
| `workboard_notify_subscribe` / `workboard_notify_list` / `workboard_notify_events` / `workboard_notify_advance` / `workboard_notify_unsubscribe` | Manage notification subscriptions. Event reads are replay-safe; `advance` moves the durable cursor so callers resume without losing or double-reading completed/failed/stale card events. |
| `workboard_boards` / `workboard_stats`                                                                                                           | Inspect board namespaces and queue stats.                                                                                                                                                 |
| `workboard_promote` / `workboard_reassign` / `workboard_reclaim`                                                                                 | Recover or hand off stuck work.                                                                                                                                                           |
| `workboard_comment` / `workboard_proof`                                                                                                          | Add handoff notes or attach proof/artifact references.                                                                                                                                    |
| `workboard_unblock`                                                                                                                              | Move blocked work back to `todo`.                                                                                                                                                         |
| `workboard_move`                                                                                                                                 | Move a card to another status; claimed cards require the caller's agent claim scope.                                                                                                      |
| `workboard_dispatch`                                                                                                                             | Nudge dependency promotion or stale-claim cleanup without launching workers; worker launch uses Gateway or slash-command dispatch.                                                        |
=======
| Tool                                                                                                                                             | Purpose                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workboard_list`                                                                                                                                 | List compact cards with claim/diagnostic state; optional board filter.                                                                                                                                                                   |
| `workboard_read`                                                                                                                                 | Return one card plus bounded worker context from the same card read (notes, attempts, comments, links, proof, artifacts, parent results, recent assignee work, active diagnostics).                                                      |
| `workboard_create`                                                                                                                               | Create a card with optional parents, tenant, skills, board, workspace metadata, idempotency key, runtime limit, retry budget, [decision options](#decision-cards). Labels follow the board palette.                                      |
| `workboard_link`                                                                                                                                 | Link a parent to a child card. Dependencies hold the child out of `ready`, `running`, and `done` until every parent is `done`, but never out of `review` ([details](#dependencies)).                                                     |
| `workboard_claim`                                                                                                                                | Claim a card for the calling agent; moves `backlog`/`todo`/`ready` into `running`.                                                                                                                                                       |
| `workboard_heartbeat`                                                                                                                            | Refresh the claim heartbeat during a longer run.                                                                                                                                                                                         |
| `workboard_release`                                                                                                                              | Release the claim after completion, pause, or handoff; can move the card to a next status, but not out of `review` on a card awaiting acceptance of the caller's own result.                                                             |
| `workboard_complete` / `workboard_block`                                                                                                         | Structured lifecycle tools for final summaries, proof, artifacts, and created-card manifests (must reference cards linked back to the completed card) or blocker reasons.                                                                |
| `workboard_attachment_add` / `workboard_attachment_read` / `workboard_attachment_delete`                                                         | Store small card attachments in plugin SQLite state, index on the card, expose in worker context.                                                                                                                                        |
| `workboard_worker_log` / `workboard_protocol_violation`                                                                                          | Record worker log lines and block a card when an automated worker stops without calling `workboard_complete`/`workboard_block`.                                                                                                          |
| `workboard_board_create` / `workboard_board_archive` / `workboard_board_delete`                                                                  | Manage persisted board metadata (display name, description, archive state, default workspace).                                                                                                                                           |
| `workboard_sessions_board_read` / `workboard_sessions_board_update` / `workboard_sessions_board_move`                                            | Read Sessions board placements, edit columns, rules, or scope, or pin a session in a column.                                                                                                                                             |
| `workboard_runs`                                                                                                                                 | Return the persisted run-attempt history for a card.                                                                                                                                                                                     |
| `workboard_specify`                                                                                                                              | Turn a rough triage/backlog card into a clarified `todo` card; records the spec summary on the card.                                                                                                                                     |
| `workboard_decompose`                                                                                                                            | Fan a parent orchestration card into linked children, inheriting board/tenant metadata; can complete the parent with a created-card manifest.                                                                                            |
| `workboard_notify_subscribe` / `workboard_notify_list` / `workboard_notify_events` / `workboard_notify_advance` / `workboard_notify_unsubscribe` | Manage notification subscriptions. Event reads are replay-safe; `advance` moves the durable cursor so callers resume without losing or double-reading completed/failed/stale card events.                                                |
| `workboard_boards` / `workboard_stats`                                                                                                           | Inspect board namespaces, classification palettes, and queue stats.                                                                                                                                                                      |
| `workboard_promote` / `workboard_reassign` / `workboard_reclaim`                                                                                 | Recover or hand off stuck work. `promote` takes no `status` (`todo` to `ready`); a `status` on `reassign`/`reclaim` follows the `workboard_move` acceptance rule.                                                                        |
| `workboard_comment` / `workboard_proof`                                                                                                          | Add handoff notes or attach proof/artifact references.                                                                                                                                                                                   |
| `workboard_unblock`                                                                                                                              | Move a card back to `todo`, usually blocked work after adding context; it accepts any status. Follows the `workboard_move` acceptance rule.                                                                                              |
| `workboard_move`                                                                                                                                 | Move a card to another status; claimed cards require the caller's agent claim scope. The owner that reported an awaiting result cannot move that card out of `review`.                                                                   |
| `workboard_set_parallelism`                                                                                                                      | Opt an existing card in or out of parallel owner slots; turning it off also removes the `parallelizable` label. Claimed cards require claim scope.                                                                                       |
| `workboard_set_dispatch_mode`                                                                                                                    | Set who places and starts a card's worker: `native` (default, the local dispatcher) or `external` (a controller outside this Gateway). External cards are never claimed or started locally. Release owned work before changing its mode. |
| `workboard_update`                                                                                                                               | Set priority, dispatch mode, or [decision options](#decision-cards), or add/remove labels by name (case-insensitive); other labels stay. Added labels follow the board palette. Refuses stale writes; claimed cards need claim scope.    |
| `workboard_dispatch`                                                                                                                             | Nudge dependency promotion or stale-claim cleanup without launching workers; worker launch uses Gateway or slash-command dispatch.                                                                                                       |
>>>>>>> THEIRS/pro-main

Creating linked cards, linking existing cards, and decomposition save one card at a
time. If a later step fails, completed steps remain visible; Workboard reports the
original error without rolling them back. Inspect the board before retrying, and
repair missing links or remove unwanted partial cards as needed.

Proof statuses are worker-reported outcomes, not independent verification. A `passed`
entry means the worker reports that its command or check succeeded. Consumers that need
an independent quality gate should inspect the attached command, URL, or artifact and
run their own verifier. `workboard_proof` returns the new record's `proofId`. When
`workboard_complete` reports that same proof's terminal status, pass `proofId` so the
pending record is resolved in place without losing its identity or timestamp. A proof that
already has the same terminal status is reused unchanged. Completion proof without
`proofId` remains append-only, so a later retry cannot rewrite older history merely because
its command or note is identical.

Completion validates its proof, artifacts, and notification before saving the card.
A validation failure leaves the card unchanged. Completion notifications preserve
the full execution run ID, including IDs longer than 120 characters. Run IDs are limited
to 512 characters across execution admission, launch metadata, worker logs, and
notification subscriptions. Use a shorter ID if admission rejects it; IDs are never
truncated. Metadata trimming preserves the completion's new notification and proof,
discarding older history as needed. If those records cannot fit, completion fails
without saving the card.

Claimed cards reject agent-tool mutations from other agents unless the caller
holds the claim token returned by `workboard_claim`. Every card returned by an
agent tool or Gateway RPC call redacts `metadata.claim.token` to `[redacted]`
(the token itself is returned once, top-level, only from `workboard_claim`),
so Control UI operators and other agents can inspect claim state without ever
seeing a usable token. Recovery goes through
`workboard_promote`/`workboard_reassign`/`workboard_reclaim`, which do not
require the token.

Promotion only moves `todo` cards to `ready`; every other status returns an
error without changing the card, including when `force` is set. To recover
blocked work, use `workboard_unblock` first to move it to `todo`.
`force` only bypasses dependency or schedule holds.

Once a managed worker blocks its attempt, late lifecycle observations from that
attempt cannot settle it again. Unblocking and promoting the card leaves it
`ready` for a fresh dispatch and preserves the blocked attempt's failure. Ignored
observations are logged with the card and attempt IDs. Explicitly linking a
different session still allows that session's lifecycle to synchronize.

### Result evidence

Cards can carry optional result evidence in `metadata.automation.evidence`, kept
apart by who produced it. Completion never waits on it, proof statuses keep their
meaning, and dependency scheduling ignores it. Cards without evidence behave exactly
as before.

- **Claim** (`kind: "claim"`): something the worker says its result does. Pass
  `claims: [{ statement, proofId? }]` (up to 4) to `workboard_complete`. Workboard
  stamps `claimedBy` with the caller and `runId` with the card's run. A claim says
  nothing about whether it holds.
- **Observation** (`kind: "observation"`): a run outcome the execution system
  observed. Only Workboard's session lifecycle sync writes these, when a linked
  session's run ends (`source: "session-lifecycle"`, `outcome: "succeeded" | "failed"`,
  with `sessionKey` and `runId`; the first report of a run wins). Agents cannot write them. Runs whose end event was
  missed have no observation; Workboard does not infer one from `done`, a passed
  proof, or a timestamp.
- **Verification** (`kind: "verification"`): a check by an identified checker,
  written with `workboard_verify`. It records `scope` (what was checked),
  `outcome` (`confirmed`, `disputed`, or `inconclusive`), an optional `claimId`,
  `proofId`, `artifactId`, or `runId` it covered, and an optional note and http(s)
  URL. Workboard stamps `checkerId` with the caller and sets `checkedOwnWork` when
  that caller is the card's assignee, claim owner, or a claim author. `false` only
  means no match was found; it does not establish independence. A verification
  never changes the card's status, including a `disputed` one on a `done` card.

Generic metadata writes (`workboard_create`, `workboard.cards.update`) cannot add
evidence, and Gateway `workboard.cards.complete` rejects `claims` because it has no
agent identity to stamp. A card keeps the 4 newest records of each kind, within about
6 KiB in total. Evidence only uses room the card's other records leave: when the
card is near its 24 KiB metadata budget, Workboard drops the oldest evidence first,
never proof, attempts, comments, or artifacts. Claims and observations that cannot
fit are dropped without failing completion; `workboard_verify` returns an error
instead. Workboard versions
before this one ignore the field and may drop it on their next write to the card.

## Dispatch

Dispatch is Gateway-local: it does not spawn arbitrary OS processes. Normal
OpenClaw subagent sessions still own execution. One dispatch pass:

1. Promotes dependency-ready cards.
2. Blocks expired claims or timed-out runs.
3. Marks board-configured triage cards as orchestration candidates.
4. Claims a small batch of ready cards and starts worker runs through the
   Gateway subagent runtime.

The Control UI reports the counts from that pass. Marking a card for planning
does not mean it has been specified or decomposed. If workers cannot start, the
result shows the first start failure alongside the total failure count.

Idle scans leave ready-card history unchanged. Existing dispatch counters and
timestamps remain as historical values; new launches use the card's launch,
attempt, and execution history.

Workers get bounded card context plus the claim token needed to heartbeat,
complete, or block the card through the Workboard tools.

### Dependency promotion

With open parents, child cards in `backlog` or `triage` are normalized to `todo`.
After all parents reach `done`, dependency promotion moves eligible children to
`ready`. A child in `blocked` is skipped until `workboard_unblock` moves it back
to `todo`. A future `scheduledAt` holds an otherwise promotable dependent card
in `scheduled` until the next dispatch at or after that time. A `scheduled` card
without `scheduledAt` remains scheduled; opening it in the Control UI clears the
schedule and moves it to `todo`.

`workboard_dispatch` runs dependency promotion and cleanup without launching
workers. Gateway or slash-command dispatch can start children that reach `ready`.
Unassigned starts use the configured default agent, as described under Worker
selection below.

Each attempt has one launch identity, persisted when the launch is prepared and
sent as the worker run's idempotency key. Preparing again under the same claim
reuses it instead of minting a new one. A card that still has a running attempt
is not started or claimed again, even when its owner slot is free: complete,
block, or reclaim that attempt first. The retry budget (`maxRetries`) still caps
how many failed attempts a card may have.

Workspace paths follow the caller's existing filesystem authority:

- Gateway clients with `operator.write` can use configured agent workspaces.
- `operator.admin` clients can use other host checkouts.
- Sandboxed agent tools use their sandbox workspace access.
- Unsandboxed workspace-only tools use their configured workspace root.

Workboard records that authority when a workspace is
assigned and intersects it with the current caller's authority again at dispatch,
so a persisted card cannot widen a later caller's access. Older cards with an
explicit host workspace but no recorded authority must have that workspace
re-saved before a full-host dispatch. Cards without a host path adopt the
current caller's authority when first dispatched.

A card assigned to another agent records **that** agent's authority instead: a
sandboxed target records its own workspace root, and any other target records
unrestricted access, matching how the dispatcher resolves the target agent's
runtime. The assignment therefore starts a worker whose agent is not sandboxed
and does not share the creator's workspace. An explicitly set `workspace` is
still validated against the creating caller's boundary (and, when the target
records restricted access, against the target's root), so assigning a card never
widens the creator's filesystem reach, and dispatch still intersects the card's
recorded authority with the dispatching caller's own.

Workspace-bound dispatch accepts a directory or Git checkout only when its
repository root exactly matches the target agent workspace. A worktree request
is narrowed to that directory and persisted as a directory workspace, so the
host does not materialize the checkout or execute repository setup code. The
target worker must use a writable, non-shared Docker sandbox for that exact
workspace, without elevated execution, persisted host/node exec overrides, or
unclassified plugin and MCP tools. Workboard enumerates its registered tools
instead of trusting a `workboard_*` prefix, and dispatch refuses a hot Docker
container whose live mount/config hash is stale. Dispatch reports the
incompatible target policy instead of starting a less-confined worker.
Full-host dispatch may target other local checkouts and keeps normal managed-
worktree setup.

Workspace authority does not create a second card-lifecycle permission model.
Callers that may mutate Workboard cards can manually move them through the same
statuses on every surface. Read-only workspace access only prevents worker
dispatch that needs writes.

### Dependencies

Dependencies gate **starts** (`ready`/`running`) and **acceptance** (`done`);
they never block **recording completion** (`review`). The schedule hold stays in
force for every gated status: a card scheduled for later cannot move to
`ready`, `running`, or `review` before its `scheduledAt`.

- A child stays `todo` until every parent is `done`; dispatch promotion then
  moves it to `ready`. Creating a child with parents and status `running`
  stores it as `todo`; a requested `review` is kept.
- A child with an open parent can still land in `review`: a worker's
  `workboard_complete`, `workboard_move`, or an operator move or update. Its
  summary, proof, and `completed` notification are recorded as usual.
- Until every parent is `done`, that child cannot move to `done` and a reviewer
  cannot claim it. Reopening a parent leaves a `review` child in `review`.
- `workboard.cards.linkDependency` adds a parent/child dependency link and
  `workboard.cards.unlinkDependency` removes that one pair's link from both
  cards, so a card gated by an outdated dependency can be closed once the link
  is gone. Unlinking is purely structural: it never promotes or moves a card,
  and every other link on either card stays.

Older builds refused that `review` write, so finished children could stay in
`todo` while a parent was open. There is no automatic sweep: once its work is
verified, move such a card to `review` from the Control UI,
`workboard.cards.move`, `workboard_move`, or the CLI:

```bash
openclaw workboard move <card-id> --status review
```

### External placement

A card can opt out of local placement entirely. Set
`metadata.automation.dispatchMode` to `external` (the `workboard_update` or
`workboard_set_dispatch_mode` tool, `--dispatch-mode external` on the CLI, or the
`dispatchMode` field on `workboard.cards.create`/`workboard.cards.update`) when a
controller outside this Gateway owns the card's placement and transport.

- The local dispatcher **never claims or starts** an external card. A scheduled
  pass leaves it untouched, and starting one exact card answers with a refusal
  naming the external mode instead of a start failure.
- Dependency promotion and claim cleanup still run for external cards, so a
  promoted external child reaches `ready` for the external controller to see.
- The external controller uses the normal manual flow: `workboard_claim`,
  `workboard_heartbeat`, and `workboard_complete` (or the Gateway methods behind
  them). Workboard stays the one authoritative task status; there is no second
  task database and no local fallback for external work.
- Omitted means `native`, so every card that does not carry the field behaves
  exactly as before. `native` written explicitly is equivalent to omitting it.
- `workboard_specify` accepts `dispatchMode`; children created by
  `workboard_decompose` inherit their parent's mode unless they explicitly set
  `native` or `external`. Inheritance is persisted before dependency promotion.
- A card's effective mode cannot change while a stored claim or running execution
  owns it, including through metadata replacement. Complete, block, or reclaim
  that work first, then change the mode. Expired claims keep placement fixed until
  reclaimed, so a suspended dispatcher cannot resume under a new mode. Writing
  the same mode is allowed.

This field only decides who places and starts the worker. It is not authority:
the claim token still gates heartbeats and completion, and workspace access is
still resolved from the card's own persisted authority at dispatch and claim
time.

### Worker selection

Each pass starts **at most 3 workers by default**. Ready cards are ordered by
<<<<<<< OURS/upstream-11.10
priority, then position, then creation time. Each owner/agent may hold one
active card at a time by default: a card counts while it is `running`, its run
is still marked running, or its claim has not expired, so a card waiting for
review counts only in those cases. The count covers every board, and the
board's `maxActivePerOwner` orchestration setting (1 to 20, default 1) raises
the limit for cards on that board. Unassigned cards all share the
`workboard-dispatcher` owner, so set it above 1 to run several of them at once.
A pass tries one card per owner before starting extra cards for the same
owner, and the per-pass cap still applies. Archived cards, cards with an
active claim, and cards not in `ready` status are never selected for worker
starts (they can still be affected by the data side of dispatch: stale-claim
cleanup, dependency promotion, timeout cleanup).
||||||| BASE/v11.4
priority, then position, then creation time. A pass starts only one card per
owner/agent and skips owners that already have running or review work on the
board. Archived cards, cards with an active claim, and cards not in `ready`
status are never selected for worker starts (they can still be affected by the
data side of dispatch: stale-claim cleanup, dependency promotion, timeout
cleanup).
=======
priority, then position, then creation time. A pass starts only one card per
owner/agent and skips owners that already have running or review work on the
board. Archived cards, cards with an active claim, cards that are not in `ready`
status, and cards marked `dispatchMode: external` are never selected for worker
starts (they can still be affected by the data side of dispatch: stale-claim
cleanup, dependency promotion, timeout cleanup).

A Ready card left waiting because its owner's slot is full is not a failure.
The dispatch result lists it in `skipped` (`{ cardId, title, ownerId, reason:
"owner_busy" }`), next to the unchanged `started` and `startFailures` arrays,
and the Control UI dispatch summary adds _Queued behind a busy lane: N_.
Starting one exact card (`workboard.cards.start`, the card's **Start**) behind a
busy lane never claims or starts it; it answers _Card is queued: …_ instead of a
start failure. Dependency promotion still runs first, as it does for any start.
In the Control UI that card's **Start** reads _Queued N/M_ and names the slot
holder; selecting it once arms **Try to start**, and only the second selection
sends the start - which the server still refuses while the slot is held.

### Owner slots and opt-in parallelism

The one-card-per-owner rule is a slot ceiling, not a hard singleton. Two pieces
have to be set together, because the opt-in marker alone changes nothing:

1. Mark the card `parallelizable` — the label or the equivalent
   `metadata.automation.parallelizable` flag.
2. Raise the ceiling with `metadata.automation.maxConcurrentPerOwner` (default
   `1`, maximum `16`).

A card with the marker but no ceiling still waits for the single owner slot.

Existing cards can be opted in or out with
[`openclaw workboard update`](/cli/workboard#update) or the
`workboard_set_parallelism` tool. Turning parallelism off also removes the
`parallelizable` label, because the label alone would keep the card opted in.
Clearing the ceiling (`0` on the CLI, `null` in the tool) returns the owner to
a single slot.

- Unmarked cards keep the historical behaviour: **one active card per owner**, and
  a non-opt-in card pins its owner back to that single slot even if a sibling
  opted in.
- Opted-in cards of one owner start together up to the **tightest** declared
  ceiling, capped by the card-level guardrail.
- The same ceiling function backs both the dispatcher's selection and the atomic
  database claim gate, so a direct claim (`--card`) cannot bypass the limit.

The DB claim gate remains the authoritative guard; selection only avoids
claiming a card the gate would reject. Parallel cards still get their own
session and managed worktree, but they share the owner, so keep truly
independent cards separate from cards that touch the same files, remote targets,
or non-Git scratch workspaces.

The Control UI shows that queue. When another card holds a card's owner slot,
the card's **Why is this waiting?** line names the holder and the card's place,
for example _Queued 2 of 3 for b — slot held by Ship lane view_. The
queue holds the owner's unarchived `ready`, `scheduled`, `todo`, and `backlog`
cards, `ready` first and then in dispatch order. Cards in `review`, `blocked`, or
`done` are not part of it. The owner is the live claim owner, otherwise the
card's agent, otherwise the default dispatcher.
>>>>>>> THEIRS/pro-main

Session keys are fixed per board/card, so repeated dispatches route
back to the same worker lane instead of creating unrelated sessions:

- Assigned cards: `agent:<agentId>:subagent:workboard-<boardId>-<cardId>`
- Unassigned cards: `subagent:workboard-<boardId>-<cardId>` (Gateway resolves
  the configured default agent)

If a worker cannot be started after a card is claimed, Workboard blocks the
card, clears the claim, records the run-start failure, and appends a worker
log line - visible in the Control UI, CLI JSON, agent tools, and card
diagnostics.

### Entry points

- Control UI dispatch action
- `openclaw workboard dispatch`
- `/workboard dispatch` on a command-capable channel

All three use the Gateway subagent runtime when the Gateway is available. The
CLI has one operator fallback: if the Gateway call fails with a
connection/unavailable error (or an `unknown method` error for older
Gateways), and no explicit `--url`/`--token` target and no configured remote
Gateway (`OPENCLAW_GATEWAY_URL` or `gateway.mode: remote`) apply, the CLI runs
data-only dispatch against local SQLite state - it can promote dependencies,
clean stale claims, and block timed-out runs, but cannot start workers. Auth,
permission, and validation failures from a reachable Gateway are not treated
as unavailable. They surface as command errors, and so does any Gateway
failure when an explicit `--url`/`--token` target was given.

Board metadata can set `autoDecompose`, `autoDecomposePerDispatch`,
`defaultAssignee`, `orchestratorProfile`, and `maxActivePerOwner` (see
[Worker selection](#worker-selection)). OpenClaw records the first four as
intent and exposes them in worker context. Actual specification/decomposition
still runs through the normal Workboard tools.

## CLI and slash command

```bash
openclaw workboard list [--board <id>] [--status <status>] [--include-archived] [--json]
openclaw workboard create "Fix stale card lifecycle" --priority high --labels bug,workboard
openclaw workboard show <card-id> [--json]
openclaw workboard move <card-id> --status <status> [--json]
openclaw workboard dispatch [--board <id>] [--json]
```

`list` text output hides archived cards by default (`--include-archived`
overrides). `--json` always includes archived cards, matching the full-card
contract used by existing scripts. `show` and `move` accept an unambiguous id
prefix. `list`, `create`, `show`, and `move` access local plugin state directly.
Stop the Gateway before local `create` or `move`; while it is running, use the
Control UI or Gateway RPC for mutations. Only `dispatch` calls the running
Gateway, with the fallback described above. Data-only dispatch also requires the
Gateway to be stopped; a connection error alone does not establish that it stopped.
Plugin loading can also initialize or upgrade the local database before choosing
the subcommand. Do that preparation with the Gateway stopped, including when the
requested command is `list` or `show`. Use the Control UI or Gateway RPC for online
access when local state still needs preparation.

See [Workboard CLI](/cli/workboard) for full flags, JSON output, Gateway
fallback behavior, id-prefix handling, dispatch selection rules, and
troubleshooting.

`/workboard list`, `/workboard show <card-id>`, `/workboard create <title>`,
`/workboard move <card-id> --status <status>`, and `/workboard dispatch` mirror
the CLI. List and show are read operations for any authorized command sender.
Create, move, and dispatch require owner status on chat surfaces, or a Gateway
client with `operator.write`/`operator.admin`. Manual operator moves use the
same claim-override behavior as Control UI drag-and-drop. Their worktree access
still follows the same workspace boundary described above.

## Session lifecycle sync

Cards can link to an existing Control UI session, or one created when you
start work from the card. Linked cards show the session lifecycle inline:
running, stale, linked idle, done, or failed. You can also capture an
existing session from its header or the Sessions tab with **Add to Workboard**. The card
links to that session, uses the session label or recent user prompt as title,
and seeds notes from the recent user prompt plus the latest assistant response
when available.

Capture keeps the destination board selected when you start the action. It
reloads an inactive board's cards before reusing one, restores an archived
exact match, and never infers session ownership from a provisional link.

Captured sessions show **Open Workboard card** and a linked-card chip. Both use
the same card state, including after a browser reload. Opening a card outside
the current agent filter switches the board to **All agents** without changing
the selected chat agent.

Opening a card loads its linked session details independently of the sidebar's
agent filter and pagination. While details are loading or unavailable, the
card keeps its link and shows **Session state unknown** or **Session
unavailable**. An ambiguous provisional link shows **Session link ambiguous**.
Edit the card to select an exact session. Use **Refresh** to retry. To continue
an existing session, select its exact link in **Edit card** and choose **Open
session**. To start fresh, clear the link in **Edit card**. Clearing the link
retains its task association, so **Start** remains unavailable while that task
is active or unresolved. Changing a card's assignee does not change the owner
of its existing session.

Bare `global` and `unknown` links do not identify a session owner. They show
**Session link ambiguous** when opened. Use **Edit card** to select an explicit
session. Workboard does not offer these bare links for new captures or links.

If an active linked session stops reporting recent activity, Workboard marks the card
`stale` and stores that as metadata until the lifecycle clears it.

Lifecycle writes are owned by the Gateway-side Workboard plugin, so they do
not depend on an open browser tab. Subagent completion hooks persist terminal
outcomes immediately. For ordinary agent runs, Workboard consumes the execution
owner's settled lifecycle event and final outcome, not the attempt-level
`agent_end` hook or a timed session re-read. Intermediate fallback attempts and
yielded turns leave the card running. Success moves the matching run to `review`;
failure, cancellation, or timeout moves it to `blocked`. Events for an older
linked run cannot settle a newer run, and retired services discard queued events.
A recovery sweep runs once per minute and reads only the
sessions linked to active cards, sharing each read across cards with the same link.
Settled cards stop polling unless they retain pending lifecycle state. Provisional
Workboard links share one configured-agent roster per sweep and check exact candidates; ambiguous
or incomplete results leave the card unchanged. Legacy unqualified links use a bounded
search tagged `workboard-lifecycle`. Each store mutation emits
the normal `plugin.workboard.changed` invalidation, so an open Workboard tab reloads
the stored card instead of writing its own lifecycle projection.

Archiving a linked session does not hide its terminal outcome from this sweep.
After a restart or missed completion hook, Workboard still reconciles active cards linked
to archived sessions into `review` or `blocked`.

If a Gateway restart tombstoned a running card's linked session (the session row
reports `restartRecoveryStatus: "tombstoned"`) and no replacement session was
started, the sweep blocks the card instead of leaving it `running`. It closes
the run, records _Session ended during a gateway restart and no replacement
session was started._ with the session key as a comment, emits the normal
`failed` notification, and stores `metadata.automation.restartTombstone`
(`sessionKey`, `detectedAt`). The Control UI's **Why is this waiting?** line
names that session. A later sweep leaves the blocked card alone, and moving the
card out of `blocked` clears the record. Workboard does not reset or replace the
session; that recovery stays with the operator.

If a running card's accepted session link disappears from a complete session
snapshot, and an exact read of that agent-scoped key also finds nothing, the sweep
records the first miss in `metadata.automation.danglingSession` (`sessionKey`,
`runId`, `detectedAt`, `misses`). When the next complete sweep misses the same
attempt again, it blocks the card once with _Linked session is missing;
termination unconfirmed._ and the session key, closes the run, and emits one
`failed` notification. The session link, run id, execution record, and attempt
history stay on the card. A truncated snapshot, a failed exact read, a prepared
launch, an agentless key, or the bare `unknown` link never counts as a miss, and
a session that reappears clears the first miss. Moving the card out of `blocked`
clears the record; Workboard does not clean up the link or workspace on its own.

Lifecycle writes from a superseded attempt are ignored: an update naming a run id
other than the card's current one, or a session only an earlier attempt used,
does not change the card's status, execution, or attempts. A session report never
moves a `review` or `done` card's execution back to running.

Incognito sessions remain absent from session discovery. Explicitly linked
Incognito cards use authorized exact-session metadata reads, without derived
titles or message previews, to reconcile their terminal outcomes.

While a card is in an active work state, Workboard follows the linked session:

| Linked session state                  | Card status |
| ------------------------------------- | ----------- |
| active                                | `running`   |
| completed                             | `review`    |
| failed, killed, timed out, or aborted | `blocked`   |
| tombstoned by a Gateway restart       | `blocked`   |
| missing from two complete sweeps      | `blocked`   |

**Manual review states win.** Moving a card to `review`, `blocked`, or `done`
stops auto-sync for that card until you move it back to `todo` or `running`.

### Completion and acceptance

A worker's own `workboard_complete` call is not acceptance. The card lands in
`review` with the summary, proof, artifacts, created-card manifest, and
`completed` notification recorded as before, plus
`metadata.automation.awaitingAcceptance: true`, `autoCompletedAt`, and
`autoCompletedBy` (the completing agent, else the claim owner its token proved).
Auto-sync leaves it there like any other review card.

`summary` is free-text review prose, capped at **2000 characters**. An over-long
summary is capped, not rejected: the card still completes with its proof,
artifacts, and status move, the stored summary keeps its first characters and
gains an explicit `[truncated: N characters omitted]` marker naming the real
number of dropped characters, and the truncation is recorded on the card as a
warning-level worker log naming the original length. The same 2000-character cap
applies to the `workboard_specify` spec summary and the `workboard_decompose`
summary. Only prose is capped: claim identity, created-card linkage, and proof
or artifact validity still refuse the write and leave the card unchanged.

Acceptance is decided by who completes, not by the card's status:

| Completion                                                                       | Card status                       |
| -------------------------------------------------------------------------------- | --------------------------------- |
| Agent completion (`workboard_complete`) of a card not awaiting acceptance        | `review`, awaiting acceptance     |
| Agent completion of an awaiting card by its `autoCompletedBy` owner (re-claimed) | stays `review`, awaiting          |
| Agent completion of an awaiting card by a different owner                        | `done` (accepts it)               |
| Operator `workboard.cards.complete` through the Gateway                          | `done` (accepts it)               |
| `workboard_decompose` completing its parent                                      | `done`, so its children can start |

An agent completion of a `review` card that is not awaiting acceptance, for
example one auto-sync moved to `review` after the session ended, is a first
report too: it lands in `review` awaiting acceptance, even when the completing
agent is a reviewer. `workboard_decompose` on an awaiting card follows the same
identity rule: only a different owner completes the parent as `done`.

Any status change out of `review` settles the result: `done` accepts it, any
other status sends it back, and both clear the marker. Only the operator (the
Control UI, Gateway methods such as `workboard.cards.move`, and the CLI) or an
agent other than the `autoCompletedBy` owner can do either. The reporting owner
may not: the check runs on every card write, whichever tool makes it. Its
`workboard_move`, `workboard_release`, `workboard_reassign`, or
`workboard_reclaim` with any status other than `review`, and its
`workboard_unblock`, `workboard_block`, or `workboard_protocol_violation`, fail
with an error naming who can settle the card, and the card stays in `review`
unchanged; a refused `workboard_release` or `workboard_block` keeps the claim. Otherwise the owner could send its result back
and then move the card to `done`, because a card that was sent back no longer
awaits anything. The owner may revise its result in place instead: claim the card
and call `workboard_complete` again, which keeps it in `review` awaiting
acceptance and records the new summary and `autoCompletedAt`.

After the operator or another agent sends the card back, its next agent
completion is a fresh report: it lands in `review` awaiting acceptance with
`autoCompletedBy` set to the agent that completed the rework, so that agent cannot
accept it either. Cards an older build marked as awaiting carry no
`autoCompletedBy`: an agent's `workboard_complete` leaves them in `review`, and
the operator or any status move settles them.

Children that depend on the card stay `todo` until it is accepted. Until then the
card carries the `awaiting_acceptance` diagnostic, and the Control UI shows an
**Awaiting acceptance** chip on it.

Opening an automatically finished card in the Control UI records
`metadata.automation.acceptanceSeenAt` through `workboard.cards.update` with the
card's `expectedUpdatedAt`. A `done` card that finished automatically and has not
been opened since shows a **New** chip.

Starting a card uses normal Gateway sessions. Workboard only stores card
metadata and links. Conversation transcript, model selection, and run
lifecycle stay owned by the regular session system. Use **Stop** on a live
linked card to abort the active run - Workboard marks that card `blocked` so
it stays visible for follow-up.

New cards can start from Workboard templates (`bugfix`, `docs`, `release`,
`pr_review`, `plugin`). Templates prefill title, notes, labels, and priority.
The template id is stored as card metadata.

<a id="dashboard-workflow" />

## Control UI workflow

1. Open the Workboard tab in the Control UI.
2. Create a card with a title, notes, priority, labels, optional agent, and
   optional linked session - or open Sessions and choose **Add to Workboard**
   for an existing session.
3. Drag the card between columns, or focus its compact status control and use
   the menu or ArrowLeft/ArrowRight. During a drag, the source card dims and
   available drop columns gain an outline.
4. Start an unlinked card when it has no active or unresolved task association.
5. Open the linked session from the card while the agent works.
6. Let lifecycle sync or the worker's completion move running work into
   `review`/`blocked`, then manually move the card to `done` when accepted.

A card that waits on you shows one **Needs you** badge and a second leading
stripe, on board cards and list rows alike. It appears when the card is in
`review`, when it is `blocked` and carries the `decision` label (any case), or
when it has no agent and is in `triage`, `backlog`, `todo` or `ready`. The
browser derives it from those existing fields on every render; it is
not stored and adds no card field. Archived cards never show it, even in
`review`. The badge and stripe use the host's `--danger` color, so they never
take one of the board's classification palette slots, and a classified card shows
both stripes.

### Select several cards and accept them in one batch

A triage backlog is worked in batches, not card by card. Select cards and one
**Move to…** picker accepts or sorts all of them at once.

- **Select:** shift-click a card, or press `Shift+Enter`/`Shift+Space` while it is
  focused, to start a selection; keep clicking cards to extend it. A column's
  overflow menu offers **Select all in column**. Archived cards are never
  selectable; the selection is scoped to the board and agent filter, and changing
  either one clears it.
- **Act on the selection:** the toolbar switches to a selection group with
  **Move to…** (every status, including `done`), **Assign agent…**, **Edit
  properties** (priority, agent, labels), **Archive**, and **Delete**. Moving to
  `done` is the batch acceptance: it is the same write as a single drag to the
  `done` column, applied per card.
- **Safety:** every write carries the revision the browser last read for that
  card and the batch stops at the first conflict instead of overwriting a newer
  change; the cards that were not applied stay selected with the error, so you
  can re-read and retry. The batch reports _applied to N of M cards_ when it
  stops early. Archived-only cards and cards outside the current scope are
  dropped before the write.

Batch acceptance is a Control UI action; there is no `openclaw workboard` bulk
subcommand. A script that must accept several cards can send the same write(s)
through the Gateway RPC (see [Permissions](#permissions)) — one
`workboard.cards.move` per card, or `workboard.cards.bulk` with `ids` and a
`patch`/`archived` for a shared change — with the fail-closed semantics
above. Neither path auto-closes a card: it only moves the cards you named.

### Voice control

The Workboard page heading (card boards and Sessions boards) and the
`workboard:board` dashboard widget show a microphone. It is the composer's
dictation control: tap once to start, tap again to stop. Device choice,
transcription, and the reason dictation is unavailable are the same as in a new
session's composer. Press Escape or leave the page to cancel without sending.

The board on screen when you start speaking is captured then; switching boards
mid-sentence does not retarget the turn. When you stop, nothing is sent yet: a
**Check transcript** dialog shows the recognized text in an editable field.
Above it, **Run by: &lt;agent&gt; · &lt;target&gt;** names the agent of the dock
conversation that will run the turn and the board (or board and card) it is
about. On a Sessions board whose Board agent conversation does not exist yet,
the line reads **Board agent, resolved on send** until the send creates it.

- **Send** sends the edited text as one chat turn with Working context
  `page: "workboard"` and `detail: { boardId, boardKind }`, closes the dialog,
  and opens the conversation in the dock. The microphone then shows **Sent to
  &lt;agent&gt;. The answer follows in the dock.**
- **Discard**, or Escape, closes the dialog without sending or creating a
  conversation, and the microphone shows **Discarded.**
- **Send** is disabled while the text is empty. If the send fails, the dialog
  stays open with the error under the field and your text intact, so you can
  retry or discard.

The dialog's action row carries the same controls as the chat composer:

- The model picker and thinking selector change the conversation the turn is
  sent to, exactly as in that conversation's composer. For a card turn that is
  the card's own conversation and agent, never the board's. Until a first turn
  creates that conversation (the first voice turn on a card board or about a
  card, or a Sessions board without a saved Board agent conversation), they
  show the agent's defaults, disabled, with the reason in their tooltip.
- **Record again** is the composer's dictation microphone. The new recording
  replaces the text in the field; a recording without speech keeps it.
- **Send** is the composer's send button. While that conversation is running,
  it reads **Steer** or **Queue** from your follow-up setting and the session's
  queue mode, and the turn is delivered that way. Queued turns use the
  Gateway's follow-up queue and run after the current turn. On a read-only
  connection you can still record and edit, but **Send** stays disabled with the
  composer's reason.

The all-boards view captures no board, so the turn carries only
`page: "workboard"`.

- On a Sessions board, the turn goes to the board's saved **Board agent**
  conversation, created on first use like the **Board agent** button.
- Card boards have no saved Board agent conversation. The first voice turn per
  board creates a dock conversation named **Workboard · &lt;board name&gt;** with
  the selected or default agent and reuses it until the Control UI reloads.

The card detail drawer's **Overview** tab has its own microphone, **Talk about
this card**. It sends the same kind of turn with
`detail: { boardId, boardKind: "cards", cardId }` for the card's own board,
even when the page shows all boards. The turn runs as the **card's agent** (the
agent shown in the card's **Agent** field, or the default agent when the card
has none), not the selected agent, in the card's own dock conversation named
**Workboard · &lt;board name&gt; · "&lt;card title&gt;"**. That conversation is
created on the first turn about the card and reused until the Control UI
reloads; it is never shared with the board microphone or another card. The card
and its agent are captured when you start speaking; opening another card or
board mid-sentence does not retarget the turn. It uses the same dialog, whose
line names the card's agent and the card. After the send,
the drawer shows **Sent about "&lt;card title&gt;". The answer follows in the
dock.** The agent's answer appears in the dock, and the card picks up the change
through the normal Workboard live refresh.

Card changes an agent makes record that agent on the card event:
`workboard_move`, `workboard_update`, `workboard_set_parallelism`,
`workboard_comment`, `workboard_reassign`, `workboard_complete`, and
`workboard_block` store the calling agent id from the Gateway's tool context,
never from the browser. The card's **Activity** tab shows it next to the event
and its time, for example **Moved to Review by &lt;agent&gt;**. Events from
operator actions, from other tools, and from before this field existed show only
the text and time. Attribution is a record, not authority: claim checks and
permissions are unchanged.

On such a turn, `workboard_read`, `workboard_move`, `workboard_comment`,
`workboard_update`, `workboard_reassign`, `workboard_proof`,
`workboard_complete`, and `workboard_block` may omit `id`. The bound card fills
it only while it still exists, is not archived, and lives on the bound cards
board; otherwise the call fails with `id required` and changes nothing. An
explicit `id` always wins. The bound card never widens claim scope or
`workboard_dispatch`, and status holds, claim checks, and dispatch rules apply
as for any other call. So "move it to running", "make it urgent", "add the
needs-qa label", "assign it to writer", or "note that QA passed" edit only the
card you were looking at.

Spoken requests change the board only through the existing tools, such as
`workboard_move`, `workboard_comment`, `workboard_dispatch`, and
`workboard_update`, and `workboard_sessions_board_move`, with the caller's normal scopes. A read-only
connection can still record, but sending a chat turn needs `operator.write`:
the dialog disables **Send** and shows **Sending messages is unavailable with
your current access.**, and nothing is sent. Board context in the turn is quoted reference
data, never instructions or authority.

### Fill in a new card by voice

The **New card** dialog has its own microphone in its header, **Fill in the card
by voice**. It is the same composer dictation control. Speak one sentence, for
example "fix the login bug on Safari, urgent, label frontend, for writer". While
the draft is prepared the dialog shows **Filling in the form from your
words…**; only the microphone waits, so you can keep typing.

The answer fills in the open form: title, notes, labels, priority, and, when
you said them, status and assigned agent. Only fields your sentence supports
are filled in; a field it does not mention keeps whatever you already entered.
The dialog stays open and shows **Filled in from your words. Check the fields;
nothing is created until you press Create.** Nothing is saved until you press
**Create**; **Cancel** discards the draft as usual.

- Labels come only from the board's [classification palette](#classification-palette),
  in the palette's spelling. A label you said that is not on the palette is left
  out, and a short note under the status line names it. On a board without a
  palette yet, no labels are set and the note says so. Add labels with the label
  editor; speech never adds palette entries.
- Status and priority come only from the fixed Workboard lists. An agent is set
  only when it names a configured agent; otherwise it is left out with a note.
- If drafting fails, the dialog's error message explains why, every field keeps
  its value, and the dialog stays open.
- A read-only connection shows the microphone disabled with its reason. The
  microphone is not offered when editing an existing card.

The dialog calls `workboard.cards.draft` (`operator.write`, because it spends
model tokens). It reads the board palette and the configured agents, asks a
model for a JSON draft through the plugin model-completion runtime
(`api.runtime.llm.complete`, under the caller's operator authority and the
plugin's model policy; the browser cannot choose the model or agent), and
normalizes the answer. It stores nothing: no card, event, or palette change.

- Params: `voiceText` (required, 1-2000 characters after trimming) and optional
  `boardId` (defaults to `default`). Any other field, such as `model` or
  `agentId`, is rejected.
- Result: a `draft` object with optional `title`, `notes`, `status`,
  `priority`, `labels`, and `agentId`, plus a `hints` string array. `title` is
  at most 180 characters and `notes` at most 4000; longer values are shortened
  with a hint. An answer that is not one JSON object of the expected shape is an
  error, never a partial draft.

### Decision cards

A blocked card with the `decision` label waits on the operator. Its drawer
shows **Your decision**: the operator picks one of the card's options or types
an answer. Either way the answer is saved as the comment `Decision: <answer>`.
Picking an option, or typing an answer and choosing **Decision made**, then
moves the card to Ready and drops the `decision` label in the same write.
**Add note** saves the comment and keeps the card blocked.

Agents supply the options with `decisionOptions` on `workboard_create`,
`workboard_update`, or `workboard_block`: 2 to 6 entries of
`{ label, description?, recommended? }` (label at most 64 characters,
description at most 240). The list order is the number the operator sees, so
put the recommended choice where you want it. Mark at most one entry
`recommended`; if several are marked, only the first counts. On
`workboard_update`, omitting `decisionOptions` keeps the stored list and `[]`
clears it. The tools reject invalid lists with a reason; other writers, such as
raw `metadata.automation` patches, drop invalid entries instead. The options
are stored in `metadata.automation.decisionOptions`, so `workboard_read`
returns them.

The options appear as a numbered list with the description under each label
and a **Recommended** badge on the recommended one. Labels and descriptions are
rendered as inline Markdown (they stay inside the option's button, so they carry
no block structure), and the card's notes, operator comments, proof notes and the
waiting line render as Markdown too; a ```mermaid fence in notes or a comment is
shown as a diagram, with the source kept as text when the renderer fails. The
operator can click an
option, press its number key while focus is in the panel but outside a text
field, or move between options with the arrow keys and press Enter or Space.
Arrow keys only move focus; they never decide. A custom answer field is always
there, and typing in it never decides on its own.

Cards without `decisionOptions` keep the earlier convention: unchecked task
items in the notes (`- [ ] SQLite`) become numbered options without a
description or badge. A card with neither shows only the answer field. A
decision has one answer; the picker never offers multiple selection.

If a dispatch run starts while the comment is saved, the card cannot move to
Ready. The panel keeps the chosen option and any typed text, and the board
shows that the decision was saved as a note, so the operator can decide again.

### Opening and downloading a path artifact

A card artifact may name a host path instead of a URL — for example a report a
worker wrote outside every agent workspace. The drawer's action for such a row
comes entirely from the Gateway, never from path math in the browser.

The operator configures the eligible directories under
`plugins.entries.workboard.config.fileRoots`: each entry is an absolute,
canonical host path and an optional `baseUrl` (an `http(s)` origin plus an
optional path prefix). A root without `baseUrl` is download-only.

```json
{
  "plugins": {
    "entries": {
      "workboard": {
        "config": {
          "fileRoots": [
            {
              "root": "/workspace/shared/reports-export",
              "baseUrl": "https://files.example.test/reports"
            }
          ]
        }
      }
    }
  }
}
```

- `workboard.artifacts.fileAccess` (`operator.read`) takes the **card id** and
  returns `{ files: { [artifactId]: { open?: { url }, download?: { url,
expiresAt } } } }`. The card's stored paths are resolved server-side; the
  request never carries a path.
- **Open** is offered only when the artifact's root has a `baseUrl` and the file
  is not a document. `text/html`, `application/xhtml+xml` and `image/svg+xml`
  are always download-only, whether they arrive as attachments or path artifacts.
- **Download** is served by the plugin's own route
  (`/plugins/workboard/files/<connId>/<ticket>`, `GET`/`HEAD`). The ticket is
  opaque, bound to one resolved file and to the bytes read when it was minted,
  expires after five minutes, and dies with its connection. Every response is
  `application/octet-stream` with `Content-Disposition: attachment`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  `Cache-Control: no-store` and `Content-Security-Policy: default-src 'none';
sandbox`, so no file ever becomes a document on the Gateway origin.
- Containment is decided by path components, not string prefixes
  (`/exports-other/x` is not inside `/exports`), and a symlink is re-checked
  against the root's real path before any byte is read. Rows the Gateway did not
  approve keep only **Copy path** (and the markdown **Preview**).

### Sharing an artifact

In the card drawer's **Artifacts and files** block, every row with a web URL or
a host path has **Share…**. Attachments without a path or URL have nothing to
share and get no action. The action is shown only while the Control UI is
connected to the Gateway.

**Share…** opens a dialog that shows the exact message before anything is
sent: the artifact label on the first line and its URL (or, without one, its
path) on the second. When the label is the reference itself, it is sent once.
Only this reference is shared. The file is never uploaded and no media is
attached.

1. Pick a **Channel**. The list comes from `channels.status` (`operator.read`)
   and contains channels with at least one enabled, configured account. When a
   channel has several accounts, an **Account** picker appears with the
   channel's default account selected.
2. Enter the **Recipient** in the channel's own format. With `operator.admin`,
   the field suggests targets from `conversations.list` for the chosen channel,
   account, and the scoped agent. Suggestions are only a convenience: the text
   you enter is what is sent, and no account or thread routing is taken from the
   directory. Without admin access, or when the directory is unavailable, the
   field stays a plain text field.
3. **Send** calls the Gateway `send` method (`operator.write`) once with
   `channel`, `accountId`, `to`, the message text, and a new `idempotencyKey`.
   On success the dialog closes and the row shows **Sent to &lt;recipient&gt;
   via &lt;channel&gt;.**

Choosing a channel, account, or suggestion never sends. **Cancel** and Escape
close the dialog without a request; Escape is ignored while a send is in flight.
**Send** stays disabled, with the reason under the field, while channels load,
when no channel is set up, on a read-only connection, or while the recipient is
empty. If the send fails, the dialog stays open with **Could not send: …** under
the field and keeps the recipient, channel, and account, so you can correct the
recipient and send again.

Sharing writes nothing to the Workboard store: no card event, comment, or status
change records it. The receipt lives in the open drawer only; the message in the
channel is the lasting record.

### Session-board widgets

Workboard ships three native widgets for session dashboards (see
[Dashboards](/web/dashboards)). The agent pins them with its `dashboard` tool
using `content: { kind: "plugin", pluginKind, props }`, and they render as
first-party UI with live data — no sandbox frame or capability grant:

- `workboard:card` with `props: { cardId }` shows one card with its status
  control, priority, and assigned agent.
- `workboard:board` with optional `props: { boardId }` shows the full Kanban
  board with draggable cards and status controls. Without `boardId` it shows
  every board. With `boardId` it shows only that board.
- `workboard:mini` with optional `props: { boardId, limit }` shows per-status
  counts plus the top ready/running cards, and links to the full board page.
  Without `boardId` it aggregates every board. With `boardId` it scopes to that
  board (cards created without an explicit board id live on `default`).

## Diagnostics

Diagnostics are computed from local card metadata. Built-in checks flag:

| Kind                        | Condition                                                                      |
| --------------------------- | ------------------------------------------------------------------------------ |
| `stranded_ready`            | Assigned `todo`/`backlog`/`ready` card not updated in over 1 hour.             |
| `running_without_heartbeat` | `running` card with no claim heartbeat or execution update in over 20 minutes. |
| `blocked_too_long`          | `blocked` card not updated in over 24 hours.                                   |
| `repeated_failures`         | Card's tracked failure count reaches 2 or more.                                |
| `missing_proof`             | `done` card with no proof, artifacts, or attachments.                          |
| `orphaned_session`          | `running` card with a `sessionKey` but no `execution` metadata.                |
| `archived_but_active`       | Archived card remains in any non-`done` lifecycle status.                      |
| `awaiting_acceptance`       | `review` card a worker completed that nobody has accepted yet.                 |

## Permissions

Gateway RPC methods live under `workboard.*`. Sessions board methods use the same
read/write scopes as boards:

| Scope            | Methods                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `operator.read`  | `cards.list`, `cards.export`, `cards.diagnostics`, attachment list/get, `artifacts.fileAccess`, notification event reads, `boards.list`, `cards.stats`, `cards.runs`                                                                                                                                                                                                                                                                                     |
| `operator.read`  | `sessionsBoard.read`                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `operator.write` | `cards.diagnostics.refresh`, create/captureSession/update/move/delete/comment/link/linkDependency/unlinkDependency/proof/artifact, attachment add/delete, worker log, protocol violation, claim/heartbeat/release/promote/reassign/reclaim/complete/block/unblock/start, `cards.dispatch`, `cards.bulk`, archive, `boards.upsert`/`archive`/`delete`, `cards.specify`/`decompose`, `cards.draft` (stores nothing), notification subscribe/delete/advance |
| `operator.write` | `sessionsBoard.update`, `sessionsBoard.move`                                                                                                                                                                                                                                                                                                                                                                                                             |

`workboard.cards.update`, `workboard.cards.move`, `workboard.cards.archive`, and
`workboard.cards.delete` accept an optional `expectedUpdatedAt` request field.
Pass the finite numeric `updatedAt` from the card you read to guard the write.
If the card has changed, the request fails with `workboard_conflict` and returns
its latest card in `error.details.card` (`error.details.type` is
`workboard_card_conflict`). Review that card before retrying. Omitting the field
keeps the method's existing unguarded request behavior.

`workboard.cards.move` also accepts an optional `labelsRemove` array. Those
labels (matched case-insensitively) are dropped in the same write as the status
change. The Control UI uses it to remove the `decision` label when the operator
records a decision and the card moves to Ready.

Control UI bulk actions use each card's observed revision and stop on a conflict.
Remaining cards stay selected for review and retry; the batch does not silently
retry against newer revisions or overwrite another client's changes.

No RPC method requires `operator.admin`. Browsers connected with read-only
operator access can inspect the board but cannot mutate cards. An admin scope
widens accepted Workboard host paths. It does not change the methods available.

## Storage

Workboard stores durable data in a plugin-owned relational SQLite database
under the OpenClaw state directory: boards, cards, labels, lifecycle events,
run attempts, comments, dependency links, proof, artifact references,
attachment metadata and blobs, diagnostics, notifications, worker logs,
protocol state, and subscriptions all live in Workboard tables (not
plugin key-value entries). A card export preserves the board narrative
without inlining attachment blob contents.

Card events carry an optional `agent_id` column (schema version 4) for the
agent that caused them. Existing databases gain the column on open, and existing
events keep it empty; the experimental PostgreSQL engine migrates version 3
stores by adding the same nullable column.

Sessions boards add optional `kind` and `sessions_spec` columns to
`workboard_boards`, plus `workboard_session_placements` for operator pins.
Existing board rows are not backfilled;
an absent kind still means a Cards board. Rolling back to a release without Sessions
boards shows each Sessions board as an empty Cards board and ignores the placement
table; cards created against it there are rejected once the newer release runs again. Session transcripts and the Board agent
conversation remain in the normal session store.

Classification palettes live in the nullable `classifications_json` column of
`workboard_boards`. Rolling back to a release without palettes ignores the column
and accepts any label. After upgrading, the stored palette applies again; labels
added in between stay on their cards and render as plain chips unless they match a
classification.

SQLite opening, queries, and transactions run in a background database worker.
Disabling or reloading the plugin drains admitted storage work before closing
its connections.

Workboard instances invalidate cached card lists and board revisions using the
physical database's in-process writer receipts, including commits through sibling
instances. Card-list reuse checks that receipt; an unsettled receipt leaves the
read uncached. A read overlapping a mutation can return its older snapshot; the
next request observes the writer receipt and reloads it. Change notifications use owner publications;
there is no timer polling SQLite for writes from other processes. If a worker
reply fails after a possible commit, the owner discards cached facts and rereads
them on the next use without replaying the mutation.

Installations with retained pre-July 2026 Workboard plugin-state KV data must
upgrade through OpenClaw `2026.9.7` and run `openclaw doctor --fix` before upgrading
to the latest version. Current Doctor reports this requirement without changing
the legacy rows; current relational SQLite stores remain supported.

## Troubleshooting

**The tab says Workboard is unavailable**

```bash
openclaw plugins inspect workboard --runtime --json
```

If `plugins.allow` is configured, add `workboard` to it. If `plugins.deny`
contains `workboard`, remove it before enabling the plugin.

**Cards do not save**

Confirm the browser connection has `operator.write` access. Read-only operator
sessions can list cards but cannot create, edit, move, or delete them.

**Starting a card does not open the expected session**

Check the card's agent id and linked session, then open Sessions or Chat to
inspect the actual run state.

**Dispatch does not start a worker**

Confirm there is at least one `ready` card without an active claim:

```bash
openclaw workboard list --status ready
```

If the CLI reports data-only dispatch, start or restart the Gateway and
retry - data-only dispatch updates local board state but cannot start
subagent worker runs. Cards can also be skipped when the same owner or agent
already holds as many active cards as the board's
`maxActivePerOwner` allows (default 1). Complete, block, or release that
active work, or raise the board's limit,, or mark genuinely independent cards as
`parallelizable` with a higher `maxConcurrentPerOwner`, before dispatching
more for the same owner.

## Related

- [Control UI](/web/control-ui)
- [Workboard CLI](/cli/workboard)
- [Plugins](/tools/plugin)
- [Manage plugins](/plugins/manage-plugins)
- [Sessions](/concepts/session)
- [Managed worktrees](/concepts/managed-worktrees)
