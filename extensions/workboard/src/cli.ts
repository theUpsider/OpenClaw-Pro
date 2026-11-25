import {
  WORKBOARD_STATUSES,
  type WorkboardCard,
  type WorkboardCardCursor,
} from "@openclaw/workboard-contract";
import type { Command } from "commander";
import { runWithLocalStateOwner } from "openclaw/plugin-sdk/cli-state-owner";
import {
  addGatewayClientOptions,
  callGatewayFromCli,
  parseTimeoutMsWithFallback,
  isImplicitLocalGatewayTargetFromCli,
} from "openclaw/plugin-sdk/gateway-runtime";
import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { terminalText } from "openclaw/plugin-sdk/terminal-safe-text";
import { resolveWorkboardCardByIdOrPrefix } from "./card-lookup.js";
import { buildWorkboardParallelismPatch, isWorkboardOwnerSlotCeiling } from "./card-parallelism.js";
import { redactClaimToken, redactDispatchResult } from "./card-redaction.js";
import { compareCards } from "./store-card-helpers.js";
import { buildWorkboardCardUpdatePatch } from "./card-update.js";
import { MAX_WORKBOARD_OWNER_SLOT_LIMIT } from "./store-constants.js";
import type { WorkboardStore } from "./store.js";

type JsonOptions = {
  json?: boolean;
};

type GatewayOptions = JsonOptions & {
  admin?: boolean;
  url?: string;
  token?: string;
  timeout?: string;
  port?: string;
  password?: string;
  expectFinal?: boolean;
  board?: string;
};

type DispatchOptions = GatewayOptions & {
  maxStarts?: number;
};

function invalidArgument(message: string): Error {
  return Object.assign(new Error(message), {
    name: "InvalidArgumentError",
    code: "commander.invalidArgument",
    exitCode: 1,
  });
}

function parseMaxStarts(value: string): number {
  const parsed = parseStrictPositiveInteger(value);
  if (parsed === undefined) {
    throw invalidArgument("--max-starts must be a positive integer.");
  }
  return parsed;
}

function parseParallelizable(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no"].includes(normalized)) {
    return false;
  }
  throw invalidArgument(
    "--parallelizable must be true/1/yes or false/0/no. Pass the card id before the flags.",
  );
}

/**
 * 1..16 sets the ceiling; `0` means clear and is sent as null by the action,
 * because commander replaces a null parser result with "".
 */
function parseOwnerSlotCeiling(value: string): number {
  const parsed = /^\d+$/.test(value.trim()) ? Number(value) : Number.NaN;
  if (parsed !== 0 && !isWorkboardOwnerSlotCeiling(parsed)) {
    throw invalidArgument(
      `--max-concurrent-per-owner must be an integer from 1 to ${MAX_WORKBOARD_OWNER_SLOT_LIMIT}, or 0 to clear it.`,
    );
  }
  return parsed;
}

/** `native` is the local dispatcher; `external` hands placement to another controller. */
function parseDispatchMode(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === "native" || normalized === "external") {
    return normalized;
  }
  throw invalidArgument("--dispatch-mode must be native or external.");
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function writeLine(value: string): void {
  process.stdout.write(`${value}\n`);
}

/** Comma-separated labels for the label-editing flags; trims and drops empties. */
function parseLabelItems(value: string): string[] {
  return value
    .split(",")
    .map((label) => label.trim())
    .filter(Boolean);
}

function formatCardLine(card: WorkboardCard): string {
  const boardId = card.metadata?.automation?.boardId ?? "default";
  const agent = card.agentId ? terminalText` ${card.agentId}` : "";
  const archived = card.metadata?.archivedAt ? " (archived)" : "";
  return terminalText`${card.id.slice(0, 8)}  ${card.status.padEnd(8)}  ${card.priority.padEnd(6)}  ${boardId}${agent}  ${card.title}${archived}`;
}

function writeCards(cards: WorkboardCard[], options: JsonOptions): void {
  if (options.json) {
    writeJson({ cards: cards.map(redactClaimToken) });
    return;
  }
  for (const card of cards) {
    writeLine(formatCardLine(card));
  }
}

function writeCard(card: WorkboardCard, options: JsonOptions): void {
  if (options.json) {
    writeJson({ card: redactClaimToken(card) });
  } else {
    writeLine(formatCardLine(card));
  }
}

