import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { resolveThreadActivityTimestamp } from "@t3tools/client-runtime/state/thread-sort";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ResolvedKeybindingsConfig,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import {
  closestCenter,
  type CollisionDetection,
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  restrictToFirstScrollableAncestor,
  restrictToHorizontalAxis,
  restrictToVerticalAxis,
} from "@dnd-kit/modifiers";
import {
  horizontalListSortingStrategy,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { HistoryIcon, PlusIcon, Rows3Icon } from "lucide-react";
import { type CSSProperties, useState, type MouseEvent as ReactMouseEvent } from "react";

import { isElectron } from "../../env";
import { RESIZABLE_WIDTH_PROPERTY, useResizableWidth } from "../../hooks/useResizableWidth";
import { useRelativeTimeState } from "../../hooks/useRelativeTimeState";
import { updateClientSettings } from "../../hooks/useSettings";
import { useThreadActionMenu } from "../../hooks/useThreadActionMenu";
import { shortcutLabelForCommand } from "../../keybindings";
import { useStableCallback } from "../../hooks/useStableCallback";
import { cn } from "../../lib/utils";
import { shouldShowInstanceBadge } from "../../providerInstances";
import { selectActiveRightPanel, useRightPanelStore } from "../../rightPanelStore";
import { readEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { textDirection } from "../../textDirection";
import { canShareWithGuestAtom } from "../chat/guestShareAvailability";
import { GuestShareIndicator } from "../chat/GuestShareControls";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { hasUnseenCompletion, resolveSidebarThreadStatus } from "../Sidebar.logic";
import { sidebarProviderEntriesAtom } from "../sidebar/sidebarProviderEntries";
import { Button } from "../ui/button";
import { RightPanelResizeHandle } from "../preview/RightPanelResizeHandle";
import { PanelTabCloseButton } from "../ui/panel-tab-close-button";
import { ScrollArea } from "../ui/scroll-area";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../../workspaceTitlebar";
import { isBlankLastTab, resolveTabNeighbors } from "./threadTabs.logic";
import {
  type ThreadTabItem,
  type ThreadTabLocation,
  useThreadTabActions,
  useWorktreeTabs,
} from "./useThreadTabs";

const TAB_DRAG_MODIFIERS = [restrictToHorizontalAxis, restrictToFirstScrollableAncestor];
const VERTICAL_TAB_DRAG_MODIFIERS = [restrictToVerticalAxis, restrictToFirstScrollableAncestor];

// The modifiers stop a wide tab's center short of a narrow first tab, so target by the pointer.
const closestTabToPointer: CollisionDetection = (args) =>
  closestCenter(
    args.pointerCoordinates
      ? {
          ...args,
          collisionRect: {
            ...args.collisionRect,
            left: args.pointerCoordinates.x - args.collisionRect.width / 2,
          },
        }
      : args,
  );

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
    case "preparing":
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

function TabStatusDot(props: { readonly tab: ThreadTabItem }) {
  const { tab } = props;
  return (
    <span
      aria-hidden
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        tabStatusClassName(tab) ?? "bg-muted-foreground/30",
        tab.kind === "thread" && tab.closed && "bg-transparent ring-1 ring-muted-foreground/50",
      )}
    />
  );
}

const TAB_PROVIDER_ICON_SLOT = <span aria-hidden className="size-3.5 shrink-0" />;

/** The provider running the thread; drafts and unknown providers keep the slot so titles align. */
function TabProviderIcon(props: { readonly thread: EnvironmentThreadShell | null }) {
  const entriesByEnvironment = useAtomValue(sidebarProviderEntriesAtom);
  const { thread } = props;
  if (thread === null) return TAB_PROVIDER_ICON_SLOT;
  const entries = entriesByEnvironment.get(thread.environmentId);
  const entry = entries?.get(
    thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId,
  );
  if (entries === undefined || entry === undefined) return TAB_PROVIDER_ICON_SLOT;
  return (
    <ProviderInstanceIcon
      driverKind={entry.driverKind}
      displayName={entry.displayName}
      accentColor={entry.accentColor}
      acpRegistryAgentId={entry.acpRegistryAgentId}
      acpRegistryIconUrl={entry.acpRegistryIconUrl}
      showBadge={shouldShowInstanceBadge(entry, entries.values())}
      size="compact"
      iconClassName="opacity-60"
    />
  );
}

