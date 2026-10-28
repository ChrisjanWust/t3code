import {
  scopeProjectRef,
  scopedThreadKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId, ProjectId, ScopedThreadRef } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { useShallow } from "zustand/react/shallow";

import { useClosedViewStore } from "../../closedViewStore";
import {
  composerDraftHasUserContent,
  DraftId,
  type DraftThreadEnvMode,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useThreadActions } from "../../hooks/useThreadActions";
import { discardComposerDraft } from "../../lib/discardComposerDraft";
import { readThreadShells, useQuietThreadShells } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { buildDraftThreadRouteParams, buildThreadRouteParams } from "../../threadRoutes";
import {
  resolveSidebarRowThreadId,
  resolveSidebarThreadStatus,
  useSnoozeWakeClock,
} from "../Sidebar.logic";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  buildWorktreeTabs,
  draftWorktreeKey,
  isBlankLastTab,
  resolveTabAfterClose,
  worktreeKey,
  type WorktreeTab,
  type WorktreeTabDraft,
} from "./threadTabs.logic";

/** Where the open route lives, and so where its tab strip's tabs and new tabs belong. */
export interface ThreadTabLocation {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly worktreePath: string | null;
  readonly branch: string | null;
  readonly envMode: DraftThreadEnvMode;
  readonly worktreeKey: string;
  /** Its new worktree has no path yet, so a new tab has nowhere to open. */
  readonly creatingWorktree: boolean;
  /** The open route's thread or draft; a subagent's route shows its ancestor's tab. */
  readonly routeThreadRef: ScopedThreadRef;
  readonly routeDraftId: DraftId | null;
}

export type ThreadTabItem = WorktreeTab<EnvironmentThreadShell>;

export function resolveThreadTabLocation(input: {
  readonly routeThreadRef: ScopedThreadRef;
  readonly routeDraftId: DraftId | null;
  readonly shell: EnvironmentThreadShell | null;
  readonly draft: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
    readonly worktreePath: string | null;
    readonly branch: string | null;
    readonly envMode: DraftThreadEnvMode;
  } | null;
}): ThreadTabLocation | null {
  const { routeThreadRef, routeDraftId } = input;
  if (input.routeDraftId !== null && input.draft !== null) {
    const draft = input.draft;
    return {
      environmentId: draft.environmentId,
      projectId: draft.projectId,
      worktreePath: draft.worktreePath,
      branch: draft.branch,
      envMode: draft.envMode,
      // A draft that will create its worktree has a strip of its own.
      worktreeKey: draftWorktreeKey(draft) ?? JSON.stringify(["draft", input.routeDraftId]),
      creatingWorktree: false,
      routeThreadRef,
      routeDraftId,
    };
  }
  const shell = input.shell;
  if (shell === null) return null;
  return {
    environmentId: shell.environmentId,
    projectId: shell.projectId,
    worktreePath: shell.worktreePath,
    branch: shell.branch,
    envMode: shell.worktreePath === null && !shell.creatingWorktree ? "local" : "worktree",
    worktreeKey: worktreeKey(shell),
    creatingWorktree: shell.worktreePath === null && shell.creatingWorktree === true,
    routeThreadRef,
    routeDraftId,
  };
}

type ComposerDraftState = ReturnType<typeof useComposerDraftStore.getState>;

const draftIdsWithContent = (drafts: ComposerDraftState["draftsByThreadKey"]) =>
  Object.keys(drafts).filter((draftId) => composerDraftHasUserContent(drafts[draftId]));

function readDraftTabs(
  sessions: ComposerDraftState["draftThreadsByThreadKey"],
  withContent: readonly string[],
): WorktreeTabDraft[] {
  return Object.entries(sessions).flatMap(([draftId, session]) =>
    session.promotedTo != null
      ? []
      : [
          {
            draftId,
            threadId: session.threadId,
            createdAt: session.createdAt,
            worktreeKey: draftWorktreeKey(session),
            hasContent: withContent.includes(draftId),
          },
        ],
  );
}

function routeTabKey(
  location: ThreadTabLocation,
  threads: ReadonlyArray<EnvironmentThreadShell>,
): string {
  if (location.routeDraftId !== null) return location.routeDraftId;
  const { environmentId, threadId } = location.routeThreadRef;
  return scopedThreadKey(
    scopeThreadRef(environmentId, resolveSidebarRowThreadId(threadId, environmentId, threads)),
  );
}

function buildTabs(
  location: ThreadTabLocation,
  threads: ReadonlyArray<EnvironmentThreadShell>,
  drafts: readonly WorktreeTabDraft[],
  now: string,
) {
  const routeKey = routeTabKey(location, threads);
  const tabs = buildWorktreeTabs({
    threads,
    drafts,
    worktreeKey: location.worktreeKey,
    routeKey,
    threadKey: (thread) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
    now,
  });
  return { tabs, routeKey };
}

/** The strip's tabs, kept current as threads and drafts change. */
export function useWorktreeTabs(location: ThreadTabLocation) {
  const threads = useQuietThreadShells();
  const sessions = useComposerDraftStore((store) => store.draftThreadsByThreadKey);
  // Typing replaces the composer drafts; the strip only cares which of them have content.
  const withContent = useComposerDraftStore(
    useShallow((store) => draftIdsWithContent(store.draftsByThreadKey)),
  );
  const now = new Date(useSnoozeWakeClock(threads)).toISOString();
  return buildTabs(location, threads, readDraftTabs(sessions, withContent), now);
}