export function registerWorkboardCli(params: {
  program: Command;
  withStore: <T>(action: (store: WorkboardStore) => Promise<T>) => Promise<T>;
}): void {
  const local = <T>(
    method: string,
    input: Record<string, unknown>,
    action: (store: WorkboardStore, assertCurrent: () => void) => Promise<T>,
    options?: Pick<
      Parameters<typeof runWithLocalStateOwner>[0],
      "scopes" | "timeoutMs" | "expectFinal"
    >,
  ) =>
    runWithLocalStateOwner<T>({
      method: `${method}.owner`,
      params: input,
      target: "Workboard",
      ...options,
      recoveryCommand: "openclaw workboard list --json",
      runLocal: ({ assertCurrent }) =>
        params.withStore(async (store) => {
          assertCurrent();
          return await action(store, assertCurrent);
        }),
    });
  const list = async (boardId?: string) => {
    const cards = new Map<string, WorkboardCard>();
    let after: WorkboardCardCursor | undefined;
    do {
      const page = await local<{ cards: WorkboardCard[]; nextCursor?: WorkboardCardCursor }>(
        "workboard.cards.list",
        { boardId, ...(after ? { after } : {}) },
        (store) => store.listCards(boardId, undefined, after),
      );
      for (const card of page.cards) {
        cards.set(card.id, card);
      }
      after = page.nextCursor;
    } while (after);
    return { cards: [...cards.values()].toSorted(compareCards) };
  };
  const workboard = params.program
    .command("workboard")
    .description("Manage Workboard cards and worker dispatch");

  workboard
    .command("list")
    .description("List Workboard cards")
    .option("--board <id>", "Board id")
    .addOption(
      workboard
        .createOption("--status <status>", "Filter by status")
        .choices([...WORKBOARD_STATUSES]),
    )
    .option("--include-archived", "Include archived cards (default false)")
    .option("--json", "Print JSON", false)
    .action(
      async (
        options: JsonOptions & {
          board?: string;
          status?: string;
          includeArchived?: boolean;
        },
      ) => {
        // Text output hides archived cards like /workboard list, while --json
        // keeps the shipped full-card contract for existing scripts.
        let cards = (await list(options.board)).cards;
        if (!options.json && options.includeArchived !== true) {
          cards = cards.filter((card) => !card.metadata?.archivedAt);
        }
        if (options.status) {
          cards = cards.filter((card) => card.status === options.status);
        }
        writeCards(cards, options);
      },
    );

  workboard
    .command("create")
    .argument("<title...>", "Card title")
    .description("Create a Workboard card")
    .option("--notes <text>", "Card notes")
    .option("--status <status>", "Initial status", "todo")
    .option("--priority <priority>", "Priority", "normal")
    .option("--agent <id>", "Assigned agent id")
    .option("--board <id>", "Board id")
    .option("--labels <items>", "Comma-separated labels")
    .option(
      "--replaces <name>",
      "Classification a new label overwrites when the board already has 10",
    )
    .option(
      "--parallelizable",
      "Run beside other cards of the same owner (needs --max-concurrent-per-owner)",
      false,
    )
    .option(
      "--max-concurrent-per-owner <count>",
      "Owner slot ceiling for parallelizable cards (default 1, max 16)",
    )
    .option(
      "--dispatch-mode <mode>",
      "Who places and starts this card: native (default, local dispatcher) or external",
      parseDispatchMode,
    )
    .option("--json", "Print JSON", false)
    .action(
      async (
        title: string[],
        options: JsonOptions & {
          notes?: string;
          status?: string;
          priority?: string;
          agent?: string;
          board?: string;
          labels?: string;
          replaces?: string;
          parallelizable?: boolean;
          maxConcurrentPerOwner?: string;
          dispatchMode?: string;
        },
      ) => {
        const maxConcurrentPerOwner = options.maxConcurrentPerOwner?.trim()
          ? Number(options.maxConcurrentPerOwner)
          : undefined;
        const labels = [options.labels, options.parallelizable === true ? "parallelizable" : ""]
          .filter(Boolean)
          .join(",");
        const input = {
          title: title.join(" "),
          notes: options.notes,
          status: options.status,
          priority: options.priority,
          agentId: options.agent,
          boardId: options.board,
          labels,
          ...(options.replaces ? { replaces: options.replaces } : {}),
          ...(options.dispatchMode ? { dispatchMode: options.dispatchMode } : {}),
          ...(maxConcurrentPerOwner !== undefined && Number.isFinite(maxConcurrentPerOwner)
            ? { maxConcurrentPerOwner }
            : {}),
        };
        const { card } = await local(
          "workboard.cards.create",
          input,
          async (store, assertCurrent) => ({
            card: await store.create(
              { ...input, workspaceAccess: { unrestricted: true } },
              undefined,
              assertCurrent,
            ),
          }),
        );
        writeCard(card, options);
      },
    );

  workboard
    .command("show")
    .argument("<id>", "Card id or prefix")
    .description("Show one Workboard card")
    .option("--json", "Print JSON", false)
    .action(async (id: string, options: JsonOptions) => {
      const cards = (await list()).cards;
      const { card, error } = resolveWorkboardCardByIdOrPrefix(cards, id);
      if (!card) {
        throw new Error(error);
      }
      writeCard(card, options);
      if (!options.json && card.notes) {
        writeLine(
          card.notes
            .split("\n")
            .map((line) => terminalText`${line}`)
            .join("\n"),
        );
      }
    });

  workboard
    .command("move")
    .argument("<id>", "Card id or prefix")
    .description("Move a Workboard card to another status")
    .requiredOption("--status <status>", "Target status")
    .option("--json", "Print JSON", false)
    .action(async (id: string, options: JsonOptions & { status: string }) => {
      if (!(WORKBOARD_STATUSES as readonly string[]).includes(options.status)) {
        throw new Error(`--status must be one of: ${WORKBOARD_STATUSES.join(", ")}.`);
      }
      const cards = (await list()).cards;
      const { card, error } = resolveWorkboardCardByIdOrPrefix(cards, id);
      if (!card) {
        throw new Error(error);
      }
      const input = { id: card.id, status: options.status, expectedUpdatedAt: card.updatedAt };
      const { card: updated } = await local(
        "workboard.cards.move",
        input,
        async (store, assertCurrent) => ({
          card: await store.move(card.id, options.status, undefined, undefined, {
            expectedUpdatedAt: card.updatedAt,
            assertOwnerCurrent: assertCurrent,
          }),
        }),
      );
      writeCard(updated, options);
    });

  workboard
    .command("update")
    .argument("<id>", "Card id or prefix")
    .description("Edit a card's labels by name, or set its dispatch mode or parallel owner slots")
    .option("--labels-add <items>", "Comma-separated labels to add when absent")
    .option("--labels-remove <items>", "Comma-separated labels to remove, case-insensitive")
    .option(
      "--replaces <name>",
      "Classification a new label overwrites when the board palette is full (10)",
    )
    .option(
      "--parallelizable [value]",
      "Run beside other cards of the same owner (true/false; off also removes the label)",
      parseParallelizable,
    )
    .option(
      "--max-concurrent-per-owner <count>",
      `Owner slot ceiling, 1-${MAX_WORKBOARD_OWNER_SLOT_LIMIT}; 0 clears it`,
      parseOwnerSlotCeiling,
    )
    .option(
      "--dispatch-mode <mode>",
      "Who places and starts the card: native (default, local dispatcher) or external",
      parseDispatchMode,
    )
    .option("--json", "Print JSON", false)
    .action(
      async (
        id: string,
        options: JsonOptions & {
          labelsAdd?: string;
          labelsRemove?: string;
          replaces?: string;
          parallelizable?: boolean;
          maxConcurrentPerOwner?: number;
          dispatchMode?: string;
        },
      ) => {
        const addingLabels = options.labelsAdd !== undefined;
        const editingLabels = addingLabels || options.labelsRemove !== undefined;
        const editingParallelism =
          options.parallelizable !== undefined || options.maxConcurrentPerOwner !== undefined;
        if (options.replaces !== undefined && !addingLabels) {
          throw new Error("--replaces only applies when --labels-add introduces a new label.");
        }
        if (!editingLabels && !editingParallelism && options.dispatchMode === undefined) {
          throw new Error(
            "Pass --labels-add, --labels-remove, --parallelizable, --max-concurrent-per-owner, or --dispatch-mode.",
          );
        }
        const cards = (await list()).cards;
        const { card, error } = resolveWorkboardCardByIdOrPrefix(cards, id);
        if (!card) {
          throw new Error(error);
        }
        // Label edits are computed against the card that was read; the store's
        // one palette gate serves both this command and the agent tool.
        const labelPatch = editingLabels
          ? buildWorkboardCardUpdatePatch(card, {
              labelsAdd:
                options.labelsAdd === undefined ? undefined : parseLabelItems(options.labelsAdd),
              labelsRemove:
                options.labelsRemove === undefined
                  ? undefined
                  : parseLabelItems(options.labelsRemove),
            })
          : {};
        const parallelPatch = editingParallelism
          ? buildWorkboardParallelismPatch(
              { labels: labelPatch.labels ?? card.labels },
              {
                parallelizable: options.parallelizable,
                maxConcurrentPerOwner:
                  options.maxConcurrentPerOwner === 0 ? null : options.maxConcurrentPerOwner,
              },
            )
          : {};
        const patch = {
          ...labelPatch,
          ...parallelPatch,
          ...(options.dispatchMode === undefined ? {} : { dispatchMode: options.dispatchMode }),
          ...(options.replaces === undefined ? {} : { replaces: options.replaces }),
        };
        const input = { id: card.id, patch, expectedUpdatedAt: card.updatedAt };
        // An empty patch (a removal that matched nothing) skips the write entirely,
        // like workboard_update: no spurious edit event for a no-op.
        if (Object.keys(patch).length === 0) {
          writeCard(card, options);
          return;
        }
        const { card: updated } = await local("workboard.cards.update", input, async (store) => ({
          card: await store.update(card.id, patch, { expectedUpdatedAt: card.updatedAt }),
        }));
        writeCard(updated, options);
      },
    );

  addGatewayClientOptions(
    workboard
      .command("dispatch")
      .description("Promote ready cards and start worker runs through the Gateway")
      .option("--board <id>", "Dispatch a single board")
      .option(
        "--max-starts <count>",
        "Maximum new worker runs to start in this pass (default 3)",
        parseMaxStarts,
      )
      .option("--admin", "Request full-host workspace access", false)
      .option("--json", "Print JSON", false),
  ).action(async (options: DispatchOptions) => {
    const method =
      options.maxStarts === undefined
        ? "workboard.cards.dispatch"
        : "workboard.cards.dispatchWithOptions";
    const input = {
      boardId: options.board,
      ...(options.maxStarts !== undefined ? { maxStarts: options.maxStarts } : {}),
    };
    const scopes: NonNullable<Parameters<typeof callGatewayFromCli>[3]>["scopes"] = options.admin
      ? ["operator.admin", "operator.write", "operator.read"]
      : ["operator.write", "operator.read"];
    const result = await (!options.token?.trim() &&
    !options.password?.trim() &&
    (await isImplicitLocalGatewayTargetFromCli(options))
      ? local(
          method,
          input,
          async (store, assertCurrent) => ({
            ...redactDispatchResult(
              await store.dispatch({ boardId: options.board, assertOwnerCurrent: assertCurrent }),
            ),
            gatewayUnavailable: true,
            started: [],
            startFailures: [],
            skipped: [],
          }),
          {
            scopes,
            timeoutMs: parseTimeoutMsWithFallback(options.timeout, 30_000, {
              invalidType: "error",
            }),
            expectFinal: options.expectFinal,
          },
        )
      : callGatewayFromCli(method, options, input, {
          mode: "cli",
          scopes,
        }));
    if (options.json) {
      writeJson(result);
    } else {
      const record = isRecord(result) ? result : {};
      if (record.gatewayUnavailable === true) {
        writeLine(
          `gateway unavailable; data dispatch only: promoted=${Array.isArray(record.promoted) ? record.promoted.length : 0} blocked=${Array.isArray(record.blocked) ? record.blocked.length : 0}`,
        );
        return;
      }
      const started = Array.isArray(record.started) ? record.started.length : 0;
      const failures = Array.isArray(record.startFailures) ? record.startFailures : [];
      writeLine(`dispatch complete: started=${started} failures=${failures.length}`);
      for (const failure of failures) {
        if (
          isRecord(failure) &&
          typeof failure.cardId === "string" &&
          typeof failure.error === "string"
        ) {
          writeLine(terminalText`${failure.cardId.slice(0, 8)}: ${failure.error}`);
        }
      }
    }
  });
}
