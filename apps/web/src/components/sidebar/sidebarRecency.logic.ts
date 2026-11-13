import {
  threadRuntimeIsActive,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";

import type { SidebarSection } from "../Sidebar.logic";

export const SIDEBAR_RECENCY_WINDOWS = ["6h", "12h", "1d", "2d", "7d"] as const;
export type SidebarRecencyWindow = (typeof SIDEBAR_RECENCY_WINDOWS)[number];

const HOUR_MS = 60 * 60 * 1000;
const WINDOW_HOURS: Record<SidebarRecencyWindow, number> = {
  "6h": 6,
  "12h": 12,
  "1d": 24,
  "2d": 48,
  "7d": 168,
};

export const SIDEBAR_RECENCY_LABELS: Record<SidebarRecencyWindow, string> = {
  "6h": "6 hours",
  "12h": "12 hours",
  "1d": "24 hours",
  "2d": "2 days",
  "7d": "7 days",
};

export function sidebarRecencyCutoffMs(window: SidebarRecencyWindow, nowMs: number): number {
  return nowMs - WINDOW_HOURS[window] * HOUR_MS;
}

type RecencyThread = Pick<
  EnvironmentThreadShell,
  | "createdAt"
  | "latestUserMessageAt"
  | "latestRun"
  | "unsettledAt"
  | "settledAt"
  | "snoozedAt"
  | "snoozedUntil"
  | "lastSnoozeWakeAt"
  | "runtime"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "pendingSubagentRequest"
>;

/**
 * The thread's last activity: created, a message or run, or settled, snoozed, reopened or woken.
 * Settling counts, so a filtered Settled shelf is a prefix of its settle-time order. A thread
 * that is running or waiting on the user is active now.
 */
export function threadRecencyMs(thread: RecencyThread, nowMs: number): number {
  if (
    threadRuntimeIsActive(thread.runtime) ||
    thread.hasPendingApprovals ||
    thread.hasPendingUserInput ||
    thread.pendingSubagentRequest != null
  ) {
    return nowMs;
  }
  let latest = Number.NEGATIVE_INFINITY;
  for (const candidate of [
    thread.createdAt,
    thread.latestUserMessageAt,
    thread.latestRun?.requestedAt,
    thread.latestRun?.startedAt,
    thread.latestRun?.completedAt,
    thread.unsettledAt,
    thread.settledAt,
    thread.snoozedAt,
    thread.lastSnoozeWakeAt,
  ]) {
    const ms = candidate == null ? Number.NaN : Date.parse(candidate);
    if (ms > latest) latest = ms;
  }
  const wokeMs = thread.snoozedUntil == null ? Number.NaN : Date.parse(thread.snoozedUntil);
  return wokeMs <= nowMs && wokeMs > latest ? wokeMs : latest;
}

/**
 * Keeps the rows active since `cutoffMs`, and the open route's row. Rows sharing a `rowKey` are
 * dated together, so a worktree row stays while any of its threads is recent.
 */
export function filterRecentSidebarRows<T extends RecencyThread>(input: {
  readonly sections: Readonly<Record<SidebarSection, readonly T[]>>;
  /** Every thread a row can stand for, including ones the rows collapsed away. */
  readonly threads: readonly T[];
  readonly rowKey: (thread: T) => string;
  readonly keepRowKey: string | null;
  readonly cutoffMs: number;
  readonly nowMs: number;
}): Record<SidebarSection, T[]> {
  const { sections, rowKey, keepRowKey, cutoffMs, nowMs } = input;
  const latestByRow = new Map<string, number>();
  // Section rows can be optimistic projections, newer than the threads they stand for.
  for (const thread of [...input.threads, ...Object.values(sections).flat()]) {
    const key = rowKey(thread);
    const ms = threadRecencyMs(thread, nowMs);
    if (ms > (latestByRow.get(key) ?? Number.NEGATIVE_INFINITY)) latestByRow.set(key, ms);
  }
  const keep = (thread: T) => {
    const key = rowKey(thread);
    return key === keepRowKey || (latestByRow.get(key) ?? Number.NEGATIVE_INFINITY) >= cutoffMs;
  };
  return {
    pinned: sections.pinned.filter(keep),
    active: sections.active.filter(keep),
    working: sections.working.filter(keep),
    snoozed: sections.snoozed.filter(keep),
    settled: sections.settled.filter(keep),
  };
}
