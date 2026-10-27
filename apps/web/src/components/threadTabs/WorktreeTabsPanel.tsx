import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import { type ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { AlarmClockIcon, EyeIcon, XIcon } from "lucide-react";
import type { ReactNode } from "react";

import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { useThreadActions } from "../../hooks/useThreadActions";
import { cn } from "../../lib/utils";
import { useQuietThreadShell, useQuietThreadShells } from "../../state/entities";
import { textDirection } from "../../textDirection";
import { buildThreadRouteParams } from "../../threadRoutes";
import { RelativeTime } from "../RelativeTime";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { resolveWorktreeMembers } from "./threadTabs.logic";
import {
  resolveThreadTabLocation,
  type ThreadTabItem,
  type ThreadTabLocation,
  useThreadTabActions,
  useWorktreeTabs,
} from "./useThreadTabs";

function HistorySection(props: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="flex flex-col gap-px">
      <h3 className="px-2 pt-3 pb-1 text-2xs font-medium tracking-wide text-muted-foreground uppercase">
        {props.title}
      </h3>
      {props.children}
    </section>
  );
}

function HistoryRow(props: {
  readonly title: string;
  readonly detail: ReactNode;
  readonly active?: boolean;
  readonly onOpen: () => void;
  readonly action?: {
    readonly label: string;
    readonly icon: ReactNode;
    readonly onClick: () => void;
  };
}) {
  return (
    <div
      className={cn(
        "group/history-row flex h-8 items-center gap-2 rounded-md px-2 text-sm",
        props.active
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
      )}
    >
      <button
        type="button"
        aria-current={props.active ? "page" : undefined}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
        onClick={props.onOpen}
      >
        <span className="min-w-0 flex-1 truncate" dir={textDirection(props.title)}>
          {props.title}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{props.detail}</span>
      </button>
      {props.action ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label={props.action.label}
                className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground opacity-0 hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover/history-row:opacity-100"
                onClick={props.action.onClick}
              />
            }
          >
            {props.action.icon}
          </TooltipTrigger>
          <TooltipPopup side="left">{props.action.label}</TooltipPopup>
        </Tooltip>
      ) : null}
    </div>
  );
}

function WorktreeTabsHistory(props: { readonly location: ThreadTabLocation }) {
  const { location } = props;
  const router = useRouter();
  const threads = useQuietThreadShells();
  const { tabs, routeKey } = useWorktreeTabs(location);
  const { closeTab } = useThreadTabActions(location);
  const { unsettleThread, unsnoozeThread } = useThreadActions();
  // oxlint-disable-next-line react/purity -- Snooze state is read against the render that lists it.
  const now = new Date().toISOString();
  const members = resolveWorktreeMembers(threads, location.worktreeKey);
  const snoozed = members
    .filter((thread) => thread.settledOverride !== "settled" && effectiveSnoozed(thread, { now }))
    .toSorted((left, right) => (left.snoozedUntil ?? "").localeCompare(right.snoozedUntil ?? ""));
  const closed = members
    .filter((thread) => thread.settledOverride === "settled")
    .toSorted((left, right) => (right.settledAt ?? "").localeCompare(left.settledAt ?? ""));

  const goTo = (threadRef: ScopedThreadRef, draftId: DraftId | null = null) => {
    void (draftId === null
      ? router.navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(threadRef),
        })
      : router.navigate({ to: "/draft/$draftId", params: { draftId } }));
  };
  const reopen = (thread: EnvironmentThreadShell, action: "unsettle" | "unsnooze") => {
    const threadRef = scopeThreadRef(thread.environmentId, thread.id);
    goTo(threadRef);
    void (action === "unsettle" ? unsettleThread(threadRef) : unsnoozeThread(threadRef)).then(
      (result) => {
        if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: action === "unsettle" ? "Failed to reopen tab" : "Failed to wake thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      },
    );
  };
  const openTabs = tabs.filter((tab) => tab.kind === "draft" || !tab.closed);
  const openTab = (tab: ThreadTabItem) =>
    tab.kind === "thread"
      ? goTo(scopeThreadRef(tab.thread.environmentId, tab.thread.id))
      : goTo(
          scopeThreadRef(location.environmentId, ThreadId.make(tab.threadId)),
          DraftId.make(tab.draftId),
        );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-3" data-tab-history>
      <HistorySection title="Open tabs">
        {openTabs.map((tab) => (
          <HistoryRow
            key={tab.key}
            title={tab.kind === "thread" ? tab.thread.title : "New thread"}
            detail={
              tab.kind === "thread" ? <RelativeTime timestamp={tab.thread.updatedAt} /> : "Draft"
            }
            active={tab.key === routeKey}
            onOpen={() => openTab(tab)}
            action={{
              label: "Close tab",
              icon: <XIcon className="size-3.5" />,
              onClick: () => closeTab(tab.key),
            }}
          />
        ))}
      </HistorySection>
      {snoozed.length > 0 ? (
        <HistorySection title="Snoozed">
          {snoozed.map((thread) => (
            <HistoryRow
              key={scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))}
              title={thread.title}
              detail={
                <span className="inline-flex items-center gap-1">
                  <AlarmClockIcon aria-hidden className="size-3" />
                  <RelativeTime timestamp={thread.snoozedUntil ?? now} />
                </span>
              }
              active={scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) === routeKey}
              onOpen={() => goTo(scopeThreadRef(thread.environmentId, thread.id))}
              action={{
                label: "Wake and open",
                icon: <AlarmClockIcon className="size-3.5" />,
                onClick: () => reopen(thread, "unsnooze"),
              }}
            />
          ))}
        </HistorySection>
      ) : null}
      <HistorySection title="Closed tabs">
        {closed.length === 0 ? (
          <p className="px-2 py-1 text-xs text-muted-foreground">No closed tabs</p>
        ) : (
          closed.map((thread) => (
            <HistoryRow
              key={scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))}
              title={thread.title}
              detail={<RelativeTime timestamp={thread.settledAt ?? thread.updatedAt} />}
              active={scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) === routeKey}
              onOpen={() => reopen(thread, "unsettle")}
              action={{
                label: "View without reopening",
                icon: <EyeIcon className="size-3.5" />,
                onClick: () => goTo(scopeThreadRef(thread.environmentId, thread.id)),
              }}
            />
          ))
        )}
      </HistorySection>
    </div>
  );
}

/** Every tab in the panel thread's worktree: open ones first, then snoozed and closed ones. */
export function WorktreeTabsPanel(props: { readonly threadRef: ScopedThreadRef }) {
  const shell = useQuietThreadShell(props.threadRef);
  const draftId = useComposerDraftStore((store) => store.getDraftIdByRef(props.threadRef));
  const draft = useComposerDraftStore((store) => store.getDraftThreadByRef(props.threadRef));
  const location = resolveThreadTabLocation({
    routeThreadRef: props.threadRef,
    routeDraftId: shell === null ? draftId : null,
    shell,
    draft: shell === null ? draft : null,
  });
  if (location === null) {
    return <p className="p-4 text-sm text-muted-foreground">No tabs to show yet.</p>;
  }
  return <WorktreeTabsHistory location={location} />;
}
