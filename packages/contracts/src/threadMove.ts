import * as Schema from "effect/Schema";

import { GitRefName, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ThreadMoveTarget = Schema.Union([
  /** A new worktree of the thread's project, on a new branch from the commit its folder is on. */
  Schema.TaggedStruct("newWorktree", {}),
  /** An existing worktree of the thread's project, or its own checkout when null. */
  Schema.TaggedStruct("worktree", { worktreePath: Schema.NullOr(TrimmedNonEmptyString) }),
  /** Another project's own checkout. */
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
});
export type ThreadMoveResult = typeof ThreadMoveResult.Type;
