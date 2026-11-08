import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { pinOrderKeyBetween } from "@t3tools/client-runtime/state/thread-sort";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { useThreadActions } from "../../hooks/useThreadActions";
import { readThreadShell } from "../../state/entities";
import type { SidebarThreadSummary } from "../../types";
import { isOpenTab, resolveWorktreeReopenSet } from "./threadTabs.logic";

type ThreadActions = ReturnType<typeof useThreadActions>;

const refOf = (thread: SidebarThreadSummary) => scopeThreadRef(thread.environmentId, thread.id);

function firstFailure<R extends { readonly _tag: string }>(results: readonly R[], fallback: R): R {
  return results.find((result) => result._tag === "Failure") ?? fallback;
}

/**
 * In the tabbed layout a sidebar row stands for its worktree, so row actions apply to the
 * worktree's threads. `membersByRowKey` holds each row's threads, and is empty otherwise.
 */
export function useWorktreeRowActions(membersByRowKey: {
  readonly current: ReadonlyMap<string, readonly SidebarThreadSummary[]>;
}): ThreadActions {
  const actions = useThreadActions();
  const membersOf = (rowKey: string) => membersByRowKey.current.get(rowKey);
  const othersOf = (target: ScopedThreadRef) => {
    const members = membersOf(scopedThreadKey(target));
    if (members === undefined) return undefined;
    return members.filter(
      (thread) => thread.id !== target.threadId || thread.environmentId !== target.environmentId,
    );
  };
  const now = () => new Date().toISOString();

  const settleThread: ThreadActions["settleThread"] = async (target, opts = {}) => {
    const others = othersOf(target);
    if (others === undefined) return actions.settleThread(target, opts);
    const settledAt = opts.settledAt ?? now();
    // Snoozed threads settle too, or they would keep the worktree's row out of Settled.
    const unsettled = others.filter((thread) => thread.settledOverride !== "settled");
    const [lead, ...rest] = await Promise.all([
      actions.settleThread(target, { settledAt }),
      ...unsettled.map((thread) => actions.settleThread(refOf(thread), { settledAt })),
    ]);
    return firstFailure(rest, lead!);
  };

  const unsettleThread: ThreadActions["unsettleThread"] = async (target) => {
    const members = membersOf(scopedThreadKey(target));
    if (members === undefined) return actions.unsettleThread(target);
    const reopen = resolveWorktreeReopenSet(members).filter(
      (thread) => thread.id !== target.threadId,
    );
    const [lead, ...rest] = await Promise.all([
      actions.unsettleThread(target),
      ...reopen.map((thread) => actions.unsettleThread(refOf(thread))),
    ]);
    return firstFailure(rest, lead!);
  };

  const snoozeThread: ThreadActions["snoozeThread"] = async (target, snoozedUntil) => {
    const others = othersOf(target);
    if (others === undefined) return actions.snoozeThread(target, snoozedUntil);
    const current = now();
    const [lead, ...rest] = await Promise.all([
      actions.snoozeThread(target, snoozedUntil),
      ...others
        .filter((thread) => isOpenTab(thread, current))
        .map((thread) => actions.snoozeThread(refOf(thread), snoozedUntil)),
    ]);
    return firstFailure(rest, lead!);
  };

  const unsnoozeThread: ThreadActions["unsnoozeThread"] = async (target) => {
    const others = othersOf(target);
    if (others === undefined) return actions.unsnoozeThread(target);
    const [lead, ...rest] = await Promise.all([
      actions.unsnoozeThread(target),
      ...others
        .filter((thread) => thread.snoozedUntil != null && thread.settledOverride !== "settled")
        .map((thread) => actions.unsnoozeThread(refOf(thread))),
    ]);
    return firstFailure(rest, lead!);
  };

  // A worktree is pinned through its row's thread, so reordering moves one pin.
  const pinThread: ThreadActions["pinThread"] = async (target, opts) => {
    const members = membersOf(scopedThreadKey(target));
    const lead = members?.find((thread) => thread.id === target.threadId);
    if (members === undefined || lead?.settledOverride !== "settled") {
      return actions.pinThread(target, opts);
    }
    // Pinning reopens the thread it pins, so the rest of its settled group reopens too.
    const reopen = resolveWorktreeReopenSet(members).filter((thread) => thread !== lead);
    const [pinned] = await Promise.all([
      actions.pinThread(target, opts),
      ...reopen.map((thread) => actions.unsettleThread(refOf(thread))),
    ]);
    return pinned;
  };

  const unpinOthers = (target: ScopedThreadRef) =>
    Promise.all(
      (othersOf(target) ?? [])
        .filter((thread) => thread.pinnedAt != null)
        .map((thread) => actions.unpinThread(refOf(thread))),
    );
  const unpinThread: ThreadActions["unpinThread"] = async (target) => {
    const result = await actions.unpinThread(target);
    return result._tag === "Failure" ? result : firstFailure(await unpinOthers(target), result);
  };
  // Declining the confirmation succeeds too, so the row's own pin says whether to go on.
  const confirmAndUnpinThread: ThreadActions["confirmAndUnpinThread"] = async (target) => {
    const result = await actions.confirmAndUnpinThread(target);
    if (result._tag === "Success" && readThreadShell(target)?.pinnedAt == null) {
      await unpinOthers(target);
    }
    return result;
  };

  // The worktree's other threads sorting before the moved one would otherwise hold the row in place.
  const reorderWithWorktree = async <R extends { readonly _tag: string }>(
    reorder: (target: ScopedThreadRef, orderKey: string) => Promise<R>,
    sortsBefore: (thread: SidebarThreadSummary, orderKey: string) => boolean,
    target: ScopedThreadRef,
    orderKey: string,
  ): Promise<R> => {
    const result = await reorder(target, orderKey);
    const others = othersOf(target);
    if (others === undefined || result._tag === "Failure") return result;
    const after = pinOrderKeyBetween(orderKey, null);
    if (after === null) return result;
    const rest = await Promise.all(
      others
        .filter((thread) => sortsBefore(thread, orderKey))
        .map((thread) => reorder(refOf(thread), after)),
    );
    return firstFailure(rest, result);
  };
  const reorderPinnedThread: ThreadActions["reorderPinnedThread"] = (target, orderKey) =>
    reorderWithWorktree(
      actions.reorderPinnedThread,
      (thread, key) => thread.pinOrderKey != null && thread.pinOrderKey <= key,
      target,
      orderKey,
    );
  // Unordered active threads sort first.
  const reorderActiveThread: ThreadActions["reorderActiveThread"] = (target, orderKey) => {
    const current = now();
    return reorderWithWorktree(
      actions.reorderActiveThread,
      (thread, key) =>
        isOpenTab(thread, current) &&
        (thread.activeOrderKey == null || thread.activeOrderKey <= key),
      target,
      orderKey,
    );
  };

  // One at a time, so only the last thread off a worktree offers to delete it.
  const archiveThread: ThreadActions["archiveThread"] = async (target, opts) => {
    for (const thread of othersOf(target) ?? []) {
      const result = await actions.archiveThread(refOf(thread));
      if (result._tag === "Failure") return result;
    }
    return actions.archiveThread(target, opts);
  };
  const deleteThread: ThreadActions["deleteThread"] = async (target, opts) => {
    for (const thread of othersOf(target) ?? []) {
      const result = await actions.deleteThread(refOf(thread), opts);
      if (result._tag === "Failure") return result;
    }
    return actions.deleteThread(target, opts);
  };

  return {
    ...actions,
    settleThread,
    unsettleThread,
    snoozeThread,
    unsnoozeThread,
    pinThread,
    unpinThread,
    confirmAndUnpinThread,
    reorderPinnedThread,
    reorderActiveThread,
    archiveThread,
    deleteThread,
  };
}
