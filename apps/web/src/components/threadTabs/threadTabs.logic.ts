import { arrayMove } from "@dnd-kit/sortable";
import {
  isListedThreadLineage,
  type ProjectWorktreeTitle,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import { threadCreatedAtMs } from "@t3tools/client-runtime/state/thread-sort";
import { resolveListedAncestorThreadRef } from "@t3tools/client-runtime/state/threads";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../../i18n/messages";
import type { SidebarThreadSummary } from "../../types";
import {
  hasUnseenCompletion,
  resolveSidebarRowStatus,
  type SidebarSection,
} from "../Sidebar.logic";

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

/**
 * The tab that stands for `ref`: a subagent's or side chat's listed parent. A task a linked
 * environment delegated here keeps its own tab, since its parent's tabs are on that machine.
 */
export function tabThreadKey(
  ref: ScopedThreadRef,
  threads: Parameters<typeof resolveListedAncestorThreadRef>[1],
): string {
  const local = threads.filter((thread) => thread.environmentId === ref.environmentId);
  return scopedThreadKey(resolveListedAncestorThreadRef(ref, local));
}

type StatusThread = Parameters<typeof resolveSidebarRowStatus>[0] & {
  readonly lastVisitedAt?: string | null | undefined;
};

export type TabStatusTone = "attention" | "failed" | "working" | "unseen";

/** What a tab's or subagent row's status dot shows, or null when it shows nothing. */
export function threadTabStatusTone(thread: StatusThread): TabStatusTone | null {
  switch (resolveSidebarRowStatus(thread)) {
    case "approval":
    case "input":
    case "request":
    case "limited":
      return "attention";
    case "failed":
      return "failed";
    case "preparing":
    case "working":
    case "waiting":
      return "working";
    case "ready":
      return hasUnseenCompletion({ ...thread, lastVisitedAt: thread.lastVisitedAt ?? undefined })
        ? "unseen"
        : null;
  }
}

type SubagentThread = Pick<
  SidebarThreadSummary,
  "id" | "environmentId" | "lineage" | "archivedAt" | "createdAt"
>;

/** How many subagents a tab lists before the rest wait behind "Show more". */
const SUBAGENT_LIST_LIMIT = 5;

/**
 * The subagents listed under a tab: its thread's own, newest first. Side chats open beside
 * their parent instead. Only the open tab's thread has its whole family loaded, so only it lists.
 */
export function resolveTabSubagents<T extends SubagentThread>(
  threads: readonly T[],
  tabRef: ScopedThreadRef,
): readonly T[] {
  return threads
    .filter(
      (thread) =>
        thread.environmentId === tabRef.environmentId &&
        thread.archivedAt === null &&
        thread.lineage.parentThreadId === tabRef.threadId &&
        thread.lineage.relationshipToParent === "subagent" &&
        thread.lineage.sideChat !== true,
    )
    .toSorted(
      (left, right) =>
        right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
    );
}

/**
 * The newest few subagents, plus any waiting on the user and the one the route is in, so the
 * list still shows what needs an answer and where you are.
 */
export function newestTabSubagents<T extends StatusThread & Pick<SidebarThreadSummary, "id">>(
  subagents: readonly T[],
  routeSubagentId: ThreadId | null,
): readonly T[] {
  return subagents.filter(
    (thread, index) =>
      index < SUBAGENT_LIST_LIMIT ||
      thread.id === routeSubagentId ||
      threadTabStatusTone(thread) === "attention",
  );
}

/** The tab's subagent that `routeRef` is, or that a nested subagent on the route descends from. */
export function resolveRouteSubagentId(
  routeRef: ScopedThreadRef,
  tabRef: ScopedThreadRef,
  threads: readonly Pick<SidebarThreadSummary, "id" | "environmentId" | "lineage">[],
): ThreadId | null {
  if (routeRef.environmentId !== tabRef.environmentId) return null;
  const visited = new Set<ThreadId>();
  let current = routeRef.threadId;
  while (!visited.has(current)) {
    visited.add(current);
    const parentId =
      threads.find(
        (thread) => thread.environmentId === routeRef.environmentId && thread.id === current,
      )?.lineage.parentThreadId ?? null;
    if (parentId === null) return null;
    if (parentId === tabRef.threadId) return current;
    current = parentId;
  }
  return null;
}

/** Where "up" goes from a subagent or side chat: the thread that started it. */
export function subagentParentRef(
  thread: Pick<SidebarThreadSummary, "environmentId" | "lineage">,
): ScopedThreadRef | null {
  const parentId = thread.lineage.parentThreadId;
  return isListedThreadLineage(thread.lineage) || parentId === null
    ? null
    : scopeThreadRef(thread.environmentId, parentId);
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

/** The strip's order with a thread not yet created, such as a fork, right after `afterKey`'s tab. */
export function insertTabAfter(
  tabs: readonly WorktreeTab<WorktreeThread>[],
  afterKey: string,
  threadId: string,
): string[] | null {
  const index = tabs.findIndex((tab) => tab.key === afterKey);
  if (index === -1) return null;
  return tabs.map(tabThreadId).toSpliced(index + 1, 0, threadId);
}

/**
 * The strip shows the worktree's open threads, plus the open route when it is closed or
 * snoozed, so viewing a thread from History never hides its tab. Drafts follow: the open
 * one, and others the user has typed into. Tabs placed by a drag or a fork come first, in
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
  // New tabs open at the end, so the strip never reorders under the user.
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

/** The side panel lists a settled tab in its Settled section, under the open ones. */
export function isSettledTab(tab: WorktreeTab<WorktreeThread>): boolean {
  return tab.kind === "thread" && tab.thread.settledOverride === "settled";
}

/**
 * The side panel lists the newest tab first, so a new tab opens at its top, and a settled tab
 * after them all, where its Settled section is. The saved order stays oldest first.
 */
export function tabsInLayoutOrder<T extends WorktreeTab<WorktreeThread>>(
  tabs: readonly T[],
  sidePanel: boolean,
): readonly T[] {
  if (!sidePanel) return tabs;
  const newestFirst = tabs.toReversed();
  return [...newestFirst.filter((tab) => !isSettledTab(tab)), ...newestFirst.filter(isSettledTab)];
}

export function resolveWorktreeMembers<T extends WorktreeThread>(
  threads: readonly T[],
  key: string,
): T[] {
  return threads.filter((thread) => worktreeKey(thread) === key && isWorktreeMember(thread));
}

/** The worktree's settled threads, the last settled first. */
export function resolveSettledTabThreads<T extends WorktreeThread>(
  threads: readonly T[],
  key: string,
): T[] {
  return resolveWorktreeMembers(threads, key)
    .filter((thread) => thread.settledOverride === "settled")
    .toSorted(
      (left, right) =>
        (right.settledAt ?? "").localeCompare(left.settledAt ?? "") ||
        right.createdAt.localeCompare(left.createdAt) ||
        right.id.localeCompare(left.id),
    );
}

/**
 * The settled tabs the Settled section lists: the newest `count` while it is expanded, and
 * the one the route shows either way, so viewing a settled thread never hides its tab.
 */
export function listedSettledTabs<T>(
  settled: readonly T[],
  input: {
    readonly expanded: boolean;
    readonly count: number;
    readonly isRoute: (thread: T) => boolean;
  },
): readonly T[] {
  return settled.filter(
    (thread, index) => (input.expanded && index < input.count) || input.isRoute(thread),
  );
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
  T extends Parameters<typeof resolveSidebarRowStatus>[0],
>(openThreads: readonly T[], isUnread: (thread: T) => boolean): T | null {
  let best: T | null = null;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const thread of openThreads) {
    const status = resolveSidebarRowStatus(thread);
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

type WorktreeLabelThread = WorktreeThread & Pick<SidebarThreadSummary, "branch" | "title">;

/**
 * The worktree's own title. Until one exists, its first open thread names it, as worktrees
 * agents launch never get a generated title. A settled worktree keeps the name it had, from
 * the tabs settled with it. The project checkout is named by its branch.
 */
export function worktreeLabel(
  thread: WorktreeLabelThread,
  worktreeTitles?: ReadonlyArray<ProjectWorktreeTitle>,
  members: readonly WorktreeLabelThread[] = [thread],
  resolve: MessageResolver = m,
): string {
  const titled = findWorktreeTitle(worktreeTitles, thread.worktreePath);
  const title = titled?.manual ?? titled?.generated;
  if (title) return title;
  if (thread.worktreePath === null) {
    if (thread.branch) return thread.branch;
    return thread.creatingWorktree ? resolve(msg("New worktree")) : thread.title;
  }
  const open = members.filter((member) => member.settledOverride !== "settled");
  const named = open.length > 0 ? open : resolveWorktreeReopenSet(members);
  const candidates = named.length > 0 ? named : members;
  // Threads launched together share a timestamp; the id keeps the label from flipping.
  return candidates.reduce((first, member) =>
    (threadCreatedAtMs(member) - threadCreatedAtMs(first) || member.id.localeCompare(first.id)) < 0
      ? member
      : first,
  ).title;
}
