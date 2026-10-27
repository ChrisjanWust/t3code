import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";

import type { SidebarThreadSummary } from "../../types";
import { resolveSidebarThreadStatus, type SidebarSection } from "../Sidebar.logic";

type WorktreeLocation = Pick<SidebarThreadSummary, "environmentId" | "projectId" | "worktreePath">;

type WorktreeThread = WorktreeLocation &
  Pick<
    SidebarThreadSummary,
    | "id"
    | "createdAt"
    | "archivedAt"
    | "lineage"
    | "settledOverride"
    | "settledAt"
    | "snoozedAt"
    | "snoozedUntil"
    | "hasPendingApprovals"
    | "hasPendingUserInput"
  >;

/** A null worktree path is the project's own checkout, which its local threads share. */
export function worktreeKey(location: WorktreeLocation): string {
  return JSON.stringify([location.environmentId, location.projectId, location.worktreePath]);
}

/** A draft that will create its worktree on send has no worktree yet. */
export function draftWorktreeKey(
  draft: WorktreeLocation & { readonly envMode: "local" | "worktree" },
): string | null {
  return draft.envMode === "worktree" && draft.worktreePath === null ? null : worktreeKey(draft);
}

function isWorktreeMember(thread: WorktreeThread): boolean {
  return thread.archivedAt === null && thread.lineage.relationshipToParent !== "subagent";
}

export function isOpenTab(thread: WorktreeThread, now: string): boolean {
  return (
    isWorktreeMember(thread) &&
    thread.settledOverride !== "settled" &&
    !effectiveSnoozed(thread, { now })
  );
}

/** New tabs and forks open at the end, so the strip never reorders under the user. */
export function resolveWorktreeTabs<T extends WorktreeThread>(
  threads: readonly T[],
  key: string,
  now: string,
): T[] {
  return threads
    .filter((thread) => worktreeKey(thread) === key && isOpenTab(thread, now))
    .toSorted(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
    );
}

export type WorktreeTab<T> =
  | { readonly kind: "thread"; readonly key: string; readonly thread: T; readonly closed: boolean }
  | {
      readonly kind: "draft";
      readonly key: string;
      readonly draftId: string;
      readonly threadId: string;
      readonly createdAt: string;
      readonly hasContent: boolean;
    };

export interface WorktreeTabDraft {
  readonly draftId: string;
  readonly threadId: string;
  readonly createdAt: string;
  readonly worktreeKey: string | null;
  readonly hasContent: boolean;
}

/**
 * The strip shows the worktree's open threads, plus the open route when it is closed or
 * snoozed, so viewing a thread from History never hides its tab. Drafts follow: the open
 * one, and others the user has typed into.
 */
export function buildWorktreeTabs<T extends WorktreeThread>(input: {
  readonly threads: readonly T[];
  readonly drafts: readonly WorktreeTabDraft[];
  readonly worktreeKey: string;
  readonly routeKey: string;
  readonly threadKey: (thread: T) => string;
  readonly now: string;
}): WorktreeTab<T>[] {
  const open = new Set(resolveWorktreeTabs(input.threads, input.worktreeKey, input.now));
  const threadTabs = input.threads
    .filter(
      (thread) =>
        open.has(thread) ||
        (input.threadKey(thread) === input.routeKey &&
          worktreeKey(thread) === input.worktreeKey &&
          isWorktreeMember(thread)),
    )
    .toSorted(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
    )
    .map((thread) => ({
      kind: "thread" as const,
      key: input.threadKey(thread),
      thread,
      closed: !open.has(thread),
    }));
  const threadIds = new Set(threadTabs.map((tab) => tab.thread.id as string));
  const draftTabs = input.drafts
    .filter(
      (draft) =>
        !threadIds.has(draft.threadId) &&
        (draft.draftId === input.routeKey ||
          (draft.worktreeKey === input.worktreeKey && draft.hasContent)),
    )
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt))
    .map((draft) => ({
      kind: "draft" as const,
      key: draft.draftId,
      draftId: draft.draftId,
      threadId: draft.threadId,
      createdAt: draft.createdAt,
      hasContent: draft.hasContent,
    }));
  return [...threadTabs, ...draftTabs];
}

