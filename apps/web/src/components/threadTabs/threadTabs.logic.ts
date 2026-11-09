import { arrayMove } from "@dnd-kit/sortable";
import { isListedThreadLineage, type ProjectWorktreeTitle } from "@t3tools/contracts";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import { threadCreatedAtMs } from "@t3tools/client-runtime/state/thread-sort";

import type { SidebarThreadSummary } from "../../types";
import { resolveSidebarThreadStatus, type SidebarSection } from "../Sidebar.logic";

type WorktreeLocation = Pick<SidebarThreadSummary, "environmentId" | "projectId" | "worktreePath"> &
  Partial<Pick<SidebarThreadSummary, "id" | "creatingWorktree">>;

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
  // A worktree still being created has no path yet; it must not join the project's checkout.
  if (location.worktreePath === null && location.creatingWorktree === true && location.id) {
    return JSON.stringify([location.environmentId, location.projectId, null, location.id]);
  }
  return JSON.stringify([location.environmentId, location.projectId, location.worktreePath]);
}

/** A draft that will create its worktree on send has no worktree yet. */
export function draftWorktreeKey(
  draft: WorktreeLocation & { readonly envMode: "local" | "worktree" },
): string | null {
  return draft.envMode === "worktree" && draft.worktreePath === null ? null : worktreeKey(draft);
}

function isWorktreeMember(thread: WorktreeThread): boolean {
  return thread.archivedAt === null && isListedThreadLineage(thread.lineage);
}

export function isOpenTab(thread: WorktreeThread, now: string): boolean {
  return (
    isWorktreeMember(thread) &&
    thread.settledOverride !== "settled" &&
    !effectiveSnoozed(thread, { now })
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

// A draft keeps its thread id once sent, so ordering by it holds the tab's place.
export const tabThreadId = (tab: WorktreeTab<WorktreeThread>): string =>
  tab.kind === "thread" ? tab.thread.id : tab.threadId;

/** The strip's order after dragging one tab onto another's place, or null if nothing moved. */
export function moveWorktreeTab(
  tabs: readonly WorktreeTab<WorktreeThread>[],
  fromKey: string,
  toKey: string,
): string[] | null {
  const from = tabs.findIndex((tab) => tab.key === fromKey);
  const to = tabs.findIndex((tab) => tab.key === toKey);
  if (from === -1 || to === -1 || from === to) return null;
  return arrayMove(tabs.map(tabThreadId), from, to);
}

/**
 * The strip shows the worktree's open threads, plus the open route when it is closed or
 * snoozed, so viewing a thread from History never hides its tab. Drafts follow: the open
 * one, and others the user has typed into. Tabs the user has dragged come first, in
 * `order`; any others stay at the end.
 */
export function buildWorktreeTabs<T extends WorktreeThread>(input: {
  readonly threads: readonly T[];
  readonly drafts: readonly WorktreeTabDraft[];
  readonly worktreeKey: string;
  readonly routeKey: string;
  readonly threadKey: (thread: T) => string;
  readonly now: string;
  readonly order?: readonly string[] | undefined;
}): WorktreeTab<T>[] {
  // New tabs and forks open at the end, so the strip never reorders under the user.
  const threadTabs = input.threads
    .filter((thread) => worktreeKey(thread) === input.worktreeKey && isWorktreeMember(thread))
    .flatMap((thread) => {
      const key = input.threadKey(thread);
      const open = isOpenTab(thread, input.now);
      return open || key === input.routeKey
        ? [{ kind: "thread" as const, key, thread, closed: !open }]
        : [];
    })
    .toSorted(
      (left, right) =>
        left.thread.createdAt.localeCompare(right.thread.createdAt) ||
        left.thread.id.localeCompare(right.thread.id),
    );
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
  const tabs: WorktreeTab<T>[] = [...threadTabs, ...draftTabs];
  const order = input.order;
  if (!order) return tabs;
  const positions = new Map(order.map((threadId, index) => [threadId, index]));
  const position = (tab: WorktreeTab<T>) => positions.get(tabThreadId(tab)) ?? order.length;
  return tabs.toSorted((left, right) => position(left) - position(right));
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
 * A worktree dates from its first open thread, so a new tab leaves its row in place. Settled
 * threads don't count: the server pages older ones, so they would move rows as pages load.
 */
export function worktreeCreatedAtMs<
  T extends WorktreeLocation & Pick<SidebarThreadSummary, "createdAt" | "settledOverride">,
>(threads: readonly T[]): (thread: T) => number {
  const earliest = new Map<string, number>();
  for (const thread of threads) {
    if (thread.settledOverride === "settled") continue;
    const key = worktreeKey(thread);
    const createdAt = threadCreatedAtMs(thread);
    if (createdAt < (earliest.get(key) ?? Number.POSITIVE_INFINITY)) {
      earliest.set(key, createdAt);
    }
  }
  return (thread) => earliest.get(worktreeKey(thread)) ?? threadCreatedAtMs(thread);
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
  "preparing",
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

export function findWorktreeTitle(
  worktreeTitles: ReadonlyArray<ProjectWorktreeTitle> | undefined,
  worktreePath: string | null,
): ProjectWorktreeTitle | undefined {
  return worktreePath === null
    ? undefined
    : worktreeTitles?.find((entry) => entry.worktreePath === worktreePath);
}

type WorktreeLabelThread = Pick<
  SidebarThreadSummary,
  "id" | "branch" | "worktreePath" | "title" | "creatingWorktree" | "createdAt" | "settledOverride"
>;

/**
 * The worktree's own title. Until one exists, its first open thread names it, as worktrees
 * agents launch never get a generated title. Settled threads count only when none are open,
 * as in `worktreeCreatedAtMs`. The project checkout is named by its branch.
 */
export function worktreeLabel<T extends WorktreeLabelThread>(
  thread: T,
  worktreeTitles?: ReadonlyArray<ProjectWorktreeTitle>,
  members: readonly T[] = [thread],
): string {
  const titled = findWorktreeTitle(worktreeTitles, thread.worktreePath);
  const title = titled?.manual ?? titled?.generated;
  if (title) return title;
  if (thread.worktreePath === null) {
    if (thread.branch) return thread.branch;
    return thread.creatingWorktree ? "New worktree" : thread.title;
  }
  const open = members.filter((member) => member.settledOverride !== "settled");
  const candidates = open.length > 0 ? open : members;
  // Threads launched together share a timestamp; the id keeps the label from flipping.
  return candidates.reduce((first, member) =>
    (threadCreatedAtMs(member) - threadCreatedAtMs(first) || member.id.localeCompare(first.id)) < 0
      ? member
      : first,
  ).title;
}
