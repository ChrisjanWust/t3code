import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { resolveThreadActivityTimestamp } from "@t3tools/client-runtime/state/thread-sort";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { msg, T, useGT, useMessages } from "gt-react";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ResolvedKeybindingsConfig,
  type ScopedThreadRef,
  type ThreadId,
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
import {
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  CornerLeftUpIcon,
  GitBranchIcon,
  HistoryIcon,
  PlusIcon,
  Rows3Icon,
} from "lucide-react";
import {
  type CSSProperties,
  type ReactNode,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";

import { isElectron } from "../../env";
import { SIBLING_COLUMN_MIN_WIDTH } from "../../hooks/usePreviewPanelInlineSize";
import { RESIZABLE_WIDTH_PROPERTY, useResizableWidth } from "../../hooks/useResizableWidth";
import { useRelativeTimeState } from "../../hooks/useRelativeTimeState";
import { updateClientSettings } from "../../hooks/useSettings";
import { useThreadActionMenu } from "../../hooks/useThreadActionMenu";
import { shortcutLabelForCommand } from "../../keybindings";
import { useStableCallback } from "../../hooks/useStableCallback";
import { observeResize } from "../../lib/observeResize";
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
import { resolveSidebarThreadStatus } from "../Sidebar.logic";
import { sidebarProviderEntriesAtom } from "../sidebar/sidebarProviderEntries";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { RightPanelResizeHandle } from "../preview/RightPanelResizeHandle";
import { PanelTabCloseButton } from "../ui/panel-tab-close-button";
import { ScrollArea } from "../ui/scroll-area";
import { m, type MessageResolver } from "../../i18n/messages";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../../workspaceTitlebar";
import { useSubagentListStore } from "./subagentListStore";
import {
  isBlankLastTab,
  newestTabSubagents,
  type TabStatusTone,
  tabsInLayoutOrder,
  threadTabStatusTone,
} from "./threadTabs.logic";
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
const STATUS_TONE_CLASS: Record<TabStatusTone, string> = {
  attention: "bg-warning",
  failed: "bg-destructive",
  working: "bg-info",
  unseen: "bg-success",
};

function threadStatusClassName(thread: EnvironmentThreadShell): string | null {
  const tone = threadTabStatusTone(thread);
  return tone === null ? null : STATUS_TONE_CLASS[tone];
}

function tabStatusClassName(tab: ThreadTabItem): string | null {
  return tab.kind === "draft" || tab.closed ? null : threadStatusClassName(tab.thread);
}

function ThreadStatusDot(props: { readonly thread: EnvironmentThreadShell }) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        threadStatusClassName(props.thread) ?? "bg-muted-foreground/30",
      )}
    />
  );
}

/** The open tab's subagents, which only it can list since only its family is loaded. */
interface TabSubagentView {
  readonly tabKey: string;
  /** Newest first. */
  readonly subagents: readonly EnvironmentThreadShell[];
  /** The tab's subagent the route shows or descends from. */
  readonly routeSubagentId: ThreadId | null;
  /** The subagent the route shows, when it shows one rather than the tab's own thread. */
  readonly routeSubagent: EnvironmentThreadShell | null;
  readonly onOpen: (thread: EnvironmentThreadShell) => void;
}

const stopPropagation = (event: { stopPropagation: () => void }) => event.stopPropagation();

// Portalled, the popup's events still bubble to the tab, whose drag, menu and close must not see them.
const KEEP_EVENTS_IN_MENU = {
  onPointerDown: stopPropagation,
  onAuxClick: stopPropagation,
  onContextMenu: (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
  },
};

/** The open tab's subagents as listed: the newest few until the user shows the rest. */
function useListedSubagents(view: TabSubagentView) {
  const gt = useGT();
  const expanded = useSubagentListStore((state) => state.expanded[view.tabKey] === true);
  const toggle = useSubagentListStore((state) => state.toggle);
  const newest = newestTabSubagents(view.subagents, view.routeSubagentId);
  const hiddenCount = view.subagents.length - newest.length;
  return {
    shown: expanded ? view.subagents : newest,
    expanded,
    toggleLabel:
      hiddenCount === 0
        ? null
        : expanded
          ? gt("Show less")
          : gt("{count, plural, one {Show {count} more} other {Show {count} more}}", {
              count: hiddenCount,
            }),
    toggleExpanded: () => toggle("expanded", view.tabKey),
  };
}