// Re-renders only when the label changes: each minute for the first hour, then hourly, then daily.
function TabActivityTime(props: { readonly thread: EnvironmentThreadShell }) {
  const relative = useRelativeTimeState(resolveThreadActivityTimestamp(props.thread));
  if (relative.status !== "relative") return null;
  return (
    <span className="shrink-0 text-muted-foreground tabular-nums">
      {relative.suffix === null ? "now" : relative.value}
    </span>
  );
}

interface TabMenuContext {
  readonly projectCwd: string | null;
  readonly environmentId: EnvironmentId;
  readonly onFind?: ((threadRef: ScopedThreadRef) => void) | undefined;
}

/** A tab's right-click thread menu and inline rename, the same wherever the tab shows. */
function useTabMenu(tab: ThreadTabItem, context: TabMenuContext) {
  const threadRef =
    tab.kind === "thread" ? scopeThreadRef(tab.thread.environmentId, tab.thread.id) : null;
  const title = tabTitle(tab);
  const [renaming, setRenaming] = useState(false);
  const canShareWithGuest = useAtomValue(canShareWithGuestAtom(context.environmentId));
  const updateThreadMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const startRename = () => {
    if (threadRef && readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope))
      setRenaming(true);
  };
  const { openMenu } = useThreadActionMenu({
    threadRef,
    projectCwd: context.projectCwd,
    onStartRename: startRename,
    onFind: context.onFind,
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
  const onContextMenu = (event: ReactMouseEvent) => {
    if (!threadRef) return;
    event.preventDefault();
    openMenu({ x: event.clientX, y: event.clientY });
  };
  return { renaming, startRename, commitRename, onContextMenu };
}

function TabRenameInput(props: {
  readonly title: string;
  readonly className: string;
  readonly onCommit: (value: string) => void;
}) {
  return (
    <input
      aria-label="Thread title"
      dir="auto"
      className={cn(
        "min-w-0 rounded-sm bg-background px-1 outline-none ring-1 ring-inset ring-ring",
        props.className,
      )}
      defaultValue={props.title}
      ref={(element) => {
        element?.focus();
        element?.select();
      }}
      onBlur={(event) => props.onCommit(event.currentTarget.value)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          event.currentTarget.value = props.title;
          event.currentTarget.blur();
        }
      }}
    />
  );
}

function ThreadTab(
  props: TabMenuContext & {
    readonly tab: ThreadTabItem;
    readonly active: boolean;
    readonly vertical: boolean;
    readonly closable: boolean;
    readonly onSelect: (key: string) => void;
    readonly onClose: (key: string) => void;
  },
) {
  const { tab, active, onSelect, onClose } = props;
  const title = tabTitle(tab);
  const { renaming, startRename, commitRename, onContextMenu } = useTabMenu(tab, props);
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: tab.key,
    disabled: renaming,
  });
  const statusDot = <TabStatusDot tab={tab} />;
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
      onContextMenu={onContextMenu}
      {...listeners}
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        // Isolated so the provider icon's z-index stays under a tab dragged across it.
        "group/tab isolate flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md pr-2 pl-1.5 text-xs",
        props.vertical ? "w-full" : "max-w-52 min-w-24",
        isElectron && "[-webkit-app-region:no-drag]",
        active || isDragging
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
        isDragging && "relative z-10",
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
        <TabRenameInput
          title={title}
          className={props.vertical ? "flex-1" : "w-32"}
          onCommit={commitRename}
        />
      ) : (
        <button
          type="button"
          role="tab"
          aria-label={title}
          aria-selected={active}
          className={cn(
            "flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-start",
            tab.kind === "thread" && tab.closed && "italic",
          )}
          onClick={() => onSelect(tab.key)}
          onDoubleClick={startRename}
        >
          {props.vertical ? (
            <TabProviderIcon thread={tab.kind === "thread" ? tab.thread : null} />
          ) : null}
          <span data-tab-title className="min-w-0 flex-1 truncate" dir={textDirection(title)}>
            {title}
          </span>
          {props.vertical && tab.kind === "thread" ? <TabActivityTime thread={tab.thread} /> : null}
        </button>
      )}
    </div>
  );
}

const toggleVerticalTabs = (vertical: boolean) =>
  void updateClientSettings({ threadTabsVertical: !vertical });

function TabLayoutToggle(props: { readonly vertical: boolean }) {
  const label = props.vertical ? "Show tabs in the top bar" : "Show tabs in a side panel";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            aria-pressed={props.vertical}
            className="shrink-0"
            size="icon-xs"
            variant="ghost-muted"
            onClick={() => toggleVerticalTabs(props.vertical)}
          />
        }
      >
        <Rows3Icon className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
}

