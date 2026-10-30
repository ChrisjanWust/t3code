import type {
  OrchestrationV2ConversationMessage,
  ProjectWorktreeTitle,
  ThreadId,
} from "@t3tools/contracts";
import { ATTACHMENT_ONLY_BOOTSTRAP_PROMPT } from "@t3tools/shared/composerContextReferences";

const WORKTREE_TITLE_WINDOW_SIZE = 3;
const WORKTREE_TITLE_IDLE_MS = 20 * 60_000;
export const WORKTREE_TITLE_COOLDOWN_MS = 30 * 60_000;
const WORKTREE_TITLE_MAX_REQUEST = 400;
const WORKTREE_TITLE_MAX_REPLY = 600;
const WORKTREE_TITLE_MAX_CONTEXT = 4_000;

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
    | Pick<ProjectWorktreeTitle, "manual" | "sourceThreadIds" | "updatedAt">
    | undefined;
  readonly window: ReadonlyArray<WorktreeTitleCandidate>;
  readonly now: number;
}): boolean {
  const { entry, window, now } = input;
  if (window.length === 0) return false;
  if (entry === undefined) return true;
  if (entry.manual !== null) return false;
  if (
    sameThreads(
      window.map((thread) => thread.id),
      entry.sourceThreadIds,
    )
  ) {
    return false;
  }
  if (now - Date.parse(entry.updatedAt) < WORKTREE_TITLE_COOLDOWN_MS) return false;
  const sources = new Set(entry.sourceThreadIds);
  return window.every(
    (thread) =>
      !sources.has(thread.id) ||
      (thread.lastUserMessageAt !== null &&
        now - thread.lastUserMessageAt >= WORKTREE_TITLE_IDLE_MS),
  );
}

export interface WorktreeTitleExcerpt {
  readonly from: "user" | "agent";
  readonly text: string;
}

const flatten = (text: string) =>
  text
    .replace(/\[([^\]]*)\]\([^)\s]*\)/g, "$1")
    .replace(/[|*`]|-{3,}/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * A thread's first and latest two user requests, plus the agent's first and latest turn-final
 * replies, which say what a vague request or link was about. Tool output and delegated or
 * scheduled messages are left out.
 */
export function worktreeTitleExcerpts(
  messages: ReadonlyArray<
    Pick<
      OrchestrationV2ConversationMessage,
      "role" | "createdBy" | "scheduledTaskId" | "streaming" | "text" | "runId"
    >
  >,
): ReadonlyArray<WorktreeTitleExcerpt> {
  const requests: Array<number> = [];
  const finalReplyByRun = new Map<string, number>();
  for (const [index, message] of messages.entries()) {
    if (message.streaming || flatten(message.text) === "") continue;
    if (
      message.role === "user" &&
      message.createdBy === "user" &&
      message.scheduledTaskId === undefined &&
      message.text.trim() !== ATTACHMENT_ONLY_BOOTSTRAP_PROMPT
    ) {
      requests.push(index);
    } else if (message.role === "assistant" && message.runId !== null) {
      finalReplyByRun.set(message.runId, index);
    }
  }
  const replies = [...finalReplyByRun.values()].toSorted((a, b) => a - b);
  const picked = new Set([
    ...requests.slice(0, 1),
    ...requests.slice(-2),
    ...replies.slice(0, 1),
    ...replies.slice(-1),
  ]);
  return [...picked]
    .toSorted((a, b) => a - b)
    .map((index) => ({
      from: messages[index]!.role === "user" ? "user" : "agent",
      text: flatten(messages[index]!.text),
    }));
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** Newest threads come first, so the total cap trims the oldest. */
export function formatWorktreeTitleContext(
  threads: ReadonlyArray<{
    readonly title: string;
    readonly excerpts: ReadonlyArray<WorktreeTitleExcerpt>;
  }>,
): string {
  const lines: Array<string> = [];
  for (const [index, thread] of threads.entries()) {
    if (index > 0) lines.push("");
    lines.push(`Thread ${index + 1}: ${JSON.stringify(thread.title)}`);
    for (const excerpt of thread.excerpts) {
      lines.push(
        excerpt.from === "user"
          ? `User: ${clip(excerpt.text, WORKTREE_TITLE_MAX_REQUEST)}`
          : `Agent: ${clip(excerpt.text, WORKTREE_TITLE_MAX_REPLY)}`,
      );
    }
  }
  return clip(lines.join("\n"), WORKTREE_TITLE_MAX_CONTEXT);
}
