import type { WorkboardCard } from "@openclaw/workboard-contract";
import { buildWorkboardCardUpdatePatch } from "./card-update.js";
import { appendComment, assertCanMutateClaimedCard } from "./store-card-helpers.js";
import { WorkboardEnrichmentStore } from "./store-enrichment.js";
import type { WorkboardMutationScope, WorkboardPromoteInput } from "./store-inputs.js";
import { clearDiagnostics, normalizeBoundedString } from "./store-normalizers.js";

export class WorkboardPromoteStore extends WorkboardEnrichmentStore {
  async move(
    id: string,
    status: unknown,
    position: unknown,
    scope?: WorkboardMutationScope,
    options: {
      expectedUpdatedAt?: number;
      assertOwnerCurrent?: () => void;
      /** Labels dropped in the same write, e.g. `decision` once the operator decided. */
      labelsRemove?: unknown;
    } = {},
  ): Promise<WorkboardCard> {
    return await this.enqueueMutation(async () => {
      const result = await this.updateLatestCard(
        id,
        (current) => {
          // Checks run once on the latest read, and the write is pinned to that
          // read's updatedAt: a card claimed or settled in between throws a
          // conflict instead of being moved on stale authority. No retry.
          assertCanMutateClaimedCard(current, scope);
          return options.labelsRemove === undefined
            ? { status, position }
            : {
                ...buildWorkboardCardUpdatePatch(current, { labelsRemove: options.labelsRemove }),
                status,
                position,
              };
        },
        {
          actor: scope ?? null,
          allowMetadataDependencyLinks: false,
          enforceStatusHolds: true,
          expectedUpdatedAt: options.expectedUpdatedAt,
          agentId: scope?.agentId,
          interaction: scope?.interaction,
        },
      );
      return result.card;
    }, options.assertOwnerCurrent);
  }

  async promote(
    id: string,
    input: WorkboardPromoteInput = {},
    scope?: WorkboardMutationScope | null,
  ): Promise<WorkboardCard> {
    return await this.enqueueMutation(async () => {
      const reason = normalizeBoundedString(input.reason, undefined, 1000, "promote reason");
      const result = await this.updateLatestCard(
        id,
        (current) => {
          if (current.status !== "todo") {
            throw new Error(`Cannot promote Workboard card in ${current.status}; expected todo.`);
          }
          assertCanMutateClaimedCard(current, scope === null ? undefined : scope);
          return {
            status: "ready",
            metadata: {
              ...clearDiagnostics(current.metadata, ["stranded_ready", "blocked_too_long"]),
              comments: appendComment(current.metadata?.comments, reason),
              stale: null,
            },
          };
        },
        { actor: scope ?? null, enforceStatusHolds: input.force !== true },
      );
      return result.card;
    });
  }
}
