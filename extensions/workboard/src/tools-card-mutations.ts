import { WORKBOARD_DECISION_OPTION_LIMITS, type WorkboardCard } from "@openclaw/workboard-contract";
import { jsonResult, readStringParam } from "openclaw/plugin-sdk/core";
import { safeEqualSecret } from "openclaw/plugin-sdk/security-runtime";
import { asRecord, readStringValue } from "openclaw/plugin-sdk/string-coerce-runtime";
import { Type, type TProperties } from "typebox";
import { redactClaimToken } from "./card-redaction.js";
import {
  DEFAULT_WORKBOARD_OWNER_SLOT_LIMIT,
  MAX_WORKBOARD_OWNER_SLOT_LIMIT,
} from "./store-constants.js";
import type { WorkboardMutationScope } from "./store-inputs.js";
import { normalizeDecisionOptions } from "./store-normalizers.js";
import type { WorkboardStore } from "./store.js";
import { resolveBoundCardId, type VoiceBoardBinding } from "./voice-board-binding.js";
import {
  normalizeWorkboardAsk,
  normalizeWorkboardAskKind,
  WORKBOARD_ASK_MAX_LENGTH,
  WORKBOARD_OPERATOR_ASK_KINDS,
} from "./workboard-operator-ask.js";

type WorkboardCardMutation = (
  id: string,
  record: Record<string, unknown>,
  scope: WorkboardMutationScope,
  card: WorkboardCard,
) => Promise<WorkboardCard>;

export function createWorkboardCardMutations(
  store: WorkboardStore,
  ownerId: string,
  voiceBoard?: VoiceBoardBinding,
  agentId?: string,
  interaction?: Omit<NonNullable<WorkboardMutationScope["interaction"]>, "at">,
) {
  // An explicit id always wins. Without one, only a bound card that still lives
  // on the bound board fills it; anything else keeps the plain "id required" error.
  const readCard = async (record: Record<string, unknown>) => {
    const explicitId = readStringParam(record, "id");
    const bound =
      !explicitId && voiceBoard?.cardId ? await store.get(voiceBoard.cardId) : undefined;
    const id =
      explicitId ??
      resolveBoundCardId(voiceBoard, bound ? [bound] : []) ??
      readStringParam(record, "id", { required: true });
    const card = bound?.id === id ? bound : await store.get(id);
    if (!card) {
      throw new Error(`card not found: ${id}`);
    }
    return { id, card };
  };
  const readParams = async (rawParams: unknown, requireClaim = false) => {
    const record = asRecord(rawParams);
    const { id, card } = await readCard(record);
    const token = readStringValue(record.token);
    const claim = card.metadata?.claim;
    if (claim && claim.ownerId !== ownerId && !safeEqualSecret(token, claim.token)) {
      throw new Error(`card is claimed by ${claim.ownerId ?? "another agent"}.`);
    }
    if (requireClaim && !claim) {
      throw new Error("card must be claimed before lifecycle completion.");
    }
    // agentId only attributes the event; the claim check above uses ownerId and token.
    // The interaction stamp is server-resolved too (never a tool argument) and only
    // set on a card-bound turn; it is reference data the store merges into metadata.
    return {
      record,
      id,
      scope: {
        ownerId,
        token,
        ...(agentId ? { agentId } : {}),
        ...(interaction ? { interaction: { ...interaction, at: Date.now() } } : {}),
      },
      card,
    };
  };
  const cardMutation =
    (mutate: WorkboardCardMutation, requireClaim = false) =>
    async (_toolCallId: string, rawParams: unknown) => {
      const { record, id, scope, card } = await readParams(rawParams, requireClaim);
      // Nest cards so their status cannot be mistaken for the tool result's status.
      return jsonResult({ card: redactClaimToken(await mutate(id, record, scope, card)) });
    };
  return {
    readCardId: async (rawParams: unknown) => {
      const record = asRecord(rawParams);
      return readStringParam(record, "id") ?? (await readCard(record)).id;
    },
    readScopedCardToolParams: (rawParams: unknown) => readParams(rawParams),
    scopedCardMutation: cardMutation,
    claimedCardMutation: (mutate: WorkboardCardMutation) => cardMutation(mutate, true),
  };
}

export function cardIdField() {
  return Type.String({ description: "Workboard card id." });
}

/** Card id a turn from a card detail view may omit; the bound card then fills it. */
export function boundCardIdField() {
  return Type.Optional(
    Type.String({
      description:
        "Workboard card id. Omit only on a voice turn bound to one card (voiceBoard.cardId) to act on that card.",
    }),
  );
}

export function claimTokenField(description = "Claim token returned by workboard_claim.") {
  return Type.Optional(Type.String({ description }));
}

/**
 * Opt-in marker for parallel dispatch. The label alone is not enough: the owner
 * ceiling stays at 1 until `maxConcurrentPerOwner` raises it, so a card that only
 * carries this flag still waits for the single slot.
 */
export function parallelizableField() {
  return Type.Optional(
    Type.Boolean({
      description:
        "Opt in to running alongside other cards of the same owner. Default off; raise maxConcurrentPerOwner too, or the owner still holds one slot.",
    }),
  );
}

