import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { HistoryIcon, PlusIcon } from "lucide-react";
import { useEffect, useState, type MouseEvent as ReactMouseEvent } from "react";

import { isElectron } from "../../env";
import { useThreadActionMenu } from "../../hooks/useThreadActionMenu";
import { shortcutLabelForCommand } from "../../keybindings";
import { useStableCallback } from "../../hooks/useStableCallback";
import { cn } from "../../lib/utils";
import { selectActiveRightPanel, useRightPanelStore } from "../../rightPanelStore";
import { registerSettleAndAdvance } from "../../settleAndAdvance";
import { readEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { textDirection } from "../../textDirection";
import { canShareWithGuestAtom } from "../chat/guestShareAvailability";
import { GuestShareIndicator } from "../chat/GuestShareControls";
import { hasUnseenCompletion, resolveSidebarThreadStatus } from "../Sidebar.logic";
import { Button } from "../ui/button";
import { PanelTabCloseButton } from "../ui/panel-tab-close-button";
import { ScrollArea } from "../ui/scroll-area";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { isBlankLastTab } from "./threadTabs.logic";
import {
  type ThreadTabItem,
  type ThreadTabLocation,
  useThreadTabActions,
  useWorktreeTabs,
} from "./useThreadTabs";

function preventMiddleButtonDefault(event: ReactMouseEvent) {
  if (event.button === 1) event.preventDefault();
}

// Static colors only: a pulsing dot per tab would repaint the header continuously.
function tabStatusClassName(tab: ThreadTabItem): string | null {
  if (tab.kind === "draft" || tab.closed) return null;
  const status = resolveSidebarThreadStatus(tab.thread);
  switch (status) {
    case "approval":
    case "input":
    case "request":
    case "limited":
      return "bg-warning";
    case "failed":
      return "bg-destructive";
    case "working":
    case "waiting":
      return "bg-info";
    case "ready":
      return hasUnseenCompletion({
        ...tab.thread,
        lastVisitedAt: tab.thread.lastVisitedAt ?? undefined,
      })
        ? "bg-success"
        : null;
  }
}

function tabTitle(tab: ThreadTabItem): string {
  return tab.kind === "thread" ? tab.thread.title : "New thread";
}

function ThreadTab(props: {
  readonly tab: ThreadTabItem;
  readonly active: boolean;
  readonly projectCwd: string | null;
  readonly environmentId: EnvironmentId;
  readonly closable: boolean;
  readonly onSelect: (key: string) => void;
  readonly onClose: (key: string) => void;
}) {
  const { tab, active, onSelect, onClose } = props;
  const threadRef =
    tab.kind === "thread" ? scopeThreadRef(tab.thread.environmentId, tab.thread.id) : null;
  const title = tabTitle(tab);
  const [renaming, setRenaming] = useState(false);
  const canShareWithGuest = useAtomValue(canShareWithGuestAtom(props.environmentId));
  const updateThreadMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const startRename = () => {
    if (threadRef && readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope))
      setRenaming(true);
  };
  const { openMenu } = useThreadActionMenu({
    threadRef,
    projectCwd: props.projectCwd,
    onStartRename: startRename,
    canShareWithGuest,
  });
  const commitRename = (value: string) => {
    setRenaming(false);
    const trimmed = value.trim();
    if (!threadRef || trimmed.length === 0 || trimmed === title) return;
    void updateThreadMetadata({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, title: trimmed },
    }).then((result) => {
      if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Failed to rename thread",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    });
  };
  const statusClassName = tabStatusClassName(tab);
  const statusDot = (
    <span
      aria-hidden
      className={cn(
        "size-1.5 rounded-full",
        statusClassName ?? "bg-muted-foreground/30",
        tab.kind === "thread" && tab.closed && "bg-transparent ring-1 ring-muted-foreground/50",
      )}
    />
  );
  return (
    <div
      role="presentation"
      data-thread-tab={tab.key}
      data-active-tab={active}
      onMouseDown={preventMiddleButtonDefault}
      onMouseUp={preventMiddleButtonDefault}
      onAuxClick={(event) => {
        if (event.button === 1) onClose(tab.key);
      }}
      onContextMenu={(event) => {
        if (!threadRef) return;
        event.preventDefault();
        openMenu({ x: event.clientX, y: event.clientY });
      }}
      className={cn(
        "group/tab flex h-7 max-w-52 min-w-24 shrink-0 cursor-pointer items-center gap-1.5 rounded-md pr-2 pl-1.5 text-xs",
        isElectron && "[-webkit-app-region:no-drag]",
        active
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
      )}
    >
      {props.closable ? (
        <PanelTabCloseButton label={`Close ${title}`} onClick={() => onClose(tab.key)}>
          {statusDot}
        </PanelTabCloseButton>
      ) : (
        <span className="flex size-4 shrink-0 items-center justify-center">{statusDot}</span>
      )}
      {renaming ? (
        <input
          aria-label="Thread title"
          dir="auto"
          className="w-32 min-w-0 rounded-sm bg-background px-1 outline-none ring-1 ring-inset ring-ring"
          defaultValue={title}
          ref={(element) => {
            element?.focus();
            element?.select();
          }}
          onBlur={(event) => commitRename(event.currentTarget.value)}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              event.currentTarget.value = title;
              event.currentTarget.blur();
            }
          }}
        />
      ) : (
        <button
          type="button"
          role="tab"
          aria-selected={active}
          className={cn(
            "flex min-w-0 flex-1 cursor-pointer items-center",
            tab.kind === "thread" && tab.closed && "italic",
          )}
          onClick={() => {
            if (!active) onSelect(tab.key);
          }}
          onDoubleClick={startRename}
        >
          <span className="truncate" dir={textDirection(title)}>
            {title}
          </span>
        </button>
      )}
    </div>
  );
}

