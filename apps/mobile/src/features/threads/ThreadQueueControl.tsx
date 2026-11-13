import { type StaticScreenProps, useNavigation } from "@react-navigation/native";
import { useAtomValue } from "@effect/atom-react";
import {
  makeQueuedRunsAtom,
  queuedRunEditBlockedReason,
} from "@t3tools/client-runtime/queued-run-edit";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  moveQueuedRun,
  type PendingQueuedRunOrder,
  shownQueuedRunOrder,
} from "@t3tools/client-runtime/state/thread-workflows";
import { resolveUserMessagePresentation } from "@t3tools/client-runtime/user-message";
import type { ChatAttachment, EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { Image } from "expo-image";
import * as Haptics from "expo-haptics";
import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import Reanimated, { ReduceMotion, useAnimatedStyle, withTiming } from "react-native-reanimated";
import ReanimatedSwipeable, {
  type SwipeableMethods,
} from "react-native-gesture-handler/ReanimatedSwipeable";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "../../components/ui/Button";
import { DragHandle } from "../../components/ui/DragHandle";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Menu } from "../../components/ui/Menu";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { cn } from "../../lib/cn";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { useAssetUrl } from "../../state/assets";
import { useQuietThreadShell } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { assetImageSource } from "../../lib/assetImageSource";
import { beginQueuedRunEdit, useQueuedRunEdit } from "../../state/queued-run-edit";
import { environmentThreadDetails, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  REMOVE_QUEUED_MESSAGE_ACCESSIBILITY_LABEL,
  buildCancelQueuedRunCommand,
  resolveThreadQueueRowControls,
} from "./threadQueueControlPresentation";

const REMOVE_ACTION_WIDTH = 76;
const THUMBNAIL_LIMIT = 3;
const EMPTY_QUEUED_COUNT_ATOM = Atom.make(0).pipe(
  Atom.withLabel("mobile-thread-queue-count:empty"),
);

type QueueTarget = { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };
type QueueAction = "steer" | "edit" | "remove";

function useThreadQueueWorkflow(target: QueueTarget) {
  return useAtomValue(environmentThreadDetails.queueWorkflowAtom(target));
}

export function useThreadQueuedCount(target: QueueTarget | null) {
  return useAtomValue(
    target === null ? EMPTY_QUEUED_COUNT_ATOM : environmentThreadDetails.queuedCountAtom(target),
  );
}

type QueuedRunMessage = NonNullable<
  NonNullable<ReturnType<typeof useThreadQueueWorkflow>>["queuedRuns"][number]["message"]
>;

/** Who sent a queued message, as its sent form shows it in the thread. */
function QueuedRunSender(props: {
  readonly environmentId: EnvironmentId;
  readonly message: QueuedRunMessage;
}) {
  const { attribution, scheduledTaskId } = resolveUserMessagePresentation(props.message);
  const senderThreadId = attribution === "agent" ? props.message.senderThreadId : undefined;
  const senderShell = useQuietThreadShell(
    senderThreadId ? scopeThreadRef(props.environmentId, senderThreadId) : null,
  );
  const tasks = useEnvironmentQuery(
    scheduledTaskId
      ? serverEnvironment.scheduledTasksLive({ environmentId: props.environmentId, input: {} })
      : null,
  );
  const sender =
    attribution === "automation"
      ? {
          icon: "calendar.badge.clock" as const,
          label:
            tasks.data?.tasks.find((task) => task.id === scheduledTaskId)?.title ?? "Automation",
        }
      : attribution === "agent"
        ? {
            icon: "bubble.left.and.bubble.right" as const,
            label: senderShell?.title.trim() || "Agent",
          }
        : attribution === "t3code"
          ? { icon: null, label: "Sent by T3 Code" }
          : null;
  if (sender === null) return null;
  return (
    <View className="flex-row items-center gap-1">
      {sender.icon ? (
        <SymbolView
          name={sender.icon}
          size={11}
          weight="medium"
          tintColorClassName="accent-foreground-muted"
          type="monochrome"
        />
      ) : null}
      <Text
        numberOfLines={1}
        className="min-w-0 shrink font-t3-medium text-2xs text-foreground-muted"
      >
        {sender.label}
      </Text>
    </View>
  );
}