/** A lone blank tab is what closing the last tab leaves, so closing it again has nothing to do. */
export function isBlankLastTab(tabs: readonly WorktreeTab<unknown>[]): boolean {
  const [only, ...rest] = tabs;
  return rest.length === 0 && only?.kind === "draft" && !only.hasContent;
}

export function resolveWorktreeMembers<T extends WorktreeThread>(
  threads: readonly T[],
  key: string,
): T[] {
  return threads.filter((thread) => worktreeKey(thread) === key && isWorktreeMember(thread));
}

const ROW_SECTION_PRIORITY = ["pinned", "active", "working", "snoozed", "settled"] as const;

/**
 * Each worktree keeps only its first thread across the sorted sections, so its row sits
 * where its most prominent thread would and the sidebar's ordering and drag rules apply
 * unchanged.
 */
export function collapseToWorktreeRows<T extends WorktreeLocation>(
  sections: Readonly<Record<SidebarSection, readonly T[]>>,
): Record<SidebarSection, T[]> {
  const seen = new Set<string>();
  const collapsed = {} as Record<SidebarSection, T[]>;
  for (const section of ROW_SECTION_PRIORITY) {
    collapsed[section] = sections[section].filter((thread) => {
      const key = worktreeKey(thread);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  return collapsed;
}

/**
 * A worktree settled as a whole shares one settledAt, so its newest settle names the
 * tabs to bring back. Tabs closed one by one earlier keep their own, older stamps.
 */
export function resolveWorktreeReopenSet<T extends WorktreeThread>(members: readonly T[]): T[] {
  const settled = members.filter(
    (thread) => thread.settledOverride === "settled" && thread.settledAt !== null,
  );
  const newest = Math.max(...settled.map((thread) => Date.parse(thread.settledAt!)));
  return settled.filter((thread) => Date.parse(thread.settledAt!) === newest);
}

/** Returning to a worktree opens the tab used there last. */
export function resolveWorktreeReturnTab<T extends WorktreeThread>(
  openTabs: readonly T[],
  lastVisitedAt: (thread: T) => string | undefined,
): T | null {
  let latest: T | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const thread of openTabs) {
    const visitedMs = Date.parse(lastVisitedAt(thread) ?? thread.createdAt);
    if (visitedMs > latestMs) {
      latest = thread;
      latestMs = visitedMs;
    }
  }
  return latest;
}

/** Closing the open tab moves right, then left, like a browser. */
export function resolveTabAfterClose(
  tabKeys: readonly string[],
  closingKey: string,
): string | null {
  const index = tabKeys.indexOf(closingKey);
  if (index === -1) return null;
  return tabKeys[index + 1] ?? tabKeys[index - 1] ?? null;
}

const STATUS_URGENCY = [
  "approval",
  "input",
  "request",
  "failed",
  "limited",
  "working",
  "waiting",
] as const;

/** The worktree row shows the open tab that most needs the user. */
export function resolveWorktreeStatusThread<
  T extends Parameters<typeof resolveSidebarThreadStatus>[0],
>(openThreads: readonly T[], isUnread: (thread: T) => boolean): T | null {
  let best: T | null = null;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const thread of openThreads) {
    const status = resolveSidebarThreadStatus(thread);
    const urgency = STATUS_URGENCY.indexOf(status as (typeof STATUS_URGENCY)[number]);
    const rank =
      urgency !== -1
        ? urgency
        : isUnread(thread)
          ? STATUS_URGENCY.length
          : STATUS_URGENCY.length + 1;
    if (rank < bestRank) {
      best = thread;
      bestRank = rank;
    }
  }
  return best;
}

export function worktreeLabel(
  thread: Pick<SidebarThreadSummary, "branch" | "worktreePath" | "title">,
): string {
  if (thread.branch) return thread.branch;
  if (thread.worktreePath === null) return thread.title;
  return thread.worktreePath.split(/[\\/]/).findLast((segment) => segment.length > 0) ?? "Worktree";
}
