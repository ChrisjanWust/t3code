import {
  type Announcements,
  DndContext,
  type DragEndEvent,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  type UniqueIdentifier,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  deriveThreadQueueWorkflowState,
  moveQueuedRun,
  type PendingQueuedRunOrder,
  shownQueuedRunOrder,
} from "@t3tools/client-runtime/state/thread-workflows";
import { assistantCitationsToPlainText } from "@t3tools/shared/assistantCitations";
import {
  isAttachmentOnlyBootstrapPrompt,
  replaceComposerContextReferences,
} from "@t3tools/shared/composerContextReferences";
import type {
  ChatAttachment as ContractChatAttachment,
  EnvironmentId,
  MessageId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { resolveUserMessagePresentation } from "@t3tools/client-runtime/user-message";
import { Link } from "@tanstack/react-router";
import {
  ArrowUpIcon,
  CalendarClockIcon,
  ChevronDownIcon,
  Clock3Icon,
  GripVerticalIcon,
  MessagesSquareIcon,
  PencilIcon,
  XIcon,
} from "lucide-react";
import * as DateTime from "effect/DateTime";
import { useId, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from "react";
import { createPortal } from "react-dom";

import { useAssetUrls } from "../../assets/assetUrls";
import { environmentThreadDetails, threadEnvironment } from "../../state/threads";
import { useQuietThreadShell, useThreadProjection } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { isImageAttachment, type ChatMessage } from "../../types";
import { cn } from "~/lib/utils";
import { Button, InlineButton } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { GuestMessageName } from "./guestMessageStyle";
import { TimelineRowTimestamp } from "./TimelineRowParts";
import { FoldedMessageHeader, useScheduledTaskTitle } from "./TimelineUserMessageRow";

export interface EditQueuedRunRequest {
  readonly runId: RunId;
  readonly messageId: MessageId;
  readonly text: string;
  readonly attachments: ReadonlyArray<ContractChatAttachment>;
}

interface QueuedRowThumbnail {
  readonly key: string;
  readonly name: string;
  readonly url: string | null;
}

// A longer queue shows its first messages and a button that shows the rest.
const QUEUE_VISIBLE_ROWS = 3;

export interface QueuedRunsControlHandle {
  steerNext: (repeat: boolean) => boolean;
  editLatest: (repeat: boolean) => boolean;
}

type ThreadQueueProjection = Parameters<typeof deriveThreadQueueWorkflowState>[0];

function queuedImageResources(projection: ThreadQueueProjection | undefined) {
  if (!projection) return [];
  return deriveThreadQueueWorkflowState(projection).queuedRuns.flatMap(({ attachments }) =>
    attachments.flatMap((attachment) =>
      attachment.type === "image"
        ? [{ _tag: "attachment" as const, attachmentId: attachment.id }]
        : [],
    ),
  );
}

export function QueuedRunsControl({
  ref,
  ...props
}: {
  readonly ref?: Ref<QueuedRunsControlHandle>;
  readonly steerShortcutLabel?: string | null;
  readonly editShortcutLabel?: string | null;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly optimisticMessages: ReadonlyArray<
    Pick<ChatMessage, "id" | "inputIntent" | "text" | "attachments">
  >;
  readonly editingRunId: RunId | null;
  /** Set while something else holds the composer, such as an open question. */
  readonly editBlockedReason: string | null;
  readonly onEditQueuedRun: (request: EditQueuedRunRequest) => void;
  readonly onCancelEdit: () => void;
  readonly timestampFormat: TimestampFormat;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const threadRef = scopeThreadRef(props.environmentId, props.threadId);
  const projection = useThreadProjection(threadRef)?.projection;
  const threadSequence = useAtomValue(environmentThreadDetails.sequenceAtom(threadRef));
  const promote = useAtomCommand(threadEnvironment.promoteQueuedRun);
  const resume = useAtomCommand(threadEnvironment.resumeThreadQueue);
  const cancel = useAtomCommand(threadEnvironment.cancelQueuedRun);
  const reorder = useAtomCommand(threadEnvironment.reorderQueuedRun);
  const [pendingOrder, setPendingOrder] = useState<PendingQueuedRunOrder | null>(null);
  const [draggingId, setDraggingId] = useState<UniqueIdentifier | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const [showAll, setShowAll] = useState(false);
  const queueListId = useId();
  const [busyRunId, setBusyRunId] = useState<RunId | null>(null);
  const steerInFlightRef = useRef(false);
  // Run-only acknowledgements can resurrect pending rows after cancellation or startup.
  const acknowledgedMessageIds = new Set((projection?.messages ?? []).map((message) => message.id));
  const queuedImageAttachmentResources = queuedImageResources(projection);
  const queuedImageAttachmentUrls = useAssetUrls(
    props.environmentId,
    queuedImageAttachmentResources,
  );
  const workflow = projection ? deriveThreadQueueWorkflowState(projection) : null;
  const serverQueued = workflow?.queuedRuns ?? [];
  const shownOrder = shownQueuedRunOrder(pendingOrder, {
    order: serverQueued.map(({ run }) => run.id),
    sequence: threadSequence,
  });
  // Dropped during render so a stale order never outlives the reorder it was for.
  if (pendingOrder !== null && shownOrder === null) setPendingOrder(null);
  const queuedById = new Map(serverQueued.map((entry) => [entry.run.id, entry]));
  const queued =
    shownOrder === null ? serverQueued : shownOrder.flatMap((id) => queuedById.get(id) ?? []);
  const activeRun = workflow?.activeRun ?? null;
  // A fresh message starts its own turn: it may skip compaction, but not steer into a turn.
  const canSendRun = (freshContext: boolean) =>
    workflow?.canSendNow === true ||
    (workflow?.canPromoteToSteer === true &&
      (!freshContext || workflow.promoteSkipsCompaction === true));
  const queuedImageUrlById = new Map(
    queuedImageAttachmentUrls.flatMap((url, index) => {
      const resource = queuedImageAttachmentResources[index];
      return url && resource ? [[resource.attachmentId, url] as const] : [];
    }),
  );
  const optimisticQueued = props.optimisticMessages.filter(
    (message) => message.inputIntent === "queued_turn" && !acknowledgedMessageIds.has(message.id),
  );
  const items = [
    ...queued.map(({ run, text, attachments, context, message }, serverIndex) => ({
      key: run.id,
      message,
      runId: run.id,
      messageId: run.userMessageId,
      freshContext: run.freshContext === true,
      serverIndex,
      text,
      // A guest's message keeps the guest's words; the owner can cancel it, not rewrite it.
      editable: context?.guest === undefined,
      attachments,
      thumbnails: attachments
        .filter((attachment) => attachment.type === "image")
        .map<QueuedRowThumbnail>((attachment) => ({
          key: attachment.id,
          name: attachment.name,
          url: queuedImageUrlById.get(attachment.id) ?? null,
        })),
      pending: false,
    })),
    ...optimisticQueued.map((message) => ({
      key: message.id,
      message: undefined,
      runId: null,
      messageId: null,
      freshContext: false,
      serverIndex: null,
      text: message.text,
      editable: true,
      attachments: [] as ReadonlyArray<ContractChatAttachment>,
      thumbnails: (message.attachments ?? [])
        .filter(isImageAttachment)
        .map<QueuedRowThumbnail>((attachment) => ({
          key: attachment.id,
          name: attachment.name,
          url: attachment.previewUrl ?? null,
        })),
      pending: true,
    })),
  ];

  const sendQueuedMessage = async (queuedRunId: RunId) => {
    const freshContext = queued.some(
      ({ run }) => run.id === queuedRunId && run.freshContext === true,
    );
    if (!canSendRun(freshContext) || steerInFlightRef.current) return;
    steerInFlightRef.current = true;
    setBusyRunId(queuedRunId);
    if (workflow?.canSendNow) {
      await resume({
        environmentId: props.environmentId,
        input: { threadId: props.threadId, runId: queuedRunId },
      });
    } else if (activeRun !== null) {
      await promote({
        environmentId: props.environmentId,
        input: { threadId: props.threadId, queuedRunId, targetRunId: activeRun.id },
      });
    }
    steerInFlightRef.current = false;
    setBusyRunId(null);
  };

  useImperativeHandle(ref, () => ({
    steerNext(repeat) {
      const next = queued[0];
      if (!next || !canSendRun(next.run.freshContext === true)) return false;
      if (!repeat && busyRunId === null) void sendQueuedMessage(next.run.id);
      return true;
    },
    // Leave the key to caret navigation while editing.
    editLatest(repeat) {
      const latest = queued.at(-1);
      if (
        !latest ||
        latest.context?.guest !== undefined ||
        props.editingRunId !== null ||
        props.editBlockedReason !== null ||
        busyRunId !== null
      ) {
        return false;
      }
      if (!repeat) {
        setShowAll(true);
        props.onEditQueuedRun({
          runId: latest.run.id,
          messageId: latest.run.userMessageId,
          text: latest.text,
          attachments: latest.attachments,
        });
      }
      return true;
    },
  }));

  if (items.length === 0) return null;

  const remove = async (runId: RunId) => {
    setBusyRunId(runId);
    await cancel({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, runId },
    });
    setBusyRunId(null);
  };

  const moveRun = async (runId: RunId, toIndex: number) => {
    const move = moveQueuedRun(
      queued.map(({ run }) => run.id),
      runId,
      toIndex,
    );
    if (move === null) return;
    const submitted: PendingQueuedRunOrder = { order: move.order, sequence: null };
    setPendingOrder(submitted);
    const result = await reorder({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, runId, beforeRunId: move.beforeRunId },
    });
    // A later drop owns the pending order; this result only settles its own.
    setPendingOrder((current) =>
      current !== submitted
        ? current
        : result._tag === "Success"
          ? { ...submitted, sequence: result.value.sequence }
          : null,
    );
  };

  const queuedIndex = (id: UniqueIdentifier) => queued.findIndex(({ run }) => run.id === id);
  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    setDraggingId(null);
    const moving = queued[queuedIndex(active.id)];
    const toIndex = over === null ? -1 : queuedIndex(over.id);
    // The dragged run, or the one it was dropped on, may have started meanwhile.
    if (moving !== undefined && toIndex !== -1) void moveRun(moving.run.id, toIndex);
  };
  const positionLabel = (id: UniqueIdentifier) => `${queuedIndex(id) + 1} of ${queued.length}`;
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up queued message ${positionLabel(active.id)}.`,
    onDragOver: ({ over }) => (over ? `Over position ${positionLabel(over.id)}.` : undefined),
    onDragEnd: ({ over }) =>
      over ? `Moved to position ${positionLabel(over.id)}.` : "Queued message dropped.",
    onDragCancel: () => "Reordering cancelled.",
  };

  const collapsible = items.length > QUEUE_VISIBLE_ROWS;
  const visibleItems = collapsible && !showAll ? items.slice(0, QUEUE_VISIBLE_ROWS - 1) : items;
  const reorderable = queued.length > 1 && busyRunId === null;
  const draggedItem = items.find((item) => item.runId !== null && item.runId === draggingId);

  return (
    <section
      aria-label={`${items.length} queued message${items.length === 1 ? "" : "s"}`}
      data-thread-queue="true"
      // Anchors the sr-only live region; unanchored, it escapes the timeline scroller and makes the chat column scroll.
      className="relative mx-auto flex w-full max-w-(--chat-content-max-width) flex-col gap-2 pb-4"
    >
      <span className="sr-only" aria-live="polite">
        {items.length} queued
      </span>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        // Bounding the whole row to the list would stop a tall message short of a short neighbour.
        modifiers={[restrictToVerticalAxis]}
        // Scrolling would fight the timeline's follow-to-bottom; the queue is short.
        autoScroll={false}
        accessibility={{ announcements }}
        onDragStart={({ active }) => setDraggingId(active.id)}
        onDragEnd={handleDragEnd}
        onDragCancel={() => setDraggingId(null)}
      >
        <SortableContext
          items={visibleItems.flatMap((item) => (item.runId === null ? [] : [item.runId]))}
          strategy={verticalListSortingStrategy}
        >
          <ol className="flex flex-col items-end gap-3" id={queueListId}>
            {visibleItems.map((item, position) => {
              const isEditing = item.runId !== null && item.runId === props.editingRunId;
              return (
                <QueuedRow
                  key={item.key}
                  sortableId={item.key}
                  reorderable={reorderable && item.runId !== null}
                  position={position + 1}
                  count={items.length}
                  environmentId={props.environmentId}
                  message={item.message}
                  previewText={queuedPreviewText(item)}
                  thumbnails={item.thumbnails}
                  isEditing={isEditing}
                  timestampFormat={props.timestampFormat}
                  onOpenThread={props.onOpenThread}
                >
                  {canSendRun(item.freshContext) && !isEditing ? (
                    <>
                      <Tooltip>
                        <TooltipTrigger render={<span className="flex shrink-0" />}>
                          <Button
                            size="xs"
                            variant="ghost-muted"
                            disabled={item.runId === null || busyRunId !== null}
                            onClick={() => {
                              if (item.runId !== null) {
                                void sendQueuedMessage(item.runId);
                              }
                            }}
                          >
                            <ArrowUpIcon />
                            Send now
                          </Button>
                        </TooltipTrigger>
                        <TooltipPopup>
                          {`${workflow?.canSendNow ? "Start a turn with this message" : workflow?.promoteSkipsCompaction ? "Skip compaction and send this message" : "Send into the current turn"}${item.serverIndex === 0 && props.steerShortcutLabel ? ` (${props.steerShortcutLabel})` : ""}`}
                        </TooltipPopup>
                      </Tooltip>
                    </>
                  ) : null}
                  {item.pending ? (
                    <span className="flex items-center gap-1 px-1">
                      <Clock3Icon aria-hidden className="size-3" />
                      Saving
                    </span>
                  ) : null}
                  {isEditing ? (
                    <>
                      <span className="px-1 text-foreground">Editing in the composer</span>
                      <Button
                        size="xs"
                        variant="ghost"
                        aria-label="Cancel editing queued message"
                        onClick={props.onCancelEdit}
                      >
                        Cancel
                      </Button>
                    </>
                  ) : (
                    <>
                      <Tooltip>
                        {/* The span keeps the tooltip, and its reason, on a disabled button. */}
                        <TooltipTrigger render={<span className="flex shrink-0" />}>
                          <Button
                            size="icon-xs"
                            variant="ghost-muted"
                            aria-label="Edit queued message"
                            disabled={
                              item.runId === null ||
                              !item.editable ||
                              busyRunId !== null ||
                              props.editBlockedReason !== null
                            }
                            onClick={() => {
                              if (item.runId !== null && item.messageId !== null) {
                                props.onEditQueuedRun({
                                  runId: item.runId,
                                  messageId: item.messageId,
                                  text: item.text,
                                  attachments: item.attachments,
                                });
                              }
                            }}
                          >
                            <PencilIcon />
                          </Button>
                        </TooltipTrigger>
                        <TooltipPopup>
                          {props.editBlockedReason ??
                            `Edit in the composer${item.serverIndex === queued.length - 1 && props.editShortcutLabel ? ` (${props.editShortcutLabel})` : ""}`}
                        </TooltipPopup>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <Button
                              size="icon-xs"
                              variant="ghost-muted"
                              aria-label="Remove queued message"
                              disabled={item.runId === null || busyRunId !== null}
                              onClick={() => {
                                if (item.runId !== null) void remove(item.runId);
                              }}
                            />
                          }
                        >
                          <XIcon />
                        </TooltipTrigger>
                        <TooltipPopup>Remove from queue</TooltipPopup>
                      </Tooltip>
                    </>
                  )}
                </QueuedRow>
              );
            })}
          </ol>
        </SortableContext>
        {/* Kept apart from the timeline, so the lifted message stays under the pointer while
            streaming text above scrolls the queue, and no transformed ancestor offsets it. */}
        {createPortal(
          <DragOverlay>
            {draggedItem ? (
              <div className="flex w-full flex-col items-end gap-1">
                <QueuedMessage
                  environmentId={props.environmentId}
                  message={draggedItem.message}
                  previewText={queuedPreviewText(draggedItem)}
                  thumbnails={draggedItem.thumbnails}
                  isEditing={draggedItem.runId === props.editingRunId}
                  timestampFormat={props.timestampFormat}
                  onOpenThread={props.onOpenThread}
                  lifted
                  dragHandle={
                    <span className={cn(QUEUE_GRIP_CLASS, "cursor-grabbing")}>
                      <GripVerticalIcon aria-hidden className="size-3.5" />
                    </span>
                  }
                >
                  {null}
                </QueuedMessage>
              </div>
            ) : null}
          </DragOverlay>,
          document.body,
        )}
      </DndContext>
      {collapsible ? (
        <div className="self-end pe-1 text-xs pointer-coarse:[&_[data-slot=inline-button]]:relative pointer-coarse:[&_[data-slot=inline-button]]:after:absolute pointer-coarse:[&_[data-slot=inline-button]]:after:-inset-x-1.5 pointer-coarse:[&_[data-slot=inline-button]]:after:-inset-y-3.5">
          <InlineButton
            tone="muted"
            aria-expanded={showAll}
            aria-controls={queueListId}
            // Keep the composer focused; keyboard activation still works.
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => setShowAll((value) => !value)}
          >
            {showAll ? "Show fewer" : `Show all ${items.length} queued`}
            <ChevronDownIcon
              aria-hidden
              className={cn(
                "size-3.5 transition-transform duration-150 motion-reduce:transition-none",
                showAll && "rotate-180",
              )}
            />
          </InlineButton>
        </div>
      ) : null}
    </section>
  );
}

type QueuedRunMessage = NonNullable<ThreadQueueProjection["messages"][number]>;

function queuedPreviewText(item: {
  readonly text: string;
  readonly thumbnails: ReadonlyArray<QueuedRowThumbnail>;
}): string {
  return isAttachmentOnlyBootstrapPrompt(item.text)
    ? ""
    : assistantCitationsToPlainText(
        replaceComposerContextReferences(item.text, (reference) =>
          reference.kind === "image" && item.thumbnails.length > 0 ? "" : reference.label,
        ),
      ).trim();
}

const QUEUE_GRIP_CLASS =
  "mt-1 flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/70";

/** One queued message in the list; its grip moves it among the other queued messages. */
function QueuedRow({
  sortableId,
  reorderable,
  position,
  count,
  ...messageProps
}: Omit<Parameters<typeof QueuedMessage>[0], "dragHandle" | "lifted"> & {
  readonly sortableId: string;
  readonly reorderable: boolean;
  readonly position: number;
  readonly count: number;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: sortableId, disabled: !reorderable });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      aria-label={`Queued message ${position} of ${count}, not sent`}
      aria-posinset={position}
      aria-setsize={count}
      aria-current={messageProps.isEditing ? "true" : undefined}
      className={cn(
        "group/queued flex w-full flex-col items-end gap-1",
        // The drag overlay carries the message; this marks where it will land.
        isDragging && "opacity-40",
      )}
    >
      <QueuedMessage
        {...messageProps}
        lifted={false}
        dragHandle={
          reorderable ? (
            <button
              type="button"
              ref={setActivatorNodeRef}
              {...attributes}
              {...listeners}
              aria-label={`Reorder queued message ${position} of ${count}`}
              // A mouse drag leaves focus in the composer; the keyboard can still pick it up.
              onMouseDown={(event) => event.preventDefault()}
              className={cn(
                QUEUE_GRIP_CLASS,
                "cursor-grab touch-none opacity-0 transition-opacity duration-200 hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring active:cursor-grabbing group-hover/queued:opacity-100 pointer-coarse:opacity-100",
                isDragging && "opacity-100",
              )}
            >
              <GripVerticalIcon aria-hidden className="size-3.5" />
            </button>
          ) : null
        }
      />
    </li>
  );
}

/** A queued turn wears its sent form's attribution; only the dashed edge and controls differ. */
function QueuedMessage(props: {
  readonly environmentId: EnvironmentId;
  readonly message: QueuedRunMessage | undefined;
  readonly previewText: string;
  readonly thumbnails: ReadonlyArray<QueuedRowThumbnail>;
  readonly isEditing: boolean;
  readonly timestampFormat: TimestampFormat;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly dragHandle: ReactNode;
  /** Being dragged: filled so it reads above the messages it passes. */
  readonly lifted: boolean;
  readonly children: ReactNode;
}) {
  const presentation = props.message ? resolveUserMessagePresentation(props.message) : null;
  const attribution = presentation?.attribution ?? null;
  const scheduledTaskId = presentation?.scheduledTaskId;
  const senderThreadId = props.message?.senderThreadId;
  const [expanded, setExpanded] = useState(false);
  const taskTitle = useScheduledTaskTitle(props.environmentId, scheduledTaskId);
  const senderShell = useQuietThreadShell(
    attribution === "agent" && senderThreadId
      ? { environmentId: props.environmentId, threadId: senderThreadId }
      : null,
  );
  const fold =
    attribution === "automation"
      ? {
          icon: CalendarClockIcon,
          label: "Automation",
          summary: taskTitle ?? props.previewText.split(/\r?\n/, 1)[0] ?? "",
        }
      : attribution === "agent"
        ? {
            icon: MessagesSquareIcon,
            label: senderShell?.title.trim() || "Agent",
            summary: props.previewText.split(/\r?\n/).find((line) => line.trim()) ?? "",
          }
        : null;
  const bodyVisible = fold === null || expanded;

  return (
    <>
      {attribution === "t3code" ? (
        <p className="me-1 text-2xs text-muted-foreground/70">Sent by T3 Code</p>
      ) : null}
      {presentation?.guestName === undefined ? null : (
        <GuestMessageName name={presentation.guestName} />
      )}
      <div className="flex w-full min-w-0 items-start justify-end gap-1">
        {props.dragHandle}
        {/* Dashed and unfilled: a turn that has not been sent yet. */}
        <div
          className={cn(
            "flex min-w-0 max-w-[80%] flex-col rounded-2xl border border-dashed text-sm",
            props.isEditing
              ? "border-primary/60 text-foreground"
              : attribution === "guest"
                ? "border-guest/50 text-muted-foreground"
                : "border-muted-foreground/40 text-muted-foreground",
            fold === null && "px-3 py-2",
            fold !== null && expanded && "w-full",
            props.lifted && "bg-background shadow-md",
          )}
        >
          {fold ? (
            <FoldedMessageHeader
              icon={fold.icon}
              label={fold.label}
              summary={fold.summary}
              expanded={expanded}
              onToggle={() => setExpanded((value) => !value)}
            />
          ) : null}
          {bodyVisible ? (
            <div
              className={cn(
                "flex flex-col gap-2",
                fold !== null && "max-h-96 overflow-auto px-3 pb-2",
              )}
            >
              {props.thumbnails.length > 0 ? (
                <span className="flex flex-wrap items-center gap-1">
                  {props.thumbnails.map((thumbnail) => (
                    <span
                      key={thumbnail.key}
                      className="size-8 overflow-hidden rounded-md border border-border/70 bg-background"
                    >
                      {thumbnail.url ? (
                        <img
                          src={thumbnail.url}
                          alt={thumbnail.name}
                          className="size-full object-cover"
                        />
                      ) : (
                        <span aria-label={thumbnail.name} className="block size-full bg-muted/60" />
                      )}
                    </span>
                  ))}
                </span>
              ) : null}
              {/* In full, like a sent turn: a queued message is read before it is sent. */}
              {props.previewText ? (
                <p className="whitespace-pre-wrap wrap-anywhere">{props.previewText}</p>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
      <div
        className={cn(
          "flex items-center gap-0.5 pe-1 text-xs text-muted-foreground",
          // Unfilled, the controls would smear over the messages the lifted one passes.
          props.lifted && "invisible",
        )}
      >
        {props.message ? (
          <span className="me-1 flex items-center gap-2 px-1 opacity-0 transition-opacity duration-200 pointer-coarse:opacity-100 focus-within:opacity-100 group-hover/queued:opacity-100">
            {attribution === "agent" && senderThreadId ? (
              <InlineButton tone="muted" onClick={() => props.onOpenThread(senderThreadId)}>
                Open thread
              </InlineButton>
            ) : null}
            {scheduledTaskId ? (
              <InlineButton
                tone="muted"
                render={
                  <Link
                    to="/settings/scheduled-tasks"
                    search={{ environmentId: props.environmentId, taskId: scheduledTaskId }}
                  />
                }
              >
                Open automation
              </InlineButton>
            ) : null}
            <TimelineRowTimestamp
              createdAt={DateTime.formatIso(props.message.createdAt)}
              timestampFormat={props.timestampFormat}
              alwaysVisible
            />
          </span>
        ) : null}
        {props.children}
      </div>
    </>
  );
}