export function ThreadQueueSheet({ route }: StaticScreenProps<QueueTarget>) {
  const theme = useUniwindTheme();
  const target = route.params;
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const workflow = useThreadQueueWorkflow(target);
  const threadKey = scopedThreadKey(target.environmentId, target.threadId);
  const editing = useQueuedRunEdit(threadKey);
  const pendingRequests = useAtomValue(environmentThreadDetails.pendingRequestsAtom(target));
  const editBlockedReason = queuedRunEditBlockedReason({
    openQuestionCount: pendingRequests?.userInputs.length ?? 0,
  });
  const promote = useAtomCommand(threadEnvironment.promoteQueuedRun, "promote queued message");
  const cancel = useAtomCommand(threadEnvironment.cancelQueuedRun, "remove queued message");
  const resume = useAtomCommand(threadEnvironment.resumeThreadQueue, "resume queue");
  const reorder = useAtomCommand(threadEnvironment.reorderQueuedRun, "reorder queued message");
  const threadSequence = useAtomValue(environmentThreadDetails.sequenceAtom(target));
  const [pendingOrder, setPendingOrder] = useState<PendingQueuedRunOrder | null>(null);
  const [drag, setDrag] = useState<{
    readonly runId: RunId;
    readonly translation: number;
    /** The queue order the drag measures its rows from. */
    readonly orderKey: string;
  } | null>(null);
  const [heights, setHeights] = useState<ReadonlyMap<RunId, number>>(() => new Map());
  // Remount dropped rows so data order and cleared drag offsets change together without flashing.
  const [drops, setDrops] = useState(0);
  const [resuming, setResuming] = useState(false);
  const [busyRunId, setBusyRunId] = useState<RunId | null>(null);
  const busyRef = useRef(false);
  const serverQueuedRuns = workflow?.queuedRuns ?? [];
  const shownOrder = shownQueuedRunOrder(pendingOrder, {
    order: serverQueuedRuns.map(({ run }) => run.id),
    sequence: threadSequence,
  });
  // Dropped during render so a stale order never outlives the reorder it was for.
  if (pendingOrder !== null && shownOrder === null) setPendingOrder(null);
  const queuedById = new Map(serverQueuedRuns.map((entry) => [entry.run.id, entry]));
  const queuedRuns =
    shownOrder === null ? serverQueuedRuns : shownOrder.flatMap((id) => queuedById.get(id) ?? []);
  const order = queuedRuns.map(({ run }) => run.id);

  const hadQueuedRuns = useRef(queuedRuns.length > 0);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pops the navigator once the server-side queue empties after it had runs
  useEffect(() => {
    if (queuedRuns.length > 0) {
      hadQueuedRuns.current = true;
      return;
    }
    if (hadQueuedRuns.current) navigation.goBack();
  }, [navigation, queuedRuns.length]);

  const act = async (runId: RunId, action: QueueAction) => {
    if (busyRef.current) return;
    const index = queuedRuns.findIndex(({ run }) => run.id === runId);
    if (index < 0) return;
    if (action === "edit") {
      if (editBlockedReason !== null) return;
      const entry = queuedRuns[index]!;
      void Haptics.selectionAsync();
      beginQueuedRunEdit(
        threadKey,
        {
          runId,
          messageId: entry.messageId,
          originalText: entry.text,
          existingAttachments: entry.attachments,
          ...(entry.context ? { context: entry.context } : {}),
        },
        makeQueuedRunsAtom({
          threadId: target.threadId,
          snapshot: threadEnvironment.snapshotAtom(target.environmentId),
          detailStatus: environmentThreadDetails.statusAtom(target),
          runs: Atom.make(
            (get) => get(environmentThreadDetails.quietThreadAtom(target))?.projection.runs ?? null,
          ),
        }),
      );
      navigation.goBack();
      return;
    }
    if (action !== "steer" && action !== "remove") return;
    busyRef.current = true;
    setBusyRunId(runId);
    void Haptics.selectionAsync();
    if (action === "remove") {
      await cancel(buildCancelQueuedRunCommand({ ...target, runId }));
    } else if (workflow?.canSendNow) {
      await resume({ ...target, input: { threadId: target.threadId, runId } });
    } else if (workflow?.activeRun && workflow.canPromoteToSteer) {
      await promote({
        ...target,
        input: {
          threadId: target.threadId,
          queuedRunId: runId,
          targetRunId: workflow.activeRun.id,
        },
      });
    }
    busyRef.current = false;
    setBusyRunId(null);
  };

  const moveRun = async (runId: RunId, toIndex: number) => {
    const move = moveQueuedRun(order, runId, toIndex);
    if (move === null || busyRef.current) return;
    void Haptics.selectionAsync();
    const submitted: PendingQueuedRunOrder = { order: move.order, sequence: null };
    setPendingOrder(submitted);
    const result = await reorder({
      ...target,
      input: { threadId: target.threadId, runId, beforeRunId: move.beforeRunId },
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
  const dropIndex = (from: number, translation: number) => {
    const step = translation > 0 ? 1 : -1;
    let to = from;
    let remaining = Math.abs(translation);
    while (to + step >= 0 && to + step < order.length) {
      const next = heights.get(order[to + step]!) ?? 0;
      if (next === 0 || remaining < next / 2) break;
      remaining -= next;
      to += step;
    }
    return to;
  };
  // A queue that changed under the drag, such as its head starting, ends the drag: the rows it
  // measured from have moved.
  const orderKey = order.join("\n");
  const activeDrag = drag !== null && drag.orderKey === orderKey ? drag : null;
  const dragFrom = activeDrag === null ? -1 : order.indexOf(activeDrag.runId);
  const dragTo = activeDrag === null ? -1 : dropIndex(dragFrom, activeDrag.translation);
  const liftedHeight = dragFrom === -1 ? 0 : (heights.get(order[dragFrom]!) ?? 0);

  const content = (
    <ScrollView
      nestedScrollEnabled
      className="flex-1"
      // UIKit must inset content beneath the floating translucent iOS header.
      contentInsetAdjustmentBehavior="automatic"
      contentContainerClassName="px-5 pb-6"
      contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}
    >
      {workflow?.isHeld && queuedRuns.length > 0 ? (
        <View className="gap-2 py-3">
          <Text className="text-sm text-foreground-muted">Queue paused</Text>
          <Button
            label="Resume queue"
            disabled={resuming || busyRunId !== null}
            onPress={async () => {
              if (busyRef.current) return;
              busyRef.current = true;
              setResuming(true);
              await resume({ ...target, input: { threadId: target.threadId } });
              busyRef.current = false;
              setResuming(false);
            }}
          />
        </View>
      ) : null}
      {editBlockedReason !== null && queuedRuns.length > 0 ? (
        <Text className="py-3 text-sm text-foreground-muted">{editBlockedReason}</Text>
      ) : null}
      {queuedRuns.length === 0 ? (
        <Text className="pt-6 text-center text-sm text-foreground-muted">
          No messages waiting in this queue.
        </Text>
      ) : null}
      {queuedRuns.map(({ run, text, attachments, context, message }, index) => {
        const controls = resolveThreadQueueRowControls({
          busy: busyRunId !== null,
          // A fresh message starts its own turn: it may skip compaction, but not steer into a turn.
          canPromoteToSteer:
            (workflow?.canPromoteToSteer ?? false) &&
            (run.freshContext !== true || workflow?.promoteSkipsCompaction === true),
          canSendNow: workflow?.canSendNow ?? false,
          editBlocked: editBlockedReason !== null,
          isEditing: editing?.runId === run.id,
          isGuestMessage: context?.guest !== undefined,
          text,
        });
        const title =
          controls.displayText || (attachments.length > 0 ? "Attachments" : "Queued message");
        const lifted = index === dragFrom;
        const shift =
          dragFrom === -1 || lifted
            ? 0
            : dragFrom < dragTo && index > dragFrom && index <= dragTo
              ? -liftedHeight
              : dragFrom > dragTo && index < dragFrom && index >= dragTo
                ? liftedHeight
                : 0;
        return (
          <QueueDragRow
            key={`${run.id}:${drops}`}
            offset={lifted ? (activeDrag?.translation ?? 0) : shift}
            lifted={lifted}
            onHeight={(height) =>
              setHeights((current) =>
                current.get(run.id) === height ? current : new Map(current).set(run.id, height),
              )
            }
          >
            <QueueRowSwipeable
              enabled={busyRunId === null && controls.canDismiss && dragFrom === -1}
              background={theme["--color-sheet"]}
              onRemove={() => void act(run.id, "remove")}
            >
              <View className="flex-row items-center">
                <Menu
                  accessibilityLabel={`Actions for queued message ${index + 1}`}
                  shouldOpenOnLongPress
                  style={{ flex: 1 }}
                  actions={[
                    ...(workflow?.canPromoteToSteer || workflow?.canSendNow
                      ? [
                          {
                            id: "steer",
                            title: "Send now",
                            attributes: { disabled: !controls.canSend },
                            image: "arrow.up",
                          },
                        ]
                      : []),
                    {
                      id: "edit",
                      title: "Edit",
                      attributes: { disabled: !controls.canEdit },
                      image: "pencil",
                    },
                    {
                      id: "remove",
                      title: "Remove",
                      attributes: { disabled: !controls.canDismiss, destructive: true },
                    },
                  ]}
                  onPressAction={({ nativeEvent }) =>
                    void act(run.id, nativeEvent.event as QueueAction)
                  }
                >
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={title}
                    accessibilityHint={
                      controls.canEdit
                        ? "Opens this message in the composer for editing"
                        : (editBlockedReason ?? undefined)
                    }
                    disabled={!controls.canEdit}
                    onPress={() => void act(run.id, "edit")}
                    className="min-h-14 flex-row items-center gap-2.5 py-2.5 active:opacity-70"
                  >
                    <QueueAttachmentThumbnails
                      environmentId={target.environmentId}
                      attachments={attachments}
                    />
                    <View className="min-w-0 flex-1 gap-0.5">
                      {message ? (
                        <QueuedRunSender environmentId={target.environmentId} message={message} />
                      ) : null}
                      <Text
                        className={
                          controls.isEditing
                            ? "text-sm text-foreground-muted"
                            : "text-sm text-foreground"
                        }
                        numberOfLines={1}
                      >
                        {context?.guest === undefined ? null : (
                          <Text className="font-t3-medium text-adaptive-fuchsia-600-300">
                            {`${context.guest.name}  `}
                          </Text>
                        )}
                        {title}
                      </Text>
                    </View>
                    {controls.isEditing ? (
                      <Text className="shrink-0 text-2xs uppercase tracking-wide text-primary">
                        Editing
                      </Text>
                    ) : null}
                  </Pressable>
                </Menu>
                {workflow?.canPromoteToSteer || workflow?.canSendNow ? (
                  // Outside the edit row and full row height, so a near miss never opens the editor.
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Send now, queued message ${index + 1}`}
                    disabled={!controls.canSend}
                    onPress={() => void act(run.id, "steer")}
                    className="shrink-0 justify-center self-stretch pl-4 active:opacity-70 disabled:opacity-40"
                  >
                    <View className="min-h-9 flex-row items-center gap-1.5 rounded-full bg-primary px-4">
                      <SymbolView
                        name="arrow.up"
                        size={13}
                        tintColorClassName="accent-primary-foreground"
                      />
                      <Text className="font-t3-medium text-sm text-primary-foreground">
                        Send now
                      </Text>
                    </View>
                  </Pressable>
                ) : null}
                {queuedRuns.length > 1 ? (
                  <DragHandle
                    title={`queued message ${index + 1}`}
                    canMoveUp={index > 0}
                    canMoveDown={index < queuedRuns.length - 1}
                    onStart={() => {
                      void Haptics.selectionAsync();
                      setDrag({ runId: run.id, translation: 0, orderKey });
                    }}
                    onMove={(translation) =>
                      setDrag((current) => (current === null ? null : { ...current, translation }))
                    }
                    onEnd={(translation, cancelled) => {
                      setDrag(null);
                      setDrops((count) => count + 1);
                      if (!cancelled && activeDrag !== null) {
                        void moveRun(run.id, dropIndex(index, translation));
                      }
                    }}
                    onStep={(direction) =>
                      void moveRun(run.id, direction === "up" ? index - 1 : index + 1)
                    }
                  />
                ) : null}
              </View>
            </QueueRowSwipeable>
          </QueueDragRow>
        );
      })}
    </ScrollView>
  );

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <View collapsable={false} className="flex-1 bg-sheet">
        <SheetHeader title="Queued" onClose={() => navigation.goBack()} />
        <ScreenContent>{content}</ScreenContent>
      </View>
    </GestureHandlerRootView>
  );
}

/** A queue row that follows the drag while lifted and slides aside for the lifted row. */
function QueueDragRow(props: {
  readonly offset: number;
  readonly lifted: boolean;
  readonly onHeight: (height: number) => void;
  readonly children: React.ReactNode;
}) {
  const { lifted, offset } = props;
  const style = useAnimatedStyle(() => ({
    transform: [
      {
        translateY: lifted
          ? offset
          : withTiming(offset, { duration: 160, reduceMotion: ReduceMotion.System }),
      },
    ],
    zIndex: lifted ? 1 : 0,
  }));
  return (
    <Reanimated.View
      style={style}
      onLayout={(event) => props.onHeight(event.nativeEvent.layout.height)}
      className={cn("flex-row items-center border-b border-border bg-sheet", lifted && "shadow-md")}
    >
      {props.children}
    </Reanimated.View>
  );
}

function QueueRowSwipeable(props: {
  readonly enabled: boolean;
  readonly background: string;
  readonly onRemove: () => void;
  readonly children: React.ReactNode;
}) {
  const swipeableRef = useRef<SwipeableMethods | null>(null);
  return (
    <ReanimatedSwipeable
      ref={swipeableRef}
      enabled={props.enabled}
      friction={2}
      rightThreshold={40}
      overshootRight={false}
      // Require a clearly sideways swipe to avoid competing with sheet scroll.
      failOffsetY={[-12, 12]}
      containerStyle={{ backgroundColor: props.background, flex: 1 }}
      childrenContainerStyle={{ backgroundColor: props.background }}
      onSwipeableOpen={(direction) => {
        if (direction !== "right") return;
        swipeableRef.current?.close();
        props.onRemove();
      }}
      renderRightActions={() => (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={REMOVE_QUEUED_MESSAGE_ACCESSIBILITY_LABEL}
          disabled={!props.enabled}
          onPress={() => {
            swipeableRef.current?.close();
            props.onRemove();
          }}
          className="items-center justify-center bg-danger active:opacity-70 disabled:opacity-40"
          style={{ width: REMOVE_ACTION_WIDTH }}
        >
          <SymbolView name="trash" size={16} tintColorClassName="accent-danger-foreground" />
          <Text className="pt-1 text-2xs font-t3-medium text-danger-foreground">Remove</Text>
        </Pressable>
      )}
    >
      {props.children}
    </ReanimatedSwipeable>
  );
}

function QueueAttachmentThumbnails(props: {
  readonly environmentId: EnvironmentId;
  readonly attachments: ReadonlyArray<ChatAttachment>;
}) {
  const images = props.attachments.filter((attachment) => attachment.mimeType.startsWith("image/"));
  const shown = images.slice(0, THUMBNAIL_LIMIT);
  const overflow = props.attachments.length - shown.length;
  if (props.attachments.length === 0) return null;
  return (
    <View className="shrink-0 flex-row items-center gap-1">
      {shown.map((attachment) => (
        <QueueAttachmentThumbnail
          key={attachment.id}
          environmentId={props.environmentId}
          attachment={attachment}
        />
      ))}
      {overflow > 0 ? (
        <View className="h-6 min-w-6 items-center justify-center rounded bg-subtle px-1">
          <Text className="text-2xs tabular-nums text-foreground-muted">
            {shown.length === 0 ? `${overflow}` : `+${overflow}`}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

function QueueAttachmentThumbnail(props: {
  readonly environmentId: EnvironmentId;
  readonly attachment: ChatAttachment;
}) {
  const resource = {
    _tag: "attachment",
    attachmentId: props.attachment.id,
    fileName: props.attachment.name,
    mimeType: props.attachment.mimeType,
    disposition: "inline",
  } as const;
  const url = useAssetUrl(props.environmentId, resource);
  if (url === null) {
    return <View className="h-6 w-6 rounded bg-subtle" />;
  }
  return (
    <Image
      source={assetImageSource(props.environmentId, resource, url)}
      cachePolicy="memory-disk"
      contentFit="cover"
      style={{ width: 24, height: 24, borderRadius: 4 }}
      accessibilityIgnoresInvertColors
    />
  );
}