function ShowMoreIcon(props: { readonly expanded: boolean }) {
  const Icon = props.expanded ? ChevronUpIcon : ChevronDownIcon;
  return (
    <span className="flex size-4 shrink-0 items-center justify-center">
      <Icon aria-hidden className="size-3 text-muted-foreground" />
    </span>
  );
}

/** The open tab's subagents, newest first, in a menu. */
function SubagentMenu(props: {
  readonly view: TabSubagentView;
  readonly label: string;
  readonly className: string;
  readonly onTriggerContextMenu?: ((event: ReactMouseEvent) => void) | undefined;
  readonly children: ReactNode;
}) {
  const { routeSubagent, onOpen } = props.view;
  const listed = useListedSubagents(props.view);
  const item = (thread: EnvironmentThreadShell) => (
    <MenuItem key={thread.id} onClick={() => onOpen(thread)}>
      <span className="flex size-4 shrink-0 items-center justify-center">
        <ThreadStatusDot thread={thread} />
      </span>
      <span className="min-w-0 flex-1 truncate" dir={textDirection(thread.title)}>
        {thread.title}
      </span>
      {thread.id === routeSubagent?.id ? <CheckIcon aria-hidden className="size-3.5" /> : null}
    </MenuItem>
  );
  return (
    <Menu>
      <MenuTrigger
        render={
          <button
            type="button"
            aria-label={props.label}
            className={props.className}
            onPointerDown={stopPropagation}
            onContextMenu={props.onTriggerContextMenu}
          />
        }
      >
        {props.children}
      </MenuTrigger>
      <MenuPopup align="start" className="max-w-96" {...KEEP_EVENTS_IN_MENU}>
        {listed.shown.map(item)}
        {listed.toggleLabel === null ? null : (
          <>
            <MenuSeparator />
            <MenuItem closeOnClick={false} onClick={listed.toggleExpanded}>
              <ShowMoreIcon expanded={listed.expanded} />
              {listed.toggleLabel}
            </MenuItem>
          </>
        )}
      </MenuPopup>
    </Menu>
  );
}

function SubagentRow(props: {
  readonly thread: EnvironmentThreadShell;
  readonly view: TabSubagentView;
}) {
  const { thread, view } = props;
  const onRoute = thread.id === view.routeSubagentId;
  const current = onRoute && thread.id === view.routeSubagent?.id;
  return (
    <button
      type="button"
      aria-current={current ? "page" : undefined}
      className={cn(
        "flex h-6 w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-md pr-2 pl-1.5 text-start text-xs",
        current
          ? "bg-accent text-foreground"
          : onRoute
            ? "bg-accent/50 text-foreground"
            : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
      )}
      onClick={() => view.onOpen(thread)}
    >
      <span className="flex size-4 shrink-0 items-center justify-center">
        <ThreadStatusDot thread={thread} />
      </span>
      <span className="min-w-0 flex-1 truncate" dir={textDirection(thread.title)}>
        {thread.title}
      </span>
      <TabActivityTime thread={thread} />
    </button>
  );
}

/** The open tab's subagents under it in the side panel, newest first. */
function SubagentTree(props: { readonly view: TabSubagentView }) {
  const { view } = props;
  const gt = useGT();
  const listed = useListedSubagents(view);
  return (
    <div role="group" aria-label={gt("Subagents")} className="flex flex-col gap-px pt-px ps-4">
      {listed.shown.map((thread) => (
        <SubagentRow key={thread.id} thread={thread} view={view} />
      ))}
      {listed.toggleLabel === null ? null : (
        <button
          type="button"
          aria-expanded={listed.expanded}
          className="flex h-6 cursor-pointer items-center gap-1.5 rounded-md pr-2 pl-1.5 text-xs text-muted-foreground hover:bg-accent/60 hover:text-foreground"
          onClick={listed.toggleExpanded}
        >
          <ShowMoreIcon expanded={listed.expanded} />
          {listed.toggleLabel}
        </button>
      )}
    </div>
  );
}

