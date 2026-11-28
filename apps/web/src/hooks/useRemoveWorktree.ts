import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthSourceControlWriteScope,
  EnvironmentAuthorizationError,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { msg } from "gt-react";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { m } from "../i18n/messages";
import { readEnvironmentScope } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";
import { vcsEnvironment } from "../state/vcs";
import { formatWorktreePathForDisplay } from "../worktreeCleanup";

/**
 * Force-removes a worktree its last thread has left. A failure gets its own toast: the delete or
 * move that emptied the worktree has already succeeded.
 */
export function useRemoveWorktree() {
  const removeWorktree = useAtomCommand(vcsEnvironment.removeWorktree, { reportFailure: false });
  const refreshVcsStatus = useAtomCommand(vcsEnvironment.refreshStatus, { reportFailure: false });

  return async (input: {
    readonly environmentId: EnvironmentId;
    readonly projectCwd: string;
    readonly worktreePath: string;
  }) => {
    const removeResult = readEnvironmentScope(input.environmentId, AuthSourceControlWriteScope)
      ? await removeWorktree({
          environmentId: input.environmentId,
          input: { cwd: input.projectCwd, path: input.worktreePath, force: true },
        })
      : AsyncResult.failure(
          Cause.fail(
            new EnvironmentAuthorizationError({
              message: m(msg("This connection can no longer remove worktrees.")),
              requiredScope: AuthSourceControlWriteScope,
            }),
          ),
        );
    const refreshResult =
      removeResult._tag === "Success"
        ? await refreshVcsStatus({
            environmentId: input.environmentId,
            input: { cwd: input.projectCwd },
          })
        : null;
    const cleanupFailure =
      removeResult._tag === "Failure"
        ? removeResult
        : refreshResult?._tag === "Failure"
          ? refreshResult
          : null;
    if (!cleanupFailure) return;
    const removalFailed = removeResult._tag === "Failure";
    const error = squashAtomCommandFailure(cleanupFailure);
    const message = thrownErrorMessage(error, m) ?? m(msg("An error occurred."));
    console.error("Worktree cleanup failed", { ...input, error });
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: removalFailed
          ? m(msg("Failed to delete worktree"))
          : m(msg("Worktree deleted, but Git status refresh failed")),
        description: removalFailed
          ? m(
              msg("Could not remove {path}. {message}", {
                path: formatWorktreePathForDisplay(input.worktreePath),
                message,
              }),
            )
          : message,
      }),
    );
  };
}