/** Owner slot ceiling. Defaults to 1 and is capped at MAX_WORKBOARD_OWNER_SLOT_LIMIT. */
export function maxConcurrentPerOwnerField() {
  return Type.Optional(
    Type.Integer({
      minimum: DEFAULT_WORKBOARD_OWNER_SLOT_LIMIT,
      maximum: MAX_WORKBOARD_OWNER_SLOT_LIMIT,
      description:
        "Active cards allowed for this owner when parallelizable is set. Default 1, maximum 16.",
    }),
  );
}

/**
 * Placement owner for a card. Omitted means `native`: the local dispatcher claims
 * and starts the worker itself. `external` hands placement and transport to a
 * controller outside this Gateway; the local dispatcher then never claims or
 * starts the card, while dependency promotion and the manual claim flow still work.
 */
export function dispatchModeField() {
  return Type.Optional(
    Type.Union([Type.Literal("native"), Type.Literal("external")], {
      description:
        "Who places and starts the card's worker. native (default): the local dispatcher claims and starts it. external: an external controller owns placement and transport; the local dispatcher never claims or starts it, and the controller uses the normal claim/heartbeat/complete flow.",
    }),
  );
}

/** Ceiling for an existing card; null clears the stored value back to the default of 1. */
export function maxConcurrentPerOwnerPatchField() {
  return Type.Optional(
    Type.Union(
      [
        Type.Integer({
          minimum: DEFAULT_WORKBOARD_OWNER_SLOT_LIMIT,
          maximum: MAX_WORKBOARD_OWNER_SLOT_LIMIT,
        }),
        Type.Null(),
      ],
      {
        description:
          "Active cards allowed for this owner when parallelizable is set, 1 to 16. null clears it back to the default of 1.",
      },
    ),
  );
}

export function strictObject<const Properties extends TProperties>(properties: Properties) {
  return Type.Object(properties, { additionalProperties: false });
}

export function workspaceField() {
  return Type.Optional(
    strictObject({
      kind: Type.String({ description: "scratch, dir, or worktree." }),
      path: Type.Optional(Type.String({ description: "Absolute dir/worktree path." })),
      branch: Type.Optional(
        Type.String({
          description:
            "Optional worktree source base ref. Re-dispatch reuses a retained checkout; use a new card for a different base ref.",
        }),
      ),
    }),
  );
}

/** Numbered picker choices for a decision card; `[]` clears them on an existing card. */
export function decisionOptionsField() {
  const { min, max, labelMax, descriptionMax } = WORKBOARD_DECISION_OPTION_LIMITS;
  return Type.Optional(
    Type.Array(
      strictObject({
        label: Type.String({ minLength: 1, maxLength: labelMax, description: "Choice text." }),
        description: Type.Optional(
          Type.String({ maxLength: descriptionMax, description: "One line on what it means." }),
        ),
        recommended: Type.Optional(Type.Boolean({ description: "Your recommended choice." })),
      }),
      {
        maxItems: max,
        description: `Choices the operator sees as a numbered picker on a blocked decision card (${min} to ${max}, or [] to clear); put the recommended choice where you want it (the list order is the number), and mark at most one recommended. The operator can always type a custom answer.`,
      },
    ),
  );
}

/**
 * Tool params carry agent input, so an option the store would drop is an error the
 * agent can fix rather than a silently shorter picker.
 */
export function withDecisionOptions<T extends Record<string, unknown>>(record: T): T {
  if (record.decisionOptions === undefined) {
    return record;
  }
  return {
    ...record,
    decisionOptions: normalizeDecisionOptions(record.decisionOptions, { strict: true }) ?? [],
  };
}

/**
 * Refuses bad `ask` text and an unknown blocker kind at the tool boundary, before the
 * store write, so the agent sees the rule instead of a silently dropped field. An empty
 * string stays the explicit clear marker the store normalizer turns into an absent
 * field; a field the caller never passed stays untouched. The same two rules live in
 * `normalizeAutomation`, which every write path reaches.
 */
export function withWorkboardOperatorAsk<T extends Record<string, unknown>>(record: T): T {
  const next: Record<string, unknown> = { ...record };
  if (record.ask !== undefined && record.ask !== "") {
    next.ask = normalizeWorkboardAsk(record.ask);
  }
  if (record.askKind !== undefined && record.askKind !== "") {
    next.askKind = normalizeWorkboardAskKind(record.askKind);
  }
  return next as T;
}

/**
 * One line naming what the operator must supply before the card can move on. `""`
 * clears it. The schema refuses an over-long or multi-line value the same way the
 * store rule does, so the agent sees the limit instead of a truncated string.
 */
export function askField() {
  return Type.Optional(
    Type.String({
      maxLength: WORKBOARD_ASK_MAX_LENGTH,
      pattern: "^[^\\r\\n]*$",
      description: `What you need from the operator, one line of at most ${WORKBOARD_ASK_MAX_LENGTH} characters. Pass "" to clear it.`,
    }),
  );
}

/**
 * Why the card waits on the operator. `input` asks for an answer; `external` waits on
 * something outside the board. A multiple-choice decision stays the `decision` label.
 */
export function askKindField() {
  return Type.Optional(
    Type.Union(
      WORKBOARD_OPERATOR_ASK_KINDS.map((kind) => Type.Literal(kind)),
      {
        description:
          "Why you are handing the card to the operator: input (you need an answer) or external (you wait on something outside the board). For a multiple-choice decision use the decision label and decisionOptions instead.",
      },
    ),
  );
}