const subagentTabItem = (subagent: EnvironmentThreadShell): ThreadTabItem => ({
  kind: "thread",
  key: scopedThreadKey(scopeThreadRef(subagent.environmentId, subagent.id)),
  thread: subagent,
  closed: false,
});

function tabTitle(tab: ThreadTabItem, resolve: MessageResolver): string {
  return tab.kind === "thread" ? tab.thread.title : resolve(msg("New thread"));
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
  const status = resolveSidebarThreadStatus(props.thread);
  // A running turn's newest timestamp is its start, which would count up as if the thread were idle.
  const running = status === "preparing" || status === "working";
  const relative = useRelativeTimeState(
    running ? null : resolveThreadActivityTimestamp(props.thread),
  );
  const label = running
    ? "now"
    : relative.status !== "relative"
      ? null
      : relative.suffix === null
        ? "now"
        : relative.value;
  if (label === null) return null;
  return <span className="shrink-0 text-muted-foreground tabular-nums">{label}</span>;
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
  const gt = useGT();
  const messages = useMessages();
  const title = tabTitle(tab, messages);
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
        title: gt("Failed to rename thread"),
        description: thrownErrorMessage(error, m) ?? gt("An error occurred."),
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
  const gt = useGT();
  return (
    <input
      aria-label={gt("Thread title")}
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

/** The subagent half of a top-bar tab: it switches subagents, and its menu acts on the subagent. */
function SplitTabSubagent(props: {
  readonly view: TabSubagentView;
  readonly subagent: EnvironmentThreadShell;
  readonly menu: TabMenuContext;
}) {
  const { subagent } = props;
  const gt = useGT();
  const { renaming, commitRename, onContextMenu } = useTabMenu(
    subagentTabItem(subagent),
    props.menu,
  );
  if (renaming) {
    return <TabRenameInput title={subagent.title} className="w-32" onCommit={commitRename} />;
  }
  return (
    <SubagentMenu
      view={props.view}
      label={gt("Switch subagent from {title}", { title: subagent.title })}
      className="flex min-w-0 flex-1 cursor-pointer items-center gap-1 text-start"
      onTriggerContextMenu={(event) => {
        event.stopPropagation();
        onContextMenu(event);
      }}
    >
      <span
        className="max-w-48 min-w-0 truncate @max-3xl/tabs:max-w-32"
        dir={textDirection(subagent.title)}
      >
        {subagent.title}
      </span>
      <ChevronDownIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
    </SubagentMenu>
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
    /** Only the open tab has one. */
    readonly subagentView?: TabSubagentView | undefined;
  },
) {
  const { tab, active, onSelect, onClose, subagentView: view } = props;
  const gt = useGT();
  const messages = useMessages();
  const title = tabTitle(tab, messages);
  const routeSubagent = view?.routeSubagent ?? null;
  // Find works only in the open thread, which inside a subagent is the subagent, not this tab.
  const { renaming, startRename, commitRename, onContextMenu } = useTabMenu(
    tab,
    routeSubagent === null ? props : { ...props, onFind: undefined },
  );
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: tab.key,
    disabled: renaming,
  });
  const collapsed = useSubagentListStore((state) => state.collapsed[tab.key] === true);
  const toggleList = useSubagentListStore((state) => state.toggle);
  const hasSubagents = view !== undefined && view.subagents.length > 0;
  // The side panel marks the tab as the subagent's ancestor and lists the subagent under it;
  // the top bar keeps the tab selected and names the subagent inside it.
  const ancestor = props.vertical && routeSubagent !== null;
  const split = !props.vertical && view !== undefined && routeSubagent !== null;
  const statusDot = <TabStatusDot tab={tab} />;
  return (
    <div
      data-thread-tab={tab.key}
      data-active-tab={active}
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      // Isolated so the provider icon's z-index stays under a tab dragged across it.
      className={cn("isolate shrink-0", props.vertical && "w-full", isDragging && "relative z-10")}
    >
      <div
        role="presentation"
        onMouseDown={preventMiddleButtonDefault}
        onMouseUp={preventMiddleButtonDefault}
        onAuxClick={(event) => {
          if (event.button === 1) onClose(tab.key);
        }}
        onContextMenu={onContextMenu}
        {...listeners}
        className={cn(
          "group/tab flex h-7 cursor-pointer items-center gap-1.5 rounded-md pr-2 pl-1.5 text-xs",
          props.vertical ? "w-full" : split ? "max-w-96 min-w-24" : "max-w-52 min-w-24",
          isElectron && "[-webkit-app-region:no-drag]",
          isDragging || (active && !ancestor)
            ? "bg-accent text-foreground"
            : active
              ? "bg-accent/50 text-foreground"
              : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
        )}
      >
        {props.closable ? (
          <PanelTabCloseButton
            label={gt("Close {title}", { title })}
            onClick={() => onClose(tab.key)}
          >
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
        ) : split ? (
          <>
            {/* The tab's own name returns to its thread, one level up from the subagent. */}
            <button
              type="button"
              role="tab"
              aria-label={title}
              aria-selected={active}
              className="flex min-w-0 shrink cursor-pointer items-center gap-1 text-muted-foreground hover:text-foreground"
              onClick={() => onSelect(tab.key)}
              onDoubleClick={startRename}
            >
              <CornerLeftUpIcon aria-hidden className="size-3 shrink-0" />
              <span
                data-tab-title
                className="max-w-28 truncate @max-3xl/tabs:hidden"
                dir={textDirection(title)}
              >
                {title}
              </span>
            </button>
            <ChevronRightIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
            <SplitTabSubagent view={view} subagent={routeSubagent} menu={props} />
          </>
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
            {props.vertical && tab.kind === "thread" ? (
              <TabActivityTime thread={tab.thread} />
            ) : null}
          </button>
        )}
        {!props.vertical && !split && hasSubagents ? (
          <SubagentMenu
            view={view}
            label={gt("Subagents")}
            className="flex shrink-0 cursor-pointer items-center gap-0.5 text-muted-foreground tabular-nums hover:text-foreground"
          >
            <BotIcon aria-hidden className="size-3" />
            {view.subagents.length}
            <ChevronDownIcon aria-hidden className="size-3" />
          </SubagentMenu>
        ) : null}
        {props.vertical && hasSubagents ? (
          <button
            type="button"
            aria-label={collapsed ? gt("Show subagents") : gt("Hide subagents")}
            aria-expanded={!collapsed}
            className="flex shrink-0 cursor-pointer items-center gap-0.5 text-muted-foreground tabular-nums hover:text-foreground"
            onClick={() => toggleList("collapsed", tab.key)}
          >
            {collapsed ? view.subagents.length : null}
            {collapsed ? (
              <ChevronRightIcon aria-hidden className="size-3.5" />
            ) : (
              <ChevronDownIcon aria-hidden className="size-3.5" />
            )}
          </button>
        ) : null}
      </div>
      {props.vertical && hasSubagents && !collapsed ? <SubagentTree view={view} /> : null}
    </div>
  );
}