/** The open worktree's threads as tabs, in place of the thread breadcrumb. */
export function ThreadTabStrip(props: {
  readonly location: ThreadTabLocation;
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly projectCwd: string | null;
  readonly rightPanelOpen: boolean;
  readonly isServerThread: boolean;
}) {
  const { location } = props;
  const { tabs, routeKey } = useWorktreeTabs(location);
  const tabActions = useThreadTabActions(location);
  const { newTab, selectTab } = tabActions;
  const closeTab = useStableCallback(tabActions.closeTab);
  const historyOpen = useRightPanelStore(
    (state) => selectActiveRightPanel(state.byThreadKey, location.routeThreadRef) === "tabs",
  );
  // oxlint-disable-next-line t3code/react-effect-budget -- The thread.settle shortcut lives in the chat; while the strip is mounted, settling the open thread closes its tab.
  useEffect(
    () => registerSettleAndAdvance((threadRef) => closeTab(scopedThreadKey(threadRef))),
    [closeTab],
  );
  const newTabLabel = shortcutLabelForCommand(props.keybindings, "tab.new", {
    context: { threadTabs: true, isDesktop: isElectron, isWeb: !isElectron },
  });
  const toggleHistory = () => useRightPanelStore.getState().toggle(location.routeThreadRef, "tabs");
  return (
    <div
      className={cn(
        "flex min-w-0 flex-1 items-center gap-1",
        props.rightPanelOpen ? "pr-10" : "pr-24",
      )}
    >
      <ScrollArea
        radius="none"
        hideScrollbars
        scrollFade
        className="min-w-0 flex-1"
        data-thread-tab-list
      >
        <div
          role="tablist"
          aria-label="Thread tabs"
          className="flex h-full w-max items-center gap-1"
        >
          {tabs.map((tab) => (
            <ThreadTab
              key={tab.key}
              tab={tab}
              active={tab.key === routeKey}
              projectCwd={props.projectCwd}
              environmentId={location.environmentId}
              closable={!isBlankLastTab(tabs)}
              onSelect={selectTab}
              onClose={closeTab}
            />
          ))}
          <Tooltip>
            <TooltipTrigger render={<span className="flex shrink-0" />}>
              <Button
                aria-label="New tab"
                size="icon-xs"
                variant="ghost-muted"
                disabled={location.creatingWorktree}
                onClick={() => newTab()}
              >
                <PlusIcon className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipPopup side="bottom">
              {location.creatingWorktree
                ? "New tabs open here once the worktree is ready"
                : newTabLabel
                  ? `New tab (${newTabLabel})`
                  : "New tab"}
            </TooltipPopup>
          </Tooltip>
        </div>
      </ScrollArea>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-label="Tab history"
              aria-pressed={historyOpen}
              className="shrink-0"
              size="icon-xs"
              variant="ghost-muted"
              onClick={toggleHistory}
            />
          }
        >
          <HistoryIcon className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup side="bottom">Tab history</TooltipPopup>
      </Tooltip>
      {props.isServerThread ? <GuestShareIndicator threadRef={location.routeThreadRef} /> : null}
    </div>
  );
}