interface ThreadTabListProps {
  readonly location: ThreadTabLocation;
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly projectCwd: string | null;
  readonly onFindInThread?: ((threadRef: ScopedThreadRef) => void) | undefined;
}

/** The worktree's tabs and its new-tab button, draggable along the list's axis. */
function ThreadTabList(props: ThreadTabListProps & { readonly vertical: boolean }) {
  const { location, vertical } = props;
  const { tabs, routeKey } = useWorktreeTabs(location);
  const tabActions = useThreadTabActions(location);
  const { newTab, selectTab, moveTab } = tabActions;
  const closeTab = useStableCallback(tabActions.closeTab);
  const dragSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );
  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (over) moveTab(String(active.id), String(over.id));
  };
  const newTabLabel = shortcutLabelForCommand(props.keybindings, "tab.new", {
    context: { threadTabs: true, isDesktop: isElectron, isWeb: !isElectron },
  });
  return (
    <DndContext
      sensors={dragSensors}
      collisionDetection={vertical ? closestCenter : closestTabToPointer}
      modifiers={vertical ? VERTICAL_TAB_DRAG_MODIFIERS : TAB_DRAG_MODIFIERS}
      onDragEnd={handleDragEnd}
    >
      <div
        role="tablist"
        aria-label="Thread tabs"
        aria-orientation={vertical ? "vertical" : "horizontal"}
        className={cn(
          "flex gap-1",
          vertical ? "flex-col items-start p-2" : "h-full w-max items-center",
        )}
      >
        <SortableContext
          items={tabs.map((tab) => tab.key)}
          strategy={vertical ? verticalListSortingStrategy : horizontalListSortingStrategy}
        >
          {tabs.map((tab) => (
            <ThreadTab
              key={tab.key}
              tab={tab}
              active={tab.key === routeKey}
              vertical={vertical}
              projectCwd={props.projectCwd}
              environmentId={location.environmentId}
              closable={!isBlankLastTab(tabs)}
              onSelect={selectTab}
              onClose={closeTab}
              {...(tab.key === routeKey ? { onFind: props.onFindInThread } : {})}
            />
          ))}
        </SortableContext>
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
          <TooltipPopup side={vertical ? "right" : "bottom"}>
            {location.creatingWorktree
              ? "New tabs open here once the worktree is ready"
              : newTabLabel
                ? `New tab (${newTabLabel})`
                : "New tab"}
          </TooltipPopup>
        </Tooltip>
      </div>
    </DndContext>
  );
}

function NeighborTab(props: {
  readonly tab: ThreadTabItem;
  readonly side: "Previous" | "Next";
  readonly menu: TabMenuContext;
  readonly onSelect: (key: string) => void;
}) {
  const title = tabTitle(props.tab);
  const { renaming, commitRename, onContextMenu } = useTabMenu(props.tab, props.menu);
  if (renaming) {
    return (
      <div className="flex h-7 min-w-0 items-center gap-1.5 px-2 text-xs">
        <TabStatusDot tab={props.tab} />
        <TabRenameInput title={title} className="w-32" onCommit={commitRename} />
      </div>
    );
  }
  return (
    <button
      type="button"
      aria-label={`${props.side} tab: ${title}`}
      data-neighbor-tab={props.tab.key}
      className="flex h-7 max-w-44 min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent/60 hover:text-foreground"
      onClick={() => props.onSelect(props.tab.key)}
      onContextMenu={onContextMenu}
    >
      <TabStatusDot tab={props.tab} />
      <span className="truncate" dir={textDirection(title)}>
        {title}
      </span>
    </button>
  );
}

function CurrentTab(props: { readonly tab: ThreadTabItem; readonly menu: TabMenuContext }) {
  const title = tabTitle(props.tab);
  const { renaming, startRename, commitRename, onContextMenu } = useTabMenu(props.tab, props.menu);
  return (
    <div
      role="presentation"
      data-current-tab={props.tab.key}
      className={cn(
        "flex h-7 min-w-0 items-center gap-1.5 rounded-md bg-accent px-2 text-xs text-foreground",
        // A title bar drag rectangle would swallow the right click.
        isElectron && "[-webkit-app-region:no-drag]",
      )}
      onContextMenu={onContextMenu}
      onDoubleClick={startRename}
    >
      <TabStatusDot tab={props.tab} />
      {renaming ? (
        <TabRenameInput title={title} className="w-64" onCommit={commitRename} />
      ) : (
        <span className="truncate" dir={textDirection(title)}>
          {title}
        </span>
      )}
    </div>
  );
}

