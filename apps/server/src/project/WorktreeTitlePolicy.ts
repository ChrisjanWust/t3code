import type {
  OrchestrationV2ConversationMessage,
  ProjectWorktreeTitle,
  ThreadId,
} from "@t3tools/contracts";
import { ATTACHMENT_ONLY_BOOTSTRAP_PROMPT } from "@t3tools/shared/composerContextReferences";

const WORKTREE_TITLE_WINDOW_SIZE = 3;
const WORKTREE_TITLE_IDLE_MS = 20 * 60_000;
const WORKTREE_TITLE_COOLDOWN_MS = 30 * 60_000;

export interface WorktreeTitleCandidate {
  readonly id: ThreadId;
  /** The user's latest own message, in epoch millis; null when they have written none. */
  readonly lastUserMessageAt: number | null;
}

/** The threads a worktree title is written from: the most recently used, newest first. */
export function selectWorktreeTitleWindow<T extends WorktreeTitleCandidate>(
  threads: ReadonlyArray<T>,
): ReadonlyArray<T & { readonly lastUserMessageAt: number }> {
  return threads
    .filter((thread): thread is T & { readonly lastUserMessageAt: number } => {
      return thread.lastUserMessageAt !== null;
    })
    .toSorted((a, b) => b.lastUserMessageAt - a.lastUserMessageAt || a.id.localeCompare(b.id))
    .slice(0, WORKTREE_TITLE_WINDOW_SIZE);
}

function sameThreads(a: ReadonlyArray<ThreadId>, b: ReadonlyArray<ThreadId>): boolean {
  if (a.length !== b.length) return false;
  const sortedB = b.toSorted();
  return a.toSorted().every((id, index) => id === sortedB[index]);
}

/**
 * A background refresh runs when the window holds different threads than the title was written
 * from, the cooldown has passed, and those earlier threads have gone quiet. Threads used side by
 * side stay in one window, so working in parallel never flips the title back and forth.
 */
export function isWorktreeTitleRefreshDue(input: {
  readonly entry:
    | Pick<ProjectWorktreeTitle, "generated" | "manual" | "sourceThreadIds" | "generatedAt">
    | undefined;
  readonly window: ReadonlyArray<WorktreeTitleCandidate>;
  readonly now: number;
}): boolean {
  const { entry, window, now } = input;
  if (window.length === 0) return false;
  if (entry === undefined) return true;
  if (entry.manual !== null) return false;
  if (entry.generated === null) return true;
  if (
    sameThreads(
      window.map((thread) => thread.id),
      entry.sourceThreadIds,
    )
  ) {
    return false;
  }
  if (
    entry.generatedAt !== null &&
    now - Date.parse(entry.generatedAt) < WORKTREE_TITLE_COOLDOWN_MS
  ) {
    return false;
  }
  const sources = new Set(entry.sourceThreadIds);
  return window.every(
    (thread) =>
      !sources.has(thread.id) ||
      (thread.lastUserMessageAt !== null &&
        now - thread.lastUserMessageAt >= WORKTREE_TITLE_IDLE_MS),
  );
}

/** Only what the user wrote: no agent or scheduled messages, and no attachment-only placeholder. */
export function worktreeTitleRequests(
  messages: ReadonlyArray<
    Pick<OrchestrationV2ConversationMessage, "role" | "createdBy" | "streaming" | "text">
  >,
): ReadonlyArray<string> {
  return messages
    .filter(
      (message) =>
        message.role === "user" &&
        message.createdBy === "user" &&
        !message.streaming &&
        message.text.trim() !== ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
    )
    .map((message) => message.text);
}
