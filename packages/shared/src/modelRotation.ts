import {
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageWindow,
  type ServerSettings,
  isProviderAvailable,
  resolveProjectProviderInstanceEnabled,
} from "@t3tools/contracts";

import { elapsedShare } from "./usageLimits.ts";

// Room left in a weekly or longer limit is lost at its reset, so near the end it goes first.
const EXPIRING_ELAPSED_SHARE = 0.95;
const EXPIRING_MIN_REMAINING_PERCENT = 10;
// Claude scopes a per-model weekly limit by id (see `windowLimitsModel` on the server), not `modelIds`.
const SCOPED_WINDOW_PREFIX = "seven_day_";

function windowAppliesToModel(window: ServerProviderUsageWindow, model: string): boolean {
  return (
    (window.modelIds === undefined || window.modelIds.includes(model)) &&
    (window.providerIds === undefined || window.providerIds.includes(model.split("/")[0] ?? "")) &&
    (!window.id.startsWith(SCOPED_WINDOW_PREFIX) ||
      model
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .includes(window.id.slice(SCOPED_WINDOW_PREFIX.length)))
  );
}

function usageStanding(provider: ServerProvider, model: string, now: number) {
  const windows =
    !provider.usageLimits || provider.usageLimits.unavailable
      ? []
      : provider.usageLimits.windows.filter(
          (window) =>
            windowAppliesToModel(window, model) &&
            !(window.resetsAt && Date.parse(window.resetsAt) <= now),
        );
  const remaining =
    windows.length === 0 ? null : 100 - Math.max(...windows.map((window) => window.usedPercent));
  const expiringResets = windows.flatMap((window) =>
    (window.kind === "weekly" || window.kind === "monthly") &&
    (elapsedShare(window, now) ?? 0) >= EXPIRING_ELAPSED_SHARE
      ? [Date.parse(window.resetsAt ?? "")]
      : [],
  );
  return {
    remaining,
    expiresAt:
      remaining !== null && remaining >= EXPIRING_MIN_REMAINING_PERCENT && expiringResets.length > 0
        ? Math.min(...expiringResets)
        : null,
  };
}

/**
 * A worktree keeps its instance; otherwise a weekly limit about to reset with room goes first, then
 * the most room under the tightest limit, the default's instance on ties. With no usable instance
 * the selection is unchanged, so the fallback model can take over.
 */
export function rotateDefaultModelSelection(input: {
  readonly selection: ModelSelection | null;
  readonly settings: ServerSettings;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly projectId: ProjectId | null;
  readonly worktreeInstanceId?: ProviderInstanceId | null;
  readonly now: number;
}): ModelSelection | null {
  const { selection } = input;
  const rotation = input.settings.defaultModelRotation;
  if (!selection || !rotation.includes(selection.instanceId)) return selection;
  const driver = input.providers.find((entry) => entry.instanceId === selection.instanceId)?.driver;
  const candidates = [
    selection.instanceId,
    ...rotation.filter((id) => id !== selection.instanceId),
  ].flatMap((instanceId) => {
    const provider = input.providers.find((entry) => entry.instanceId === instanceId);
    if (
      !provider ||
      provider.driver !== driver ||
      !provider.enabled ||
      !provider.installed ||
      provider.auth.status === "unauthenticated" ||
      !isProviderAvailable(provider) ||
      !provider.models.some((model) => model.slug === selection.model) ||
      !resolveProjectProviderInstanceEnabled(input.settings, input.projectId, instanceId)
    )
      return [];
    const standing = usageStanding(provider, selection.model, input.now);
    return standing.remaining !== null && standing.remaining <= 0 ? [] : [{ provider, standing }];
  });
  let picked = candidates.find(
    ({ provider }) => provider.instanceId === input.worktreeInstanceId,
  )?.provider;
  if (!picked) {
    let soonest = Infinity;
    let best = -Infinity;
    let roomiest: ServerProvider | undefined;
    for (const { provider, standing } of candidates) {
      if (standing.expiresAt !== null && standing.expiresAt < soonest) {
        soonest = standing.expiresAt;
        picked = provider;
      }
      if ((standing.remaining ?? -1) > best) {
        best = standing.remaining ?? -1;
        roomiest = provider;
      }
    }
    picked ??= roomiest;
  }
  return picked && picked.instanceId !== selection.instanceId
    ? { ...selection, instanceId: picked.instanceId }
    : selection;
}

/** The instance a worktree's most recently updated thread runs on. */
export function worktreeProviderInstanceId(
  threads: Iterable<{
    readonly environmentId: EnvironmentId;
    readonly worktreePath: string | null;
    readonly providerInstanceId: ProviderInstanceId;
    readonly updatedAt: string;
  }>,
  target: { readonly environmentId: EnvironmentId; readonly worktreePath: string | null },
): ProviderInstanceId | null {
  if (target.worktreePath === null) return null;
  let latest: {
    readonly providerInstanceId: ProviderInstanceId;
    readonly updatedAt: string;
  } | null = null;
  for (const thread of threads) {
    if (
      thread.environmentId === target.environmentId &&
      thread.worktreePath === target.worktreePath &&
      (latest === null || thread.updatedAt > latest.updatedAt)
    )
      latest = thread;
  }
  return latest?.providerInstanceId ?? null;
}
