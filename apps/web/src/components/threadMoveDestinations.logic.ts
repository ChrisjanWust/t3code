import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { isPickableProjectMember } from "@t3tools/client-runtime/state/project-grouping";
import { threadCreatedAtMs } from "@t3tools/client-runtime/state/thread-sort";
import { isListedThreadLineage, type ProjectWorktreeTitle } from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../i18n/messages";
import type { SidebarProjectSnapshot } from "../sidebarProjectGrouping";
import type { Project } from "../types";
import type { ThreadMoveDestination } from "./threadMoveMenu.logic";
import { worktreeLabel } from "./threadTabs/threadTabs.logic";

/** Whether another open thread works in the thread's folder. Its own side chats do not count. */
export function threadSharesFolder(
  thread: EnvironmentThreadShell,
  threads: ReadonlyArray<EnvironmentThreadShell>,
): boolean {
  return threads.some(
    (other) =>
      other.id !== thread.id &&
      other.environmentId === thread.environmentId &&
      other.projectId === thread.projectId &&
      other.archivedAt === null &&
      isListedThreadLineage(other.lineage) &&
      other.worktreePath === thread.worktreePath,
  );
}

/**
 * A new worktree first, unless the thread already has one to itself, then the project's own
 * checkout and the worktrees that still have open threads, newest first.
 */
export function resolveWorktreeDestinations(
  thread: EnvironmentThreadShell,
  threads: ReadonlyArray<EnvironmentThreadShell>,
  worktreeTitles: ReadonlyArray<ProjectWorktreeTitle> | undefined,
  resolve: MessageResolver = m,
): ThreadMoveDestination[] {
  const byPath = new Map<string | null, EnvironmentThreadShell[]>();
  for (const candidate of threads) {
    if (
      candidate.environmentId !== thread.environmentId ||
      candidate.projectId !== thread.projectId ||
      candidate.archivedAt !== null ||
      !isListedThreadLineage(candidate.lineage) ||
      (candidate.worktreePath === null && candidate.creatingWorktree === true)
    ) {
      continue;
    }
    byPath.set(candidate.worktreePath, [...(byPath.get(candidate.worktreePath) ?? []), candidate]);
  }
  const destinations: ThreadMoveDestination[] = [];
  const shared = (byPath.get(thread.worktreePath) ?? []).some((member) => member.id !== thread.id);
  // No branch means no git repository or a detached checkout, which can't start a worktree.
  if (thread.branch !== null && (thread.worktreePath === null || shared)) {
    destinations.push({
      label: resolve(msg("New worktree")),
      detail: null,
      to: { _tag: "newWorktree" },
    });
  }
  if (thread.worktreePath !== null) {
    const mainBranch = byPath.get(null)?.find((member) => member.branch)?.branch ?? null;
    destinations.push({
      label: resolve(msg("Main", { $context: "the project's own checkout, not a worktree" })),
      detail: mainBranch === "main" || mainBranch === "master" ? null : mainBranch,
      to: { _tag: "worktree", worktreePath: null },
    });
  }
  const worktrees = [...byPath].flatMap(([worktreePath, members]) =>
    worktreePath === null ||
    worktreePath === thread.worktreePath ||
    members.every((member) => member.settledOverride === "settled")
      ? []
      : [{ worktreePath, members, createdAt: Math.min(...members.map(threadCreatedAtMs)) }],
  );
  for (const { worktreePath, members } of worktrees.sort((a, b) => b.createdAt - a.createdAt)) {
    const [first] = members;
    if (!first) continue;
    destinations.push({
      label: worktreeLabel(first, worktreeTitles, members, resolve),
      detail: first.branch,
      to: { _tag: "worktree", worktreePath },
    });
  }
  return destinations;
}

/**
 * The sidebar's projects on the thread's environment, in its order. Checkouts grouped under one
 * name also show their folder.
 */
export function resolveProjectDestinations(
  groups: ReadonlyArray<SidebarProjectSnapshot>,
  thread: Pick<EnvironmentThreadShell, "environmentId" | "projectId">,
  isScratch: (project: Project) => boolean,
): ThreadMoveDestination[] {
  return groups.flatMap((group) => {
    if (group.archived) return [];
    const members = group.memberProjects.filter(
      (project) =>
        project.environmentId === thread.environmentId &&
        isPickableProjectMember(project) &&
        !isScratch(project),
    );
    return members.flatMap((project) =>
      project.id === thread.projectId
        ? []
        : [
            {
              label: group.displayName,
              detail: members.length > 1 ? project.workspaceRoot : null,
              to: { _tag: "project" as const, projectId: project.id },
            },
          ],
    );
  });
}
