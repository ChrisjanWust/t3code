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
import { isListedThreadLineage, type ScopedThreadRef } from "@t3tools/contracts";
import { msg } from "gt-react";

import { orderItemsByPreferredIds, sortSidebarV2ProjectGroups } from "../components/Sidebar.logic";
import {
  resolveProjectDestinations,
  resolveWorktreeDestinations,
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
import { projectEnvironment } from "../state/projects";
import { environmentServerConfigsAtom } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { vcsEnvironment } from "../state/vcs";
import { legacyProjectCwdPreferenceKey, useUiStateStore } from "../uiStateStore";
import { formatWorktreePathForDisplay } from "../worktreeCleanup";
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

  return async (threadRef: ScopedThreadRef, destination: ThreadMoveDestination) => {
    const api = readLocalApi();
    const thread = readThreadShell(threadRef);
    if (!api || !thread) return;
    const source =
      thread.worktreePath ??
      readProject({ environmentId: threadRef.environmentId, projectId: thread.projectId })
        ?.workspaceRoot ??
      null;
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
      ...(source !== null && status?._tag === "Success" && status.value.hasWorkingTreeChanges
        ? [
            m(
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
    if (result._tag === "Success") {
      toastManager.add({
        type: "success",
        title:
          destination.to._tag === "newWorktree"
            ? m(msg("Moved to a new worktree"))
            : m(msg("Moved to {destination}", { destination: destination.label })),
        description: thread.title,
      });
    } else if (!isAtomCommandInterrupted(result)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: m(msg("Could not move thread")),
          description:
            thrownErrorMessage(squashAtomCommandFailure(result), m) ?? m(msg("An error occurred.")),
        }),
      );
    }
  };
}
