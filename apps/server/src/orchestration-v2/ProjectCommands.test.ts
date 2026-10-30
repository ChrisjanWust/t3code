import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  ProjectId,
  type ProjectScript,
  type ProjectWorktreeTitle,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";

import {
  planProjectCommand,
  type ProjectCommand,
  type ProjectCommandState,
  type ProjectWorktreeTitleChange,
} from "./ProjectCommands.ts";
import type { ProjectRow } from "./ProjectStore.ts";

const now = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
const projectId = ProjectId.make("project-scripts");

const row = (overrides: Partial<ProjectRow> = {}): ProjectRow => ({
  projectId,
  title: "Scripts",
  workspaceRoot: "/tmp/scripts",
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  autoPull: false,
  faviconPath: null,
  projectIcon: null,
  scripts: [],
  worktreeTitles: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
  ...overrides,
});

const script = (id: string): ProjectScript => ({
  id,
  name: "Install dependencies",
  command: "vp i",
  icon: "configure",
  runOnWorktreeCreate: false,
});

const plan = (command: ProjectCommand, state: Partial<ProjectCommandState> = {}) =>
  planProjectCommand({
    command,
    state: { project: undefined, workspaceOwner: undefined, ...state },
    eventId: EventId.make("event:planned"),
    now,
  });

const payloadOf = (result: ReturnType<typeof plan>) => {
  assert.isTrue(Result.isSuccess(result));
  return Result.getOrThrow(result).payload as Record<string, unknown>;
};

const failureOf = (result: ReturnType<typeof plan>) => {
  assert.isTrue(Result.isFailure(result));
  return Result.isFailure(result) ? result.failure : assert.fail("expected a rejection");
};