const toggleVerticalTabs = (vertical: boolean) =>
  void updateClientSettings({ threadTabsVertical: !vertical });

function TabLayoutToggle(props: { readonly vertical: boolean }) {
  const gt = useGT();
  const label = props.vertical ? gt("Show tabs in the top bar") : gt("Show tabs in a side panel");
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

function NewTabButton(props: {
  readonly location: ThreadTabLocation;
  readonly keybindings: ResolvedKeybindingsConfig;
}) {
  const { location } = props;
  const gt = useGT();
  const { newTab } = useThreadTabActions(location);
  const shortcut = shortcutLabelForCommand(props.keybindings, "tab.new", {
    context: { threadTabs: true, isDesktop: isElectron, isWeb: !isElectron },
  });
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="flex shrink-0" />}>
        <Button
          aria-label={gt("New tab")}
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
          ? gt("New tabs open here once the worktree is ready")
          : shortcut
            ? gt("New tab ({shortcut})", { shortcut })
            : gt("New tab")}
      </TooltipPopup>
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
  const gt = useGT();
  const {
    tabs: savedOrder,
    routeKey,
    subagents,
    routeSubagentId,
    routeSubagent,
  } = useWorktreeTabs(location);
  const tabs = tabsInLayoutOrder(savedOrder, vertical);
  const tabActions = useThreadTabActions(location);
  const { selectTab, moveTab, openThread } = tabActions;
  const subagentView: TabSubagentView = {
    tabKey: routeKey,
    subagents,
    routeSubagentId,
    routeSubagent,
    onOpen: (thread) => void openThread(scopeThreadRef(thread.environmentId, thread.id)),
  };
  const closeTab = useStableCallback(tabActions.closeTab);
  const dragSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );
  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (over) moveTab(String(active.id), String(over.id));
  };
  return (
    <DndContext
      sensors={dragSensors}
      collisionDetection={vertical ? closestCenter : closestTabToPointer}
      modifiers={vertical ? VERTICAL_TAB_DRAG_MODIFIERS : TAB_DRAG_MODIFIERS}
      onDragEnd={handleDragEnd}
    >
      <div
        role="tablist"
        aria-label={gt("Thread tabs")}
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
              {...(tab.key === routeKey ? { onFind: props.onFindInThread, subagentView } : {})}
            />
          ))}
        </SortableContext>
        {/* The panel's own button sits at the right of its header, like the sidebar's. */}
        {vertical ? null : <NewTabButton location={location} keybindings={props.keybindings} />}
      </div>
    </DndContext>
  );
}

