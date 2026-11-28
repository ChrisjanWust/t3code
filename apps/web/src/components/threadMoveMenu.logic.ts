import type { ContextMenuItem, ThreadMoveTarget } from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../i18n/messages";

export type ThreadMoveMenuId =
  | "move-worktree"
  | `move-worktree:${number}`
  | "move-project"
  | `move-project:${number}`;

export interface ThreadMoveDestination {
  readonly label: string;
  readonly detail: string | null;
  readonly to: ThreadMoveTarget;
}

export interface ThreadMoveMenu {
  /** Running, queued or waiting on an answer: the server refuses to move it. */
  readonly busy: boolean;
  /** Null for a No project thread, which has no worktrees to move between. */
  readonly worktrees: ReadonlyArray<ThreadMoveDestination> | null;
  readonly projects: ReadonlyArray<ThreadMoveDestination>;
}

export function isThreadMoveAction(action: string): action is ThreadMoveMenuId {
  return action.startsWith("move-worktree:") || action.startsWith("move-project:");
}

export function threadMoveDestination(
  menu: ThreadMoveMenu,
  action: ThreadMoveMenuId,
): ThreadMoveDestination | undefined {
  const [kind, index] = action.split(":");
  const list = kind === "move-worktree" ? (menu.worktrees ?? []) : menu.projects;
  return list[Number(index)];
}

export function buildThreadMoveMenuItems(
  input: {
    readonly menu: ThreadMoveMenu | null;
    /** A No project thread with its own folder, on a server that can promote it. */
    readonly canTurnIntoProject: boolean;
    readonly isRunning: boolean;
  },
  resolve: MessageResolver = m,
): ReadonlyArray<ContextMenuItem<ThreadMoveMenuId | "turn-into-project">> {
  const entries = (
    prefix: "move-worktree" | "move-project",
    list: readonly ThreadMoveDestination[],
  ) =>
    list.map((destination, index) => ({
      id: `${prefix}:${index}` as const,
      label: destination.label,
      ...(destination.detail ? { detail: destination.detail } : {}),
      separatorBefore: index > 0 && list[index - 1]?.to._tag === "newWorktree",
    }));
  const worktrees = input.menu?.worktrees ?? [];
  const projects = input.menu?.projects ?? [];
  const disabled = input.isRunning || input.menu?.busy === true;
  return [
    ...(worktrees.length > 0
      ? [
          {
            id: "move-worktree" as const,
            label: resolve(msg("Move to worktree")),
            icon: "git-branch",
            disabled,
            children: entries("move-worktree", worktrees),
          },
        ]
      : []),
    ...(input.canTurnIntoProject || projects.length > 0
      ? [
          {
            id: "move-project" as const,
            label: resolve(msg("Move to project")),
            icon: "folder",
            disabled,
            children: [
              ...(input.canTurnIntoProject
                ? [
                    {
                      id: "turn-into-project" as const,
                      label: resolve(msg("New project")),
                      icon: "folder-plus",
                    },
                  ]
                : []),
              ...entries("move-project", projects).map((entry, index) => ({
                ...entry,
                separatorBefore: index === 0 && input.canTurnIntoProject,
              })),
            ],
          },
        ]
      : []),
  ];
}