describe("planProjectCommand", () => {
  it("keeps legacy scripts editable and removable while rejecting new invalid ones", () => {
    const legacy = script("install-javascript-dependencies");
    const withLegacy = (scripts: ReadonlyArray<ProjectScript>) =>
      plan(
        {
          type: "project.meta.update",
          commandId: CommandId.make("cmd-repair-script"),
          projectId,
          scripts,
        },
        { project: row({ scripts: [legacy] }) },
      );
    for (const scripts of [[{ ...legacy, command: "vp install" }, script("lint")], []]) {
      assert.deepEqual(payloadOf(withLegacy(scripts)).scripts, scripts);
    }
    assert.equal(
      failureOf(withLegacy([legacy, script("another.invalid.id")]))._tag,
      "ProjectCommandInvariantError",
    );
  });

  it("rejects a workspace root held by another active project", () => {
    const owner = row({
      projectId: ProjectId.make("project-existing"),
      workspaceRoot: "/tmp/project",
    });
    const create = failureOf(
      plan(
        {
          type: "project.create",
          commandId: CommandId.make("cmd-duplicate-root"),
          projectId: ProjectId.make("project-duplicate-root"),
          title: "Duplicate",
          workspaceRoot: "/tmp/project",
        },
        { workspaceOwner: owner },
      ),
    );
    assert.equal(create._tag, "ProjectWorkspaceConflictError");
    assert.equal(
      create.message,
      "Active project 'project-existing' already exists for workspace root '/tmp/project'.",
    );
    const move = failureOf(
      plan(
        {
          type: "project.meta.update",
          commandId: CommandId.make("cmd-move-root"),
          projectId,
          workspaceRoot: "/tmp/project",
        },
        { project: row(), workspaceOwner: owner },
      ),
    );
    assert.equal(move._tag, "ProjectWorkspaceConflictError");
  });

  it("requires the project to exist, and to be absent on create", () => {
    const create: ProjectCommand = {
      type: "project.create",
      commandId: CommandId.make("cmd-create-twice"),
      projectId,
      title: "Twice",
      workspaceRoot: "/tmp/twice",
    };
    assert.include(failureOf(plan(create, { project: row() })).message, "cannot be created twice");
    const deleted = row({ deletedAt: "2026-01-01T00:00:00.000Z" });
    assert.include(
      failureOf(plan(create, { project: deleted })).message,
      "cannot be created twice",
    );
    for (const command of [
      { type: "project.meta.update", commandId: CommandId.make("cmd-missing"), projectId },
      { type: "project.delete", commandId: CommandId.make("cmd-missing"), projectId },
    ] as const) {
      for (const project of [undefined, deleted]) {
        assert.equal(
          failureOf(plan(command, { project }))._tag,
          "ProjectCommandMissingProjectError",
        );
      }
    }
  });

  describe("worktree titles", () => {
    const path = "/tmp/scripts/.t3/worktrees/a";
    const plannedAt = "2026-01-01T00:00:00.000Z";
    const entry = (overrides: Partial<ProjectWorktreeTitle> = {}): ProjectWorktreeTitle => ({
      worktreePath: path,
      generated: "Generated title",
      manual: null,
      sourceThreadIds: [ThreadId.make("thread-a")],
      updatedAt: "2025-12-31T00:00:00.000Z",
      ...overrides,
    });
    const planTitle = (
      change: ProjectWorktreeTitleChange,
      titles: ReadonlyArray<ProjectWorktreeTitle>,
    ) =>
      plan(
        {
          type: "project.worktree-title.update",
          commandId: CommandId.make("cmd-worktree-title"),
          projectId,
          worktreePath: path,
          change,
        },
        { project: row({ worktreeTitles: titles, updatedAt: "2025-06-01T00:00:00.000Z" }) },
      );
    const titlesOf = (result: ReturnType<typeof plan>) =>
      payloadOf(result).worktreeTitles as ReadonlyArray<ProjectWorktreeTitle>;
    const generated = (
      overrides: Partial<Extract<ProjectWorktreeTitleChange, { type: "generated" }>> = {},
    ): ProjectWorktreeTitleChange => ({
      type: "generated",
      title: "New title",
      sourceThreadIds: [ThreadId.make("thread-b")],
      replaceManual: false,
      ...overrides,
    });

    it("keeps the generated title under a manual one and restores it when cleared", () => {
      const renamed = titlesOf(planTitle({ type: "manual", title: "Mine" }, [entry()]));
      assert.deepEqual(renamed, [entry({ manual: "Mine", updatedAt: plannedAt })]);
      const cleared = titlesOf(planTitle({ type: "manual", title: null }, renamed));
      assert.deepEqual(cleared, [entry({ updatedAt: plannedAt })]);
      // Clearing a title nothing generated leaves no entry behind.
      assert.deepEqual(
        titlesOf(planTitle({ type: "manual", title: null }, [entry({ generated: null })])),
        [],
      );
    });

    it("keeps a manual title that a background generation finished under", () => {
      assert.deepEqual(titlesOf(planTitle(generated(), [entry({ manual: "Mine" })])), [
        entry({
          generated: "New title",
          manual: "Mine",
          sourceThreadIds: [ThreadId.make("thread-b")],
          updatedAt: plannedAt,
        }),
      ]);
    });

    it("lets an explicit regenerate replace a manual title", () => {
      assert.deepEqual(
        titlesOf(planTitle(generated({ replaceManual: true }), [entry({ manual: "Mine" })])),
        [
          entry({
            generated: "New title",
            sourceThreadIds: [ThreadId.make("thread-b")],
            updatedAt: plannedAt,
          }),
        ],
      );
    });

    it("keeps the newest 100 titles and leaves the project's recency alone", () => {
      const others = Array.from({ length: 100 }, (_, index) =>
        entry({
          worktreePath: `/tmp/scripts/.t3/worktrees/${index}`,
          updatedAt: `2025-01-01T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
        }),
      );
      const result = planTitle({ type: "manual", title: "Mine" }, others);
      const paths = titlesOf(result).map((title) => title.worktreePath);
      assert.equal(paths.length, 100);
      assert.equal(paths[0], path);
      assert.notInclude(paths, "/tmp/scripts/.t3/worktrees/0");
      assert.equal(payloadOf(result).updatedAt, "2025-06-01T00:00:00.000Z");
    });
  });
});