/** The top bar while the side panel lists the tabs: the open tab, wide, between its neighbors. */
function ThreadTabNeighbors(props: {
  readonly location: ThreadTabLocation;
  readonly projectCwd: string | null;
  readonly onFindInThread?: ((threadRef: ScopedThreadRef) => void) | undefined;
}) {
  const { tabs, routeKey } = useWorktreeTabs(props.location);
  const { selectTab } = useThreadTabActions(props.location);
  const { previous, current, next } = resolveTabNeighbors(tabs, routeKey);
  const menu: TabMenuContext = {
    projectCwd: props.projectCwd,
    environmentId: props.location.environmentId,
  };
  return (
    <div
      role="group"
      aria-label="Open tab and its neighbors"
      className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_fit-content(60%)_minmax(0,1fr)] items-center gap-1"
    >
      <div className="flex min-w-0 justify-end">
        {previous ? (
          <NeighborTab tab={previous} side="Previous" menu={menu} onSelect={selectTab} />
        ) : null}
      </div>
      {current ? (
        <CurrentTab tab={current} menu={{ ...menu, onFind: props.onFindInThread }} />
      ) : (
        <span />
      )}
      <div className="flex min-w-0 justify-start">
        {next ? <NeighborTab tab={next} side="Next" menu={menu} onSelect={selectTab} /> : null}
      </div>
    </div>
  );
}

/** The open worktree's threads as tabs, in place of the thread breadcrumb. */
export function ThreadTabStrip(
  props: ThreadTabListProps & {
    /** The side panel holds the full list, so the bar shows only the open tab and its neighbors. */
    readonly vertical: boolean;
    /** The side panel is chosen but stepped aside for a lone tab, so it has nothing to toggle. */
    readonly sidePanelAutoHidden: boolean;
    readonly rightPanelOpen: boolean;
    readonly isServerThread: boolean;
  },
) {
  const { location } = props;
  const historyOpen = useRightPanelStore(
    (state) => selectActiveRightPanel(state.byThreadKey, location.routeThreadRef) === "tabs",
  );
  const toggleHistory = () => useRightPanelStore.getState().toggle(location.routeThreadRef, "tabs");
  return (
    <div
      className={cn(
        "flex min-w-0 flex-1 items-center gap-1",
        props.rightPanelOpen ? "pr-10" : "pr-24",
      )}
    >
      {props.vertical ? (
        <ThreadTabNeighbors
          location={location}
          projectCwd={props.projectCwd}
          onFindInThread={props.onFindInThread}
        />
      ) : (
        <>
          {/* The side panel needs the room a narrow window does not have. */}
          {props.sidePanelAutoHidden ? null : (
            <span className="flex shrink-0 max-md:hidden">
              <TabLayoutToggle vertical={false} />
            </span>
          )}
          <ScrollArea
            radius="none"
            hideScrollbars
            scrollFade
            className="min-w-0 flex-1"
            data-thread-tab-list
          >
            <ThreadTabList {...props} vertical={false} />
          </ScrollArea>
        </>
      )}
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

/** The worktree's tabs as a list beside the chat, folded away by the toggle at its top. */
export function ThreadTabColumn(props: ThreadTabListProps) {
  const { width, handlers } = useResizableWidth({
    storageKey: "t3code.threadTabColumnWidth",
    defaultWidth: 224,
    minWidth: 160,
    maxWidth: 480,
    edge: "right",
  });
  return (
    <aside
      data-thread-tab-column
      className="relative flex w-(--resizable-width) shrink-0 border-r border-border bg-background [[data-panel-animations=true]_&]:motion-safe:transition-[width] [[data-panel-animations=true]_&]:motion-safe:duration-(--panel-animation-duration) [[data-panel-animations=true]_&]:motion-safe:ease-out [[data-panel-animations=true]_&]:motion-safe:starting:w-0"
      style={{ [RESIZABLE_WIDTH_PROPERTY]: `${width}px` } as CSSProperties}
    >
      <RightPanelResizeHandle edge="right" handlers={handlers} label="Resize tab panel" />
      {/* Clips the content while the panel opens from zero width; the handle stays outside it
          so it can straddle the border. */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div
          className={cn(
            "flex h-[var(--workspace-topbar-height)] w-(--resizable-width) shrink-0 items-center px-2",
            isElectron && "drag-region",
            COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
          )}
        >
          <TabLayoutToggle vertical />
        </div>
        <ScrollArea
          radius="none"
          className="min-h-0 w-(--resizable-width) flex-1"
          data-thread-tab-list
        >
          <ThreadTabList {...props} vertical />
        </ScrollArea>
      </div>
    </aside>
  );
}
