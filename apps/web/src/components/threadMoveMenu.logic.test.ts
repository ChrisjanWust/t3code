import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { SidebarProjectSnapshot } from "../sidebarProjectGrouping";
import type { Project, SidebarThreadSummary } from "../types";
import {
  resolveProjectDestinations,
  resolveWorktreeDestinations,
  threadSharesFolder,
} from "./threadMoveDestinations.logic";
import { buildThreadMoveMenuItems, threadMoveDestination } from "./threadMoveMenu.logic";

function thread(id: string, overrides: Partial<SidebarThreadSummary> = {}): SidebarThreadSummary {
  return {
    environmentId: "env-1",
    projectId: "project-1",
    id,
    title: id,
    branch: "feat/shared",
    worktreePath: "/worktrees/shared",
    createdAt: "2026-11-27T10:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    lineage: { relationshipToParent: null, parentThreadId: null },
    ...overrides,
  } as unknown as SidebarThreadSummary;
}

function project(id: string, overrides: Partial<Project> = {}): Project {
  return { environmentId: "env-1", id, archivedAt: null, ...overrides } as unknown as Project;
}

function group(displayName: string, members: Project[]): SidebarProjectSnapshot {
  return {
    displayName,
    archived: false,
    memberProjects: members,
  } as unknown as SidebarProjectSnapshot;
}

describe("resolveWorktreeDestinations", () => {
  it("offers a new worktree, the checkout, and other open worktrees, newest first", () => {
    const moving = thread("moving");
    const destinations = resolveWorktreeDestinations(
      moving,
      [
        moving,
        thread("neighbour"),
        thread("on-checkout", { worktreePath: null, branch: "develop" }),
        thread("older", { worktreePath: "/worktrees/older", branch: "feat/older" }),
        thread("newer", {
          worktreePath: "/worktrees/newer",
          branch: "feat/newer",
          createdAt: "2026-11-27T11:00:00.000Z",
        }),
        thread("settled", { worktreePath: "/worktrees/settled", settledOverride: "settled" }),
        thread("other-project", {
          worktreePath: "/worktrees/elsewhere",
          projectId: ProjectId.make("project-2"),
        }),
      ] as never,
      undefined,
    );

    expect(destinations.map(({ label, detail, to }) => [label, detail, to])).toEqual([
      ["New worktree", null, { _tag: "newWorktree" }],
      ["Main", "develop", { _tag: "worktree", worktreePath: null }],
      ["newer", "feat/newer", { _tag: "worktree", worktreePath: "/worktrees/newer" }],
      ["older", "feat/older", { _tag: "worktree", worktreePath: "/worktrees/older" }],
    ]);
  });

  it("leaves out a new worktree for a thread that already has its worktree to itself", () => {
    const alone = thread("alone");
    const destinations = resolveWorktreeDestinations(
      alone,
      [alone, thread("on-checkout", { worktreePath: null, branch: "main" })] as never,
      undefined,
    );

    expect(destinations.map(({ label, detail }) => [label, detail])).toEqual([["Main", null]]);
  });
});

describe("threadSharesFolder", () => {
  it("counts only other open threads, not the thread's own side chats or archived ones", () => {
    const moving = thread("moving");
    const sideChat = thread("side-chat", {
      lineage: { relationshipToParent: "fork", parentThreadId: "moving", sideChat: true },
    } as never);
    const archived = thread("archived", { archivedAt: "2026-11-27T12:00:00.000Z" });

    expect(threadSharesFolder(moving, [moving, sideChat, archived] as never)).toBe(false);
    expect(threadSharesFolder(moving, [moving, thread("neighbour")] as never)).toBe(true);
  });
});

describe("resolveProjectDestinations", () => {
  it("lists the thread's environment's other projects in sidebar order", () => {
    const destinations = resolveProjectDestinations(
      [
        group("Website", [project("website")]),
        group("Current", [project("project-1")]),
        group("API", [
          project("api-remote", { environmentId: EnvironmentId.make("env-2") }),
          project("api"),
        ]),
        group("No project", [project("scratch")]),
        group("Old", [project("old", { archivedAt: "2026-11-01T00:00:00.000Z" })]),
      ],
      { environmentId: "env-1", projectId: "project-1" } as never,
      (candidate) => candidate.id === "scratch",
    );

    expect(destinations.map(({ label, to }) => [label, to])).toEqual([
      ["Website", { _tag: "project", projectId: "website" }],
      ["API", { _tag: "project", projectId: "api" }],
    ]);
  });
});

describe("buildThreadMoveMenuItems", () => {
  it("gives a No project thread only the project menu, New project first", () => {
    const menu = {
      worktrees: null,
      projects: [{ label: "API", detail: null, to: { _tag: "project", projectId: "api" } }],
    } as const;
    const items = buildThreadMoveMenuItems({
      menu: menu as never,
      canTurnIntoProject: true,
      isRunning: false,
    });

    expect(items.map((item) => item.id)).toEqual(["move-project"]);
    expect(
      items[0]?.children?.map((child) => [child.id, child.label, child.separatorBefore]),
    ).toEqual([
      ["turn-into-project", "New project", undefined],
      ["move-project:0", "API", true],
    ]);
    expect(threadMoveDestination(menu as never, "move-project:0")?.to).toEqual({
      _tag: "project",
      projectId: "api",
    });
  });
});