function CurrentTab(props: {
  readonly tab: ThreadTabItem;
  readonly menu: TabMenuContext;
  /** The subagent the route shows inside this tab, if any. */
  readonly subagent: EnvironmentThreadShell | null;
  readonly onUp: () => void;
}) {
  const { tab, subagent } = props;
  const gt = useGT();
  const messages = useMessages();
  // Inside a subagent the pill names it, and its menu and rename act on it.
  const shown = subagent === null ? tab : subagentTabItem(subagent);
  const title = tabTitle(shown, messages);
  const tabName = tabTitle(tab, messages);
  const { renaming, startRename, commitRename, onContextMenu } = useTabMenu(shown, props.menu);
  return (
    <div
      role="presentation"
      data-current-tab={tab.key}
      className={cn(
        "flex h-7 min-w-0 items-center gap-1.5 rounded-md bg-accent px-2 text-xs text-foreground",
        // A title bar drag rectangle would swallow the right click.
        isElectron && "[-webkit-app-region:no-drag]",
      )}
      onContextMenu={onContextMenu}
    >
      {subagent === null ? null : (
        <>
          <button
            type="button"
            aria-label={gt("Up to {title}", { title: tabName })}
            className="flex min-w-0 shrink cursor-pointer items-center gap-1 text-muted-foreground hover:text-foreground"
            onClick={props.onUp}
          >
            <CornerLeftUpIcon aria-hidden className="size-3 shrink-0" />
            <span className="max-w-48 truncate" dir={textDirection(tabName)}>
              {tabName}
            </span>
          </button>
          <ChevronRightIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
        </>
      )}
      <TabStatusDot tab={shown} />
      {renaming ? (
        <TabRenameInput title={title} className="w-64" onCommit={commitRename} />
      ) : (
        <span className="truncate" dir={textDirection(title)} onDoubleClick={startRename}>
          {title}
        </span>
      )}
    </div>
  );
}

/** The checkout a subagent works in, when it is not its tab's. */
function SubagentBranch(props: {
  readonly tab: ThreadTabItem;
  readonly subagent: EnvironmentThreadShell;
}) {
  const { branch, worktreePath } = props.subagent;
  if (props.tab.kind !== "thread" || branch === null) return null;
  if (worktreePath === props.tab.thread.worktreePath) return null;
  return (
    <span className="flex min-w-0 shrink items-center gap-1 text-xs text-muted-foreground">
      <GitBranchIcon aria-hidden className="size-3 shrink-0" />
      <span className="truncate font-mono">{branch}</span>
    </span>
  );
}

/** The top bar while the side panel lists the tabs: only the open tab. */
function ThreadTabCurrent(props: {
  readonly location: ThreadTabLocation;
  readonly projectCwd: string | null;
  readonly onFindInThread?: ((threadRef: ScopedThreadRef) => void) | undefined;
}) {
  const { tabs, routeKey, routeSubagent } = useWorktreeTabs(props.location);
  const { selectTab } = useThreadTabActions(props.location);
  const current = tabs.find((tab) => tab.key === routeKey);
  return (
    <div className="flex min-w-0 flex-1 items-center justify-center gap-2">
      {current ? (
        <>
          <CurrentTab
            key={current.key}
            tab={current}
            subagent={routeSubagent}
            onUp={() => selectTab(current.key)}
            menu={{
              projectCwd: props.projectCwd,
              environmentId: props.location.environmentId,
              onFind: props.onFindInThread,
            }}
          />
          {routeSubagent ? <SubagentBranch tab={current} subagent={routeSubagent} /> : null}
        </>
      ) : null}
    </div>
  );
}

