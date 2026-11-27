import {
  WORKBOARD_PRIORITIES,
  WORKBOARD_STATUSES,
  WORKBOARD_VERIFICATION_OUTCOMES,
  type WorkboardCard,
} from "@openclaw/workboard-contract";
import { jsonResult, readStringParam } from "openclaw/plugin-sdk/core";
import { resolveIntegerOption } from "openclaw/plugin-sdk/number-runtime";
import type { AnyAgentTool, OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";
import { buildWorkboardParallelismPatch } from "./card-parallelism.js";
import { redactClaimToken } from "./card-redaction.js";
import { buildWorkboardCardUpdatePatch } from "./card-update.js";
import type { WorkboardClassificationChange } from "./classification-palette.js";
import { cardBoardId } from "./store-card-helpers.js";
import type { WorkboardInteractionStamp } from "./store-inputs.js";
import { normalizeCappedStringList } from "./store-string-lists.js";
import type { WorkboardStore } from "./store.js";
import {
  askField,
  askKindField,
  boundCardIdField,
  cardIdField,
  claimTokenField,
  createWorkboardCardMutations,
  decisionOptionsField,
  dispatchModeField,
  maxConcurrentPerOwnerField,
  maxConcurrentPerOwnerPatchField,
  parallelizableField,
  strictObject,
  withDecisionOptions,
  withWorkboardOperatorAsk,
  workspaceField,
} from "./tools-card-mutations.js";
import { createWorkboardOrchestrationTools } from "./tools-orchestration.js";
import { readVoiceBoardBinding, type VoiceBoardBinding } from "./voice-board-binding.js";

function contextOwner(ctx: OpenClawPluginToolContext | undefined): string {
  return ctx?.agentId || ctx?.sessionKey || ctx?.sessionId || "agent";
}

/** The calling agent recorded on card events; unlike the owner it never falls back. */
function contextAgent(ctx: OpenClawPluginToolContext | undefined): string | undefined {
  return ctx?.agentId?.trim() || undefined;
}

/**
 * The interaction link for a card-bound turn: the session key and agent the server
 * resolved for this invocation, never a tool argument. Only a turn that named one
 * card (`detail.cardId`) records one, and only the board's dock conversation runs
 * on this surface; a board-level voice turn, a plain agent edit, an operator write
 * and the CLI all leave the field absent. Reference data, never authority.
 */
function cardBoundInteraction(
  ctx: OpenClawPluginToolContext | undefined,
  voiceBoard: VoiceBoardBinding | undefined,
): Omit<WorkboardInteractionStamp, "at"> | undefined {
  if (!voiceBoard?.cardId) {
    return undefined;
  }
  const sessionKey = ctx?.sessionKey?.trim();
  if (!sessionKey) {
    return undefined;
  }
  const agentId = contextAgent(ctx);
  return {
    sessionKey,
    ...(agentId ? { agentId } : {}),
    surface: "plugin-dock",
  };
}

function summarizeCard(card: WorkboardCard) {
  return {
    id: card.id,
    title: card.title,
    status: card.status,
    priority: card.priority,
    agentId: card.agentId,
    tenant: card.metadata?.automation?.tenant,
    boardId: card.metadata?.automation?.boardId ?? "default",
    parents: card.metadata?.links
      ?.filter((link) => link.type === "parent" && link.targetCardId)
      .map((link) => link.targetCardId),
    children: card.metadata?.links
      ?.filter((link) => link.type === "child" && link.targetCardId)
      .map((link) => link.targetCardId),
    claim: card.metadata?.claim
      ? {
          ownerId: card.metadata.claim.ownerId,
          claimedAt: card.metadata.claim.claimedAt,
          lastHeartbeatAt: card.metadata.claim.lastHeartbeatAt,
          expiresAt: card.metadata.claim.expiresAt,
        }
      : undefined,
    diagnostics: card.metadata?.diagnostics,
    archivedAt: card.metadata?.archivedAt,
    updatedAt: card.updatedAt,
  };
}

function redactedProofResult(card: WorkboardCard) {
  const proofId = card.metadata?.proof?.at(-1)?.id;
  if (!proofId) {
    throw new Error("proof was not retained in card metadata.");
  }
  return jsonResult({
    card: redactClaimToken(card),
    proofId,
  });
}

const ScopedClaimTokenField = claimTokenField("Claim token for claimed cards.");

const ReplacesField = Type.Optional(
  Type.String({
    description:
      "Existing classification a new label overwrites when the board already has 10; the slot keeps its color and position.",
  }),
);

/** The board palette after a card write, so the model reuses names instead of adding near-duplicates. */
async function classificationResult(
  store: WorkboardStore,
  card: WorkboardCard,
  change: WorkboardClassificationChange | undefined,
) {
  if (!change) {
    return { classifications: await store.readClassifications(cardBoardId(card)) };
  }
  return {
    classifications: change.classifications,
    ...(change.added.length > 0 ? { classificationsAdded: change.added } : {}),
    ...(change.replaced ? { classificationReplaced: change.replaced } : {}),
  };
}

const CardIdSchema = strictObject({
  id: cardIdField(),
  token: claimTokenField(),
});

// Schemas are module-owned; each factory call binds fresh execution and claim authority.
const toolSchemas = {
  list: strictObject({
    status: Type.Optional(Type.String({ description: "Optional card status filter." })),
    agentId: Type.Optional(Type.String({ description: "Optional agent id filter." })),
    tenant: Type.Optional(Type.String({ description: "Optional tenant filter." })),
    boardId: Type.Optional(Type.String({ description: "Optional board id filter." })),
    limit: Type.Optional(Type.Number({ description: "Maximum cards to return. Default 50." })),
    refreshDiagnostics: Type.Optional(
      Type.Boolean({ description: "Refresh stored diagnostics before listing." }),
    ),
    includeArchived: Type.Optional(
      Type.Boolean({ description: "Include archived cards. Default false." }),
    ),
  }),
  create: strictObject({
    title: Type.String({ description: "Card title." }),
    notes: Type.Optional(Type.String({ description: "Card notes or acceptance criteria." })),
    status: Type.Optional(Type.String({ description: "Initial status." })),
    priority: Type.Optional(Type.String({ description: "low, normal, high, or urgent." })),
    labels: Type.Optional(Type.Array(Type.String(), { description: "Card labels." })),
    replaces: ReplacesField,
    agentId: Type.Optional(Type.String({ description: "Assigned agent id." })),
    parents: Type.Optional(Type.Array(Type.String(), { description: "Parent card ids." })),
    token: Type.Optional(Type.String({ description: "Claim token for claimed parent cards." })),
    tenant: Type.Optional(Type.String({ description: "Soft tenant namespace." })),
    boardId: Type.Optional(Type.String({ description: "Soft board namespace." })),
    createdByCardId: Type.Optional(
      Type.String({ description: "Parent card that created this card." }),
    ),
    idempotencyKey: Type.Optional(
      Type.String({
        description: "Reuse this key when retrying to avoid creating a duplicate card.",
      }),
    ),
    skills: Type.Optional(Type.Array(Type.String(), { description: "Suggested skills." })),
    workspace: workspaceField(),
    maxRuntimeSeconds: Type.Optional(Type.Number({ description: "Run timeout seconds." })),
    maxRetries: Type.Optional(Type.Number({ description: "Retry budget." })),
    parallelizable: parallelizableField(),
    maxConcurrentPerOwner: maxConcurrentPerOwnerField(),
    dispatchMode: dispatchModeField(),
    scheduledAt: Type.Optional(Type.Number({ description: "Unix epoch milliseconds." })),
    decisionOptions: decisionOptionsField(),
    ask: askField(),
    askKind: askKindField(),
  }),
  link: strictObject({
    parentId: Type.String({ description: "Parent card id." }),
    childId: Type.String({ description: "Child card id." }),
    token: Type.Optional(
      Type.String({ description: "Claim token for claimed parent or child cards." }),
    ),
  }),
  claim: strictObject({
    id: cardIdField(),
    ttlSeconds: Type.Optional(Type.Number({ description: "Claim TTL in seconds." })),
  }),
  heartbeat: strictObject({
    id: cardIdField(),
    token: claimTokenField(),
    note: Type.Optional(Type.String({ description: "Optional compact progress note." })),
  }),
  release: strictObject({
    id: cardIdField(),
    token: claimTokenField(),
    status: Type.Optional(Type.String({ description: "Omit: clear claim only, preserve status." })),
  }),
  comment: strictObject({
    id: boundCardIdField(),
    body: Type.String({ description: "Comment body." }),
    token: ScopedClaimTokenField,
  }),
  proof: strictObject({
    id: boundCardIdField(),
    status: Type.Optional(Type.String({ description: "passed, failed, skipped, or unknown." })),
    label: Type.Optional(Type.String({ description: "Proof label." })),
    command: Type.Optional(Type.String({ description: "Command or exact step run." })),
    url: Type.Optional(Type.String({ description: "Proof or artifact URL." })),
    note: Type.Optional(Type.String({ description: "Short proof note." })),
    artifactPath: Type.Optional(Type.String({ description: "Optional local artifact path." })),
    token: ScopedClaimTokenField,
  }),
  complete: strictObject({
    id: boundCardIdField(),
    token: claimTokenField(),
    summary: Type.Optional(Type.String({ description: "Completion summary." })),
    proofId: Type.Optional(
      Type.String({
        description: "Proof id returned by workboard_proof when resolving that pending proof.",
      }),
    ),
    proof: Type.Optional(
      strictObject({
        status: Type.Optional(Type.String({ description: "passed, failed, skipped, or unknown." })),
        label: Type.Optional(Type.String({ description: "Proof label." })),
        command: Type.Optional(Type.String({ description: "Command or step run." })),
        url: Type.Optional(Type.String({ description: "Proof URL." })),
        note: Type.Optional(Type.String({ description: "Proof note." })),
      }),
    ),
    artifacts: Type.Optional(
      Type.Array(
        strictObject({
          label: Type.Optional(Type.String()),
          url: Type.Optional(Type.String()),
          path: Type.Optional(Type.String()),
          mimeType: Type.Optional(Type.String()),
        }),
      ),
    ),
    createdCardIds: Type.Optional(
      Type.Array(Type.String(), { description: "Cards created during this run." }),
    ),
    claims: Type.Optional(
      Type.Array(
        strictObject({
          statement: Type.String({ description: "One thing you claim the result does." }),
          proofId: Type.Optional(
            Type.String({ description: "Existing proof id that backs this claim." }),
          ),
        }),
        {
          description:
            "Optional itemized claims, recorded as your claims; completion never waits on them.",
        },
      ),
    ),
  }),
  verify: strictObject({
    id: cardIdField(),
    scope: Type.String({ description: "What you checked, and how." }),
    outcome: Type.Union(
      WORKBOARD_VERIFICATION_OUTCOMES.map((outcome) => Type.Literal(outcome)),
      { description: "Your conclusion." },
    ),
    claimId: Type.Optional(Type.String({ description: "Claim record you checked." })),
    proofId: Type.Optional(Type.String({ description: "Proof record you checked." })),
    artifactId: Type.Optional(Type.String({ description: "Artifact you checked." })),
    runId: Type.Optional(Type.String({ description: "Run whose result you checked." })),
    note: Type.Optional(Type.String({ description: "Short finding." })),
    url: Type.Optional(Type.String({ description: "http(s) link to your check." })),
    token: ScopedClaimTokenField,
  }),
  attachment_add: strictObject({
    id: cardIdField(),
    fileName: Type.String({ description: "Attachment file name." }),
    contentBase64: Type.String({ description: "Base64 attachment content." }),
    mimeType: Type.Optional(Type.String({ description: "Attachment MIME type." })),
    note: Type.Optional(Type.String({ description: "Optional attachment note." })),
    token: ScopedClaimTokenField,
  }),
  attachment_read: strictObject({
    id: Type.String({ description: "Attachment id." }),
  }),
  attachment_delete: strictObject({
    id: cardIdField(),
    attachmentId: Type.String({ description: "Attachment id." }),
    token: ScopedClaimTokenField,
  }),
  block: strictObject({
    id: boundCardIdField(),
    token: claimTokenField(),
    reason: Type.Optional(Type.String({ description: "Blocker summary." })),
    decisionOptions: decisionOptionsField(),
    ask: askField(),
    askKind: askKindField(),
  }),
  move: strictObject({
    id: boundCardIdField(),
    status: Type.Union(
      WORKBOARD_STATUSES.map((status) => Type.Literal(status)),
      { description: "Target Workboard status." },
    ),
    token: claimTokenField("Claim token for claimed cards."),
  }),
};

export function createWorkboardTools(params: {
  context?: OpenClawPluginToolContext;
  store: WorkboardStore;
}): AnyAgentTool[] {
  const { store } = params;
  const ownerId = contextOwner(params.context);
  const runId = params.context?.runId;
  const callerAgentId = contextAgent(params.context);
  const voiceBoard = readVoiceBoardBinding(params.context);
  const interaction = cardBoundInteraction(params.context, voiceBoard);
  const { readCardId, readScopedCardToolParams, scopedCardMutation, claimedCardMutation } =
    createWorkboardCardMutations(store, ownerId, runId, voiceBoard, callerAgentId, interaction);
  const tools: AnyAgentTool[] = [
    {
      name: "workboard_list",
      label: "Workboard List",
      description:
        "List Workboard cards with compact claim and diagnostic state. Use before choosing or routing board work.",
      parameters: toolSchemas.list,
      execute: async (_toolCallId, rawParams) => {
        const record = rawParams as Record<string, unknown>;
        if (record.refreshDiagnostics === true) {
          await store.refreshDiagnostics();
        }
        const status = typeof record.status === "string" ? record.status : undefined;
        const agentId = typeof record.agentId === "string" ? record.agentId : undefined;
        const tenant = typeof record.tenant === "string" ? record.tenant : undefined;
        const boardId = typeof record.boardId === "string" ? record.boardId : undefined;
        const limit = resolveIntegerOption(record.limit, 50, { min: 1, max: 200 });
        const cards = (await store.list({ boardId }))
          .filter((card) => record.includeArchived === true || !card.metadata?.archivedAt)
          .filter((card) => !status || card.status === status)
          .filter((card) => !agentId || card.agentId === agentId)
          .filter((card) => !tenant || card.metadata?.automation?.tenant === tenant)
          .slice(0, limit)
          .map(summarizeCard);
        return jsonResult(voiceBoard ? { cards, voiceBoard } : { cards });
      },
    },
    {
      name: "workboard_create",
      label: "Workboard Create",
      description:
        "Create a Workboard card, optionally with parent dependencies, tenant, skills, workspace, and key to prevent duplicate requests. Labels come from the board's palette of at most 10 classifications (workboard_boards lists it; the result returns it): reuse a listed name, a new name takes a free slot, and on a full board pass replaces to overwrite one. The parallelizable label is exempt. Set dispatchMode external when a controller outside this Gateway owns the card's placement; the local dispatcher then never claims or starts it. Sessions boards do not hold cards; use workboard_sessions_board_read/update/move for them.",
      parameters: toolSchemas.create,
      execute: async (_toolCallId, rawParams) => {
        const record = withWorkboardOperatorAsk(
          withDecisionOptions(rawParams as Record<string, unknown>),
        );
        normalizeCappedStringList(record.parents, "parents");
        const reported: { change?: WorkboardClassificationChange } = {};
        const card = await store.create(
          record,
          { ownerId, token: record.token as string | undefined },
          undefined,
          (change) => {
            reported.change = change;
          },
        );
        return jsonResult({
          card: redactClaimToken(card),
          ...(await classificationResult(store, card, reported.change)),
        });
      },
    },
    {
      name: "workboard_link",
      label: "Workboard Link",
      description:
        "Link a parent card to a child card so the child becomes ready only after parents are done.",
      parameters: toolSchemas.link,
      execute: async (_toolCallId, rawParams) => {
        const record = rawParams as Record<string, unknown>;
        const parentId = readStringParam(record, "parentId", { required: true });
        const childId = readStringParam(record, "childId", { required: true });
        const token = record.token as string | undefined;
        return jsonResult({
          card: redactClaimToken(await store.linkCards(parentId, childId, { ownerId, token })),
        });
      },
    },
    {
      name: "workboard_read",
      label: "Workboard Read",
      description:
        "Read one Workboard card and return bounded worker context with notes, attempts, comments, proof, links, and diagnostics.",
      parameters: strictObject({
        id: boundCardIdField(),
        token: claimTokenField(),
      }),
      execute: async (_toolCallId, rawParams) => {
        const { card, workerContext } = await store.readWithWorkerContext(
          await readCardId(rawParams),
        );
        return jsonResult({
          card: redactClaimToken(card),
          workerContext,
        });
      },
    },
    {
      name: "workboard_claim",
      label: "Workboard Claim",
      description:
        "Claim a Workboard card for this agent and move backlog/todo cards into running. Returns a claim token for heartbeats and release.",
      parameters: toolSchemas.claim,
      execute: async (_toolCallId, rawParams) => {
        const record = rawParams as Record<string, unknown>;
        const id = readStringParam(record, "id", { required: true });
        const claimed = await store.claim(id, {
          ownerId,
          ttlSeconds: record.ttlSeconds,
        });
        return jsonResult({ ...claimed, card: redactClaimToken(claimed.card) });
      },
    },
    {
      name: "workboard_heartbeat",
      label: "Workboard Heartbeat",
      description:
        "Refresh this agent's Workboard claim heartbeat. Use during long-running card work so diagnostics do not mark it stale.",
      parameters: toolSchemas.heartbeat,
      execute: scopedCardMutation((id, record, scope) =>
        store.heartbeat(id, { ...scope, note: record.note }),
      ),
    },
    {
      name: "workboard_release",
      label: "Workboard Release",
      description:
        "Release this agent's Workboard claim. Omitting status only clears the claim and preserves the current card status, including running. Pass status (e.g. todo, ready, or review) to pause or hand off work.",
      parameters: toolSchemas.release,
      execute: scopedCardMutation((id, record, scope) =>
        store.releaseClaim(id, { ...scope, status: record.status }),
      ),
    },
    {
      name: "workboard_comment",
      label: "Workboard Comment",
      description: "Append a compact comment to a Workboard card.",
      parameters: toolSchemas.comment,
      execute: scopedCardMutation((id, record, scope) =>
        store.addComment(id, { body: record.body }, scope),
      ),
    },
    {
      name: "workboard_proof",
      label: "Workboard Proof",
      description:
        "Attach proof or artifact metadata to a Workboard card after running tests, checks, or producing screenshots/logs. Returns proofId; pass it to workboard_complete when that call reports the terminal status for this proof.",
      parameters: toolSchemas.proof,
      execute: async (_toolCallId, rawParams) => {
        const { record, id, scope } = await readScopedCardToolParams(rawParams);
        const hasArtifact =
          (typeof record.artifactPath === "string" && record.artifactPath.trim() !== "") ||
          (typeof record.url === "string" && record.url.trim() !== "");
        const card = hasArtifact
          ? await store.addProofWithArtifact(
              id,
              record,
              {
                label: record.label,
                path: record.artifactPath,
                url: record.url,
              },
              scope,
            )
          : await store.addProof(id, record, scope);
        return redactedProofResult(card);
      },
    },
    {
      name: "workboard_complete",
      label: "Workboard Complete",
      description:
        "Complete a claimed Workboard card with a structured summary, proof, artifacts, and created-card manifest. Finished work moves to review until someone accepts it.",
      parameters: toolSchemas.complete,
      execute: claimedCardMutation((id, record, scope) => store.complete(id, record, scope)),
    },
    {
      name: "workboard_verify",
      label: "Workboard Verify",
      description:
        "Record your check of a Workboard card's result: what you checked and what you concluded. Evidence only; it never changes the card's status.",
      parameters: toolSchemas.verify,
      execute: scopedCardMutation((id, record, scope) => store.verify(id, record, scope)),
    },
    {
      name: "workboard_attachment_add",
      label: "Workboard Attachment Add",
      description:
        "Store a small Workboard attachment in plugin SQLite KV and link it to the card.",
      parameters: toolSchemas.attachment_add,
      execute: scopedCardMutation((id, record, scope) =>
        store.addAttachment(id, record, scope, params.context?.assertInputCommitAllowed),
      ),
    },
    {
      name: "workboard_attachment_read",
      label: "Workboard Attachment Read",
      description: "Read one Workboard attachment from plugin SQLite KV.",
      parameters: toolSchemas.attachment_read,
      execute: async (_toolCallId, rawParams) => {
        const id = readStringParam(rawParams as Record<string, unknown>, "id", {
          required: true,
        });
        const attachment = await store.getAttachment(id);
        if (!attachment) {
          throw new Error(`attachment not found: ${id}`);
        }
        return jsonResult(attachment);
      },
    },
    {
      name: "workboard_attachment_delete",
      label: "Workboard Attachment Delete",
      description: "Delete one Workboard attachment from plugin SQLite KV and the card index.",
      parameters: toolSchemas.attachment_delete,
      execute: scopedCardMutation((id, record, scope) => {
        const attachmentId = readStringParam(record, "attachmentId", { required: true });
        return store.deleteAttachment(id, attachmentId, scope);
      }),
    },
    {
      name: "workboard_block",
      label: "Workboard Block",
      description:
        "Block a claimed Workboard card with a durable reason and release the claim. When the operator must decide, pass decisionOptions so the card offers them as a numbered picker; when you only need an answer or wait on something external, pass ask and askKind instead.",
      parameters: toolSchemas.block,
      execute: claimedCardMutation((id, record, scope) =>
        store.block(id, withWorkboardOperatorAsk(withDecisionOptions(record)), scope),
      ),
    },
    {
      name: "workboard_unblock",
      label: "Workboard Unblock",
      description: "Move a blocked Workboard card back to todo after adding enough context.",
      parameters: CardIdSchema,
      execute: scopedCardMutation((id, _record, scope) => store.unblock(id, scope)),
    },
    {
      name: "workboard_move",
      label: "Workboard Move",
      description:
        "Move a Workboard card to another status. Claimed cards require matching claim scope.",
      parameters: toolSchemas.move,
      execute: scopedCardMutation((id, record, scope) =>
        store.move(id, record.status, undefined, scope),
      ),
    },
    {
      name: "workboard_set_parallelism",
      label: "Workboard Set Parallelism",
      description:
        "Opt an existing Workboard card in or out of parallel owner slots. parallelizable false also removes the parallelizable label; maxConcurrentPerOwner null clears the ceiling. Claimed cards require matching claim scope.",
      parameters: strictObject({
        id: cardIdField(),
        token: ScopedClaimTokenField,
        parallelizable: parallelizableField(),
        maxConcurrentPerOwner: maxConcurrentPerOwnerPatchField(),
      }),
      // store.update has no claim scope; readParams already checked it against
      // this card version, and expectedUpdatedAt keeps the label rewrite on it.
      execute: scopedCardMutation((id, record, scope, card) =>
        store.update(id, buildWorkboardParallelismPatch(card, record), {
          expectedUpdatedAt: card.updatedAt,
          agentId: scope.agentId,
          interaction: scope.interaction,
        }),
      ),
    },
    {
      name: "workboard_set_dispatch_mode",
      label: "Workboard Set Dispatch Mode",
      description:
        "Set who places and starts a Workboard card's worker. native (default): the local dispatcher claims and starts it. external: an external controller owns placement and transport, so the local dispatcher never claims or starts the card; the controller uses the normal claim/heartbeat/complete flow. Dependency promotion and claim cleanup still run for external cards. Complete, block, or reclaim owned work before changing its mode.",
      parameters: strictObject({
        id: cardIdField(),
        token: ScopedClaimTokenField,
        dispatchMode: Type.Union([Type.Literal("native"), Type.Literal("external")], {
          description: "Placement owner for this card.",
        }),
      }),
      execute: scopedCardMutation((id, record, scope, card) =>
        store.update(
          id,
          { dispatchMode: record.dispatchMode },
          {
            expectedUpdatedAt: card.updatedAt,
            agentId: scope.agentId,
            interaction: scope.interaction,
          },
        ),
      ),
    },
    {
      name: "workboard_update",
      label: "Workboard Update",
      description:
        "Set a Workboard card's priority, dispatch mode, decision options, or operator ask, or add/remove labels by name; other labels stay. Added labels follow the board's classification palette (at most 10, listed by workboard_boards and returned here); on a full board pass replaces to overwrite one. Use ask with askKind when the card waits on the operator for an answer (input) or on something external, and decisionOptions with the decision label for a multiple-choice call. Claimed cards require matching claim scope.",
      parameters: strictObject({
        id: boundCardIdField(),
        token: ScopedClaimTokenField,
        priority: Type.Optional(
          Type.Union(
            WORKBOARD_PRIORITIES.map((priority) => Type.Literal(priority)),
            { description: "New priority." },
          ),
        ),
        labelsAdd: Type.Optional(
          Type.Array(Type.String(), { description: "Labels to add when absent." }),
        ),
        labelsRemove: Type.Optional(
          Type.Array(Type.String(), { description: "Labels to remove, case-insensitive." }),
        ),
        replaces: ReplacesField,
        decisionOptions: decisionOptionsField(),
        dispatchMode: dispatchModeField(),
        ask: askField(),
        askKind: askKindField(),
      }),
      // Like workboard_set_parallelism: readParams checked claim scope on this
      // card version, and expectedUpdatedAt refuses a label list built on a stale read.
      execute: async (_toolCallId, rawParams) => {
        const { record, id, card, scope } = await readScopedCardToolParams(rawParams);
        const patch = {
          ...buildWorkboardCardUpdatePatch(
            card,
            withWorkboardOperatorAsk(withDecisionOptions(record)),
          ),
          ...(record.replaces === undefined ? {} : { replaces: record.replaces }),
        };
        const reported: { change?: WorkboardClassificationChange } = {};
        const updated =
          Object.keys(patch).length === 0
            ? card
            : await store.update(id, patch, {
                expectedUpdatedAt: card.updatedAt,
                agentId: scope.agentId,
                interaction: scope.interaction,
                onClassifications: (change) => {
                  reported.change = change;
                },
              });
        return jsonResult({
          card: redactClaimToken(updated),
          ...(await classificationResult(store, updated, reported.change)),
        });
      },
    },
    ...createWorkboardOrchestrationTools({
      store,
      ownerId,
      runId,
      voiceBoard,
      agentId: callerAgentId,
      interaction,
    }),
  ];
  for (const tool of tools) {
    const execute = tool.execute;
    tool.execute = (...args) => store.runOperation(() => execute(...args));
  }
  return tools;
}
