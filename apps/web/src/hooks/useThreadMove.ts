import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  getProjectOrderKey,
  selectProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import {
  AuthSourceControlWriteScope,
  isListedThreadLineage,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { msg } from "gt-react";

import { orderItemsByPreferredIds, sortSidebarV2ProjectGroups } from "../components/Sidebar.logic";
import {
  resolveProjectDestinations,
  resolveWorktreeDestinations,
  threadSharesFolder,
} from "../components/threadMoveDestinations.logic";
import type { ThreadMoveDestination, ThreadMoveMenu } from "../components/threadMoveMenu.logic";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { m } from "../i18n/messages";
import { readLocalApi } from "../localApi";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { buildSidebarProjectSnapshots } from "../sidebarProjectGrouping";
import {
  readDelegatedUnderParent,
  readProject,
  readProjects,
  readThreadShell,
  readThreadShells,
} from "../state/entities";
import { readPrimaryEnvironmentId } from "../state/environments";
import { orchestrationEnvironment } from "../state/orchestration";
import { projectEnvironment } from "../state/projects";
import { environmentServerConfigsAtom } from "../state/server";
import { readEnvironmentScope } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";
import { useAtomQueryRunner } from "../state/use-atom-query-runner";
import { vcsEnvironment } from "../state/vcs";
import { legacyProjectCwdPreferenceKey, useUiStateStore } from "../uiStateStore";
import { formatWorktreePathForDisplay } from "../worktreeCleanup";
import { useRemoveWorktree } from "./useRemoveWorktree";
import { getClientSettings } from "./useSettings";

/** The sidebar's project order, read when a menu opens rather than kept live in every tab. */
function readSidebarProjectGroups() {
  const projects = readProjects();
  const settings = getClientSettings();
  const orderedProjects = orderItemsByPreferredIds({
    items: projects,
    preferredIds: useUiStateStore.getState().projectOrder,
    getId: getProjectOrderKey,
    getPreferenceIds: (project) => [
      getProjectOrderKey(project),
      legacyProjectCwdPreferenceKey(project.workspaceRoot),
    ],
  });
  const groups = buildSidebarProjectSnapshots(
    {
      projects: settings.sidebarProjectSortOrder === "manual" ? orderedProjects : projects,
      groupScratchProjects: true,
      settings: selectProjectGroupingSettings(settings),
      primaryEnvironmentId: readPrimaryEnvironmentId(),
      resolveEnvironmentLabel: () => null,
    },
    m,
  );
  return sortSidebarV2ProjectGroups(
    groups,
    readThreadShells(),
    settings.sidebarProjectSortOrder,
    readDelegatedUnderParent(),
  );
}

/** Null on a server that cannot move threads. */
export function readThreadMoveMenu(threadRef: ScopedThreadRef): ThreadMoveMenu | null {
  const config = appAtomRegistry.get(environmentServerConfigsAtom).get(threadRef.environmentId);
  const thread = readThreadShell(threadRef);
  if (
    config?.environment.capabilities.threadMove !== true ||
    !thread ||
    thread.archivedAt !== null ||
    !isListedThreadLineage(thread.lineage)
  ) {
    return null;
  }
  const project = readProject({
    environmentId: threadRef.environmentId,
    projectId: thread.projectId,
  });
  if (!project) return null;
  const isScratch = (candidate: typeof project) =>
    isScratchProject(candidate, config.scratchWorkspaceRoot);
  return {
    busy: threadRuntimeIsActive(thread.runtime),
    worktrees: isScratch(project)
      ? null
      : resolveWorktreeDestinations(thread, readThreadShells(), project.worktreeTitles, m),
    projects: resolveProjectDestinations(readSidebarProjectGroups(), thread, isScratch),
  };
}

export function useThreadMove() {
  const moveThread = useAtomCommand(projectEnvironment.moveThread, { reportFailure: false });
  // Local only: a full refresh fetches, and may pull, before the user has confirmed anything.
  const refreshLocalStatus = useAtomCommand(vcsEnvironment.refreshLocalStatusForPicker, {
    reportFailure: false,
  });
  const loadWorktreeThreadIds = useAtomQueryRunner(orchestrationEnvironment.worktreeThreadIds, {
    reportFailure: false,
    refresh: true,
  });
  const removeEmptiedWorktree = useRemoveWorktree();

  return async (threadRef: ScopedThreadRef, destination: ThreadMoveDestination) => {
    const api = readLocalApi();
    const thread = readThreadShell(threadRef);
    if (!api || !thread) return;
    const project = readProject({
      environmentId: threadRef.environmentId,
      projectId: thread.projectId,
    });
    const source = thread.worktreePath ?? project?.workspaceRoot ?? null;
    const shared = threadSharesFolder(thread, readThreadShells());
    const status =
      source === null
        ? null
        : await refreshLocalStatus({
            environmentId: threadRef.environmentId,
            input: { cwd: source },
          });
    const destinationName = destination.detail
      ? `${destination.label} (${destination.detail})`
      : destination.label;
    const hasChanges = status?._tag === "Success" && status.value.hasWorkingTreeChanges;
    // The server brings them only into a new worktree, where they are sure to apply.
    const changesComeAlong = destination.to._tag === "newWorktree" && !shared;
    const notes = [
      ...(destination.to._tag === "project"
        ? [
            m(
              msg(
                "Its files stay where they are, and restore points from earlier turns won't work in the new project.",
              ),
            ),
          ]
        : []),
      ...(source !== null && hasChanges
        ? [
            changesComeAlong
              ? m(
                  msg("Uncommitted changes in {folder} come along.", {
                    folder: formatWorktreePathForDisplay(source),
                  }),
                )
              : m(
                  msg("Uncommitted changes in {folder} stay there.", {
                    folder: formatWorktreePathForDisplay(source),
                  }),
                ),
          ]
        : []),
    ];
    if (notes.length > 0) {
      const confirmed = await settlePromise(() =>
        api.dialogs.confirm(
          [
            destination.to._tag === "newWorktree"
              ? m(msg('Move "{title}" to a new worktree?', { title: thread.title }))
              : m(
                  msg('Move "{title}" to {destination}?', {
                    title: thread.title,
                    destination: destinationName,
                  }),
                ),
            ...notes,
          ].join("\n"),
        ),
      );
      if (confirmed._tag === "Failure" || !confirmed.value) return;
    }
    const result = await moveThread({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, to: destination.to },
    });
    if (result._tag !== "Success") {
      if (!isAtomCommandInterrupted(result)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: m(msg("Could not move thread")),
            description:
              thrownErrorMessage(squashAtomCommandFailure(result), m) ??
              m(msg("An error occurred.")),
          }),
        );
      }
      return;
    }
    toastManager.add({
      type: "success",
      title:
        destination.to._tag === "newWorktree"
          ? m(msg("Moved to a new worktree"))
          : m(msg("Moved to {destination}", { destination: destination.label })),
      description: thread.title,
    });

    // The thread left a worktree to itself. One that still holds changes was just said to keep
    // them, so only a clean one is offered for removal; a failed read keeps it too. A task
    // folder's other repositories are not in that read, so one is never offered.
    const emptied = thread.worktreePath;
    const config = appAtomRegistry.get(environmentServerConfigsAtom).get(threadRef.environmentId);
    if (
      emptied === null ||
      shared ||
      status?._tag !== "Success" ||
      hasChanges ||
      !status.value.isRepo ||
      !project ||
      (project.trackedFolders?.length ?? 0) > 0 ||
      isScratchProject(project, config?.scratchWorkspaceRoot) ||
      !readEnvironmentScope(threadRef.environmentId, AuthSourceControlWriteScope)
    ) {
      return;
    }
    // The client's list leaves out threads it has not loaded, so the server's decides.
    const occupants = await loadWorktreeThreadIds({
      environmentId: threadRef.environmentId,
      input: { worktreePath: emptied },
    });
    if (occupants._tag !== "Success" || occupants.value.threadIds.length > 0) return;
    const remove = await settlePromise(() =>
      api.dialogs.confirm(
        [
          m(msg("This thread was the only one linked to this worktree:")),
          formatWorktreePathForDisplay(emptied),
          "",
          m(msg("Delete the worktree too?")),
        ].join("\n"),
        { variant: "destructive" },
      ),
    );
    if (remove._tag === "Failure" || !remove.value) return;
    await removeEmptiedWorktree({
      environmentId: threadRef.environmentId,
      projectCwd: project.workspaceRoot,
      worktreePath: emptied,
    });
  };
}