/** The open worktree's threads as tabs, in place of the thread breadcrumb. */
export function ThreadTabStrip(
  props: ThreadTabListProps & {
    /** The side panel holds the full list, so the bar shows only the open tab. */
    readonly vertical: boolean;
    /** The side panel is chosen but stepped aside for a lone tab, so it has nothing to toggle. */
    readonly sidePanelAutoHidden: boolean;
    readonly rightPanelOpen: boolean;
    readonly isServerThread: boolean;
  },
) {
  const { location } = props;
  const gt = useGT();
  const historyOpen = useRightPanelStore(
    (state) => selectActiveRightPanel(state.byThreadKey, location.routeThreadRef) === "tabs",
  );
  const toggleHistory = () => useRightPanelStore.getState().toggle(location.routeThreadRef, "tabs");
  return (
    <div
      className={cn(
        // A narrow strip shortens a subagent's tab to its up arrow.
        "@container/tabs flex min-w-0 flex-1 items-center gap-1",
        props.rightPanelOpen ? "pr-10" : "pr-24",
      )}
    >
      {props.vertical ? (
        <ThreadTabCurrent
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
              aria-label={gt("Tab history")}
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
        <TooltipPopup side="bottom">
          <T>Tab history</T>
        </TooltipPopup>
      </Tooltip>
      {props.isServerThread ? <GuestShareIndicator threadRef={location.routeThreadRef} /> : null}
    </div>
  );
}

// Fits both header buttons after the ~130px macOS title bar inset a collapsed sidebar leaves.
const TAB_COLUMN_MIN_WIDTH = 192;
const TAB_COLUMN_MAX_WIDTH = 480;

/** The worktree's tabs as a list beside the chat, folded away by the toggle at its top. */
export function ThreadTabColumn(props: ThreadTabListProps) {
  const gt = useGT();
  const [maxWidth, setMaxWidth] = useState(TAB_COLUMN_MAX_WIDTH);
  const { width, handlers } = useResizableWidth({
    storageKey: "t3code.threadTabColumnWidth",
    defaultWidth: 224,
    minWidth: TAB_COLUMN_MIN_WIDTH,
    maxWidth,
    edge: "right",
  });
  return (
    <aside
      ref={(host) => {
        const row = host?.parentElement;
        if (!row) return;
        // The chat beside the panel keeps the width its composer needs.
        const measure = () =>
          setMaxWidth(
            Math.max(
              TAB_COLUMN_MIN_WIDTH,
              Math.min(TAB_COLUMN_MAX_WIDTH, row.clientWidth - SIBLING_COLUMN_MIN_WIDTH),
            ),
          );
        measure();
        return observeResize(row, measure);
      }}
      data-thread-tab-column
      className="relative flex w-(--resizable-width) shrink-0 border-r border-border bg-sidebar-secondary [[data-panel-animations=true]_&]:motion-safe:transition-[width] [[data-panel-animations=true]_&]:motion-safe:duration-(--panel-animation-duration) [[data-panel-animations=true]_&]:motion-safe:ease-out [[data-panel-animations=true]_&]:motion-safe:starting:w-0"
      style={{ [RESIZABLE_WIDTH_PROPERTY]: `${width}px` } as CSSProperties}
    >
      <RightPanelResizeHandle edge="right" handlers={handlers} label={gt("Resize tab panel")} />
      {/* Clips the content while the panel opens from zero width; the handle stays outside it
          so it can straddle the border. */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div
          className={cn(
            "flex h-[var(--workspace-topbar-height)] w-(--resizable-width) shrink-0 items-center justify-between px-2",
            isElectron && "drag-region",
            COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
          )}
        >
          <TabLayoutToggle vertical />
          <NewTabButton location={props.location} keybindings={props.keybindings} />
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
