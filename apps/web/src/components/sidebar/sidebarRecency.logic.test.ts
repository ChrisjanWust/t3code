import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { worktreeKey } from "../threadTabs/threadTabs.logic";
import {
  filterRecentSidebarRows,
  sidebarRecencyCutoffMs,
  threadRecencyMs,
} from "./sidebarRecency.logic";

const NOW = Date.parse("2026-11-12T12:00:00.000Z");
const hoursAgo = (hours: number) => new Date(NOW - hours * 60 * 60 * 1000).toISOString();

function thread(
  id: string,
  overrides: Partial<EnvironmentThreadShell> = {},
): EnvironmentThreadShell {
  return {
    environmentId: "env-1",
    projectId: "project-1",
    id,
    worktreePath: `/repo/.t3/worktrees/${id}`,
    createdAt: hoursAgo(100),
    latestUserMessageAt: null,
    latestRun: null,
    unsettledAt: null,
    settledAt: null,
    snoozedAt: null,
    snoozedUntil: null,
    ...overrides,
  } as unknown as EnvironmentThreadShell;
}

const run = (fields: { requestedAt?: string; startedAt?: string; completedAt?: string }) =>
  ({ requestedAt: null, startedAt: null, completedAt: null, ...fields }) as never;

describe("threadRecencyMs", () => {
  it.each([
    ["creation", {}, 100],
    ["a user message", { latestUserMessageAt: hoursAgo(5) }, 5],
    [
      "a finished run",
      { latestRun: run({ requestedAt: hoursAgo(9), completedAt: hoursAgo(3) }) },
      3,
    ],
    ["a settle", { settledAt: hoursAgo(2) }, 2],
    ["a reopen", { unsettledAt: hoursAgo(4) }, 4],
    ["a snooze", { snoozedAt: hoursAgo(6), snoozedUntil: hoursAgo(-6) }, 6],
    ["a snooze that woke", { snoozedAt: hoursAgo(50), snoozedUntil: hoursAgo(1) }, 1],
  ] as const)("dates a thread by %s", (_, overrides, expectedHoursAgo) => {
    expect(threadRecencyMs(thread("t", overrides), NOW)).toBe(
      Date.parse(hoursAgo(expectedHoursAgo)),
    );
  });
});

describe("filterRecentSidebarRows", () => {
  const cutoffMs = sidebarRecencyCutoffMs("6h", NOW);
  const empty = { pinned: [], active: [], working: [], snoozed: [], settled: [] };
  const ids = (sections: Record<string, readonly EnvironmentThreadShell[]>) =>
    Object.fromEntries(
      Object.entries(sections).map(([key, rows]) => [key, rows.map((row) => row.id)]),
    );

  it("keeps a worktree row while any of its threads is recent, and the open route's row", () => {
    const shared = "/repo/.t3/worktrees/shared";
    const oldRow = thread("old-row", { worktreePath: shared });
    // Collapsed away under the old row, but its activity dates the worktree.
    const recentTab = thread("recent-tab", {
      worktreePath: shared,
      latestUserMessageAt: hoursAgo(1),
    });
    const stale = thread("stale");
    const routeRow = thread("route-row");
    const recentSettled = thread("recent-settled", { settledAt: hoursAgo(2) });
    const rows = filterRecentSidebarRows({
      sections: { ...empty, pinned: [oldRow], active: [stale, routeRow], settled: [recentSettled] },
      threads: [oldRow, recentTab, stale, routeRow, recentSettled],
      rowKey: worktreeKey,
      keepRowKey: worktreeKey(routeRow),
      cutoffMs,
      nowMs: NOW,
    });
    expect(ids(rows)).toEqual({
      ...empty,
      pinned: ["old-row"],
      active: ["route-row"],
      settled: ["recent-settled"],
    });
  });

  it("dates a dropped row by its optimistic projection", () => {
    const original = thread("dropped", { settledAt: hoursAgo(80) });
    const projected = { ...original, unsettledAt: hoursAgo(0) };
    const rows = filterRecentSidebarRows({
      sections: { ...empty, active: [projected] },
      threads: [original],
      rowKey: (row) => row.id,
      keepRowKey: null,
      cutoffMs,
      nowMs: NOW,
    });
    expect(ids(rows)).toEqual({ ...empty, active: ["dropped"] });
  });
});
