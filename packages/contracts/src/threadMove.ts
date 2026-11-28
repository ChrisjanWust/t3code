import * as Schema from "effect/Schema";

import { GitRefName, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ThreadMoveTarget = Schema.Union([
  /**
   * A new worktree of the thread's project on a new branch. A thread alone in its folder brings
   * its uncommitted changes; otherwise a move out of the project's own checkout starts where a
   * new thread's worktree would, and a split from a shared worktree starts from its commit.
   */
  Schema.TaggedStruct("newWorktree", {}),
  /** An existing worktree of the thread's project, or its own checkout when null. */
  Schema.TaggedStruct("worktree", { worktreePath: Schema.NullOr(TrimmedNonEmptyString) }),
  /** Another project, where a new thread there would start: a new worktree or its own checkout. */
  Schema.TaggedStruct("project", { projectId: ProjectId }),
]);
export type ThreadMoveTarget = typeof ThreadMoveTarget.Type;

export const ThreadMoveInput = Schema.Struct({
  threadId: ThreadId,
  to: ThreadMoveTarget,
});
export type ThreadMoveInput = typeof ThreadMoveInput.Type;

export const ThreadMoveResult = Schema.Struct({
  projectId: ProjectId,
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  branch: Schema.NullOr(GitRefName),
  /** The folder's uncommitted changes came along into the new worktree. */
  changesMoved: Schema.optional(Schema.Boolean),
});
export type ThreadMoveResult = typeof ThreadMoveResult.Type;