function readTabs(location: ThreadTabLocation) {
  const drafts = useComposerDraftStore.getState();
  return buildTabs(
    location,
    readThreadShells(),
    readDraftTabs(drafts.draftThreadsByThreadKey, draftIdsWithContent(drafts.draftsByThreadKey)),
    new Date().toISOString(),
  );
}

const tabRef = (tab: ThreadTabItem): ScopedThreadRef | null =>
  tab.kind === "thread" ? scopeThreadRef(tab.thread.environmentId, tab.thread.id) : null;

/** New, close and switch for the open route's tabs, read at call time so shortcuts stay current. */
export function useThreadTabActions(location: ThreadTabLocation | null) {
  const router = useRouter();
  const handleNewThread = useNewThreadHandler();
  const { settleThread, pinThread } = useThreadActions();
  const interruptTurn = useOrchestrationCommand(threadEnvironment.interruptTurn, {
    reportFailure: false,
  });

  const openTab = (tab: ThreadTabItem) =>
    tab.kind === "thread"
      ? router.navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(tabRef(tab)!),
        })
      : router.navigate({
          to: "/draft/$draftId",
          params: buildDraftThreadRouteParams(DraftId.make(tab.draftId)),
        });

  const newTab = async (options: { replace?: boolean } = {}) => {
    if (location === null || location.creatingWorktree) return;
    await handleNewThread(scopeProjectRef(location.environmentId, location.projectId), {
      // The project's checkout follows its current branch, not a past thread's.
      branch: location.worktreePath === null ? null : location.branch,
      worktreePath: location.worktreePath,
      envMode: location.envMode,
      startFromOrigin: false,
      ...(options.replace ? { replace: true } : {}),
    });
  };

  const selectTab = (key: string) => {
    if (location === null) return;
    // A subagent's route marks its ancestor's tab active, and clicking that tab returns to it.
    if (key === (location.routeDraftId ?? scopedThreadKey(location.routeThreadRef))) return;
    const tab = readTabs(location).tabs.find((candidate) => candidate.key === key);
    if (tab) void openTab(tab);
  };

  const selectRelativeTab = (direction: "previous" | "next") => {
    if (location === null) return false;
    const { tabs, routeKey } = readTabs(location);
    if (tabs.length < 2) return false;
    const index = tabs.findIndex((tab) => tab.key === routeKey);
    const next = tabs.at((index + (direction === "next" ? 1 : -1)) % tabs.length);
    if (next) void openTab(next);
    return true;
  };

  const leaveTab = (tabs: readonly ThreadTabItem[], key: string) => {
    const nextKey = resolveTabAfterClose(
      tabs.map((tab) => tab.key),
      key,
    );
    const next = tabs.find((tab) => tab.key === nextKey);
    return next ? openTab(next) : newTab({ replace: true });
  };

  /** False when there is nothing to close, so a desktop close shortcut can close the window. */
  const closeTab = (requestedKey: string): boolean => {
    if (location === null) return false;
    const { tabs, routeKey } = readTabs(location);
    // The open route may be a subagent or draft, whose tab is its ancestor's or its own.
    const key = requestedKey === scopedThreadKey(location.routeThreadRef) ? routeKey : requestedKey;
    const tab = tabs.find((candidate) => candidate.key === key);
    if (!tab || isBlankLastTab(tabs)) return false;
    const isRoute = key === routeKey;
    if (tab.kind === "draft") {
      // A blank draft stays as the project's reusable one; a typed draft is discarded with undo.
      const discard = () => {
        if (tab.hasContent) discardComposerDraft(DraftId.make(tab.draftId));
      };
      // Discarding the open draft first would send its route away mid-navigation.
      if (isRoute) void leaveTab(tabs, key).then(discard);
      else discard();
      return true;
    }
    const thread = tab.thread;
    const ref = tabRef(tab)!;
    if (tab.closed) {
      if (isRoute) void leaveTab(tabs, key);
      return true;
    }
    const status = resolveSidebarThreadStatus(thread);
    if (status === "working" || status === "approval") {
      const toastId = toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: status === "working" ? "This tab is still running" : "This tab needs an answer",
          description:
            status === "working"
              ? "Stop it to close the tab."
              : "Answer its approval request to close the tab.",
          ...(status === "working"
            ? {
                actionProps: {
                  children: "Stop",
                  onClick: () => {
                    toastManager.close(toastId);
                    void interruptTurn({
                      environmentId: ref.environmentId,
                      input: { threadId: ref.threadId },
                    });
                  },
                },
              }
            : {}),
        }),
      );
      return true;
    }
    // Settling unpins, so a pinned worktree passes its pin to another open tab.
    const otherOpenThreads = tabs.flatMap((candidate) =>
      candidate.kind === "thread" && candidate.key !== key && !candidate.closed
        ? [candidate.thread]
        : [],
    );
    const heir =
      thread.pinnedAt != null && !otherOpenThreads.some((other) => other.pinnedAt != null)
        ? otherOpenThreads[0]
        : undefined;
    if (isRoute) void leaveTab(tabs, key);
    void (async () => {
      if (heir) {
        await pinThread(
          scopeThreadRef(heir.environmentId, heir.id),
          thread.pinOrderKey ? { orderKey: thread.pinOrderKey } : {},
        );
      }
      const result = await settleThread(ref);
      if (result._tag === "Success") {
        useClosedViewStore.getState().remember({ kind: "thread-tab", threadRef: ref });
        return;
      }
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to close tab",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    })();
    return true;
  };

  return { newTab, closeTab, selectTab, selectRelativeTab };
}
