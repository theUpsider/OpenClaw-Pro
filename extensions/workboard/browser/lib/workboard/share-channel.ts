import type { ChannelsStatusResult, ConversationListResult } from "@openclaw/gateway-protocol";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { formatUiError } from "../format-error.ts";

/** An artifact row's shareable part: its label and its web URL and/or host path. */
export type ShareableArtifact = { label: string; href?: string; reference?: string };

export type ShareAccount = { id: string; label: string };

export type ShareChannel = {
  id: string;
  label: string;
  accounts: ShareAccount[];
  defaultAccountId: string;
  /** More than one usable account: the operator picks one instead of the Gateway default. */
  needsAccountChoice: boolean;
};

export type ShareSuggestion = { value: string; label?: string };

/** The web URL when there is one, else the host path or non-web URL. */
function shareReference(row: ShareableArtifact): string {
  return row.href?.trim() || row.reference?.trim() || "";
}

/** Rows without a URL or path (plain attachments) have nothing to share. */
export function canShareArtifactRow(row: ShareableArtifact): boolean {
  return shareReference(row) !== "";
}

/**
 * Only the reference is shared, never the bytes: label on the first line, reference on the
 * second. A label that is the reference itself (the row's fallback) is sent once.
 */
export function buildShareMessage(row: ShareableArtifact): string {
  const label = row.label.trim();
  const reference = shareReference(row);
  return !label || label === reference ? reference : `${label}\n${reference}`;
}

/** Channels with at least one enabled, configured account, in the Gateway's order. */
export function shareableChannels(
  snapshot: ChannelsStatusResult | null | undefined,
): ShareChannel[] {
  if (!snapshot) {
    return [];
  }
  const channels: ShareChannel[] = [];
  for (const id of snapshot.channelOrder) {
    const accounts = (snapshot.channelAccounts[id] ?? [])
      .filter((account) => account.enabled !== false && account.configured !== false)
      .map((account) => ({
        id: account.accountId,
        label: account.name?.trim() || account.accountId,
      }));
    const first = accounts[0];
    if (!first) {
      continue;
    }
    const preferred = snapshot.channelDefaultAccountId[id];
    channels.push({
      id,
      label: snapshot.channelLabels[id] ?? id,
      accounts,
      defaultAccountId: (accounts.find((account) => account.id === preferred) ?? first).id,
      needsAccountChoice: accounts.length > 1,
    });
  }
  return channels;
}

export async function loadShareChannels(client: GatewayBrowserClient): Promise<ShareChannel[]> {
  const snapshot = await client.request<ChannelsStatusResult | null>("channels.status", {
    probe: false,
    timeoutMs: 8000,
  });
  return shareableChannels(snapshot);
}

/**
 * Recipient suggestions for the chosen channel. The directory is bounded and admin-only, so it is
 * a convenience, never routing truth: failures and missing access both yield no suggestions.
 */
export async function loadShareSuggestions(params: {
  client: GatewayBrowserClient;
  canAdmin: boolean;
  agentId: string | null | undefined;
  channel: string;
  accountId?: string;
}): Promise<ShareSuggestion[]> {
  const agentId = params.agentId?.trim();
  if (!params.canAdmin || !agentId || !params.channel) {
    return [];
  }
  try {
    const result = await params.client.request<ConversationListResult>("conversations.list", {
      agentId,
      channel: params.channel,
      limit: 100,
    });
    const seen = new Set<string>();
    const suggestions: ShareSuggestion[] = [];
    for (const entry of result.conversations) {
      if (
        entry.channel !== params.channel ||
        (params.accountId && entry.accountId !== params.accountId) ||
        seen.has(entry.target)
      ) {
        continue;
      }
      seen.add(entry.target);
      suggestions.push({ value: entry.target, ...(entry.label ? { label: entry.label } : {}) });
    }
    return suggestions;
  } catch {
    return [];
  }
}

export type ShareSendResult = { ok: true } | { ok: false; error: string };

/**
 * Exactly one text-only `send` per attempt. Each attempt gets its own idempotency key, so a
 * deliberate retry after a failure is a new delivery; the dialog blocks duplicate clicks.
 */
export async function sendArtifactShare(params: {
  client: GatewayBrowserClient;
  channel: string;
  accountId: string;
  to: string;
  message: string;
}): Promise<ShareSendResult> {
  try {
    await params.client.request("send", {
      channel: params.channel,
      accountId: params.accountId,
      to: params.to,
      message: params.message,
      idempotencyKey: crypto.randomUUID(),
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: formatUiError(error) };
  }
}
