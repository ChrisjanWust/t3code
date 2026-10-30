import { describe, expect, it } from "vite-plus/test";

import { buildThreadActionMenuItems, type ThreadActionMenuState } from "./threadActionMenu.logic";

const baseState: ThreadActionMenuState = {
  canOperate: true,
  branch: null,
  projectFilter: null,
  isPinned: false,
  isSettled: false,
  autoSettleEnabled: true,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  isRunning: false,
  supports: {
    settlement: true,
    autoSettleOptOut: true,
    snooze: true,
    pinning: true,
    titleRegeneration: true,
  },
  snoozePresets: [
    { id: "hour", label: "In 1 hour", whenLabel: "3:00 PM", snoozedUntil: "2026-08-07T15:00:00Z" },
  ],
};

describe("buildThreadActionMenuItems", () => {
  it("offers a worktree row its lifecycle and leaves thread-only actions to its tabs", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      scope: "worktree",
      isSettled: true,
      canShareWithGuest: true,
      worktreeTitle: { isManual: true },
    });
    expect(items.map((item) => [item.id, item.label])).toEqual([
      ["new-thread-on-branch", "New tab"],
      ["pin", "Pin worktree"],
      ["unsettle", "Reopen worktree"],
      ["snooze", "Snooze"],
      ["rename", "Rename worktree"],
      ["regenerate-title", "Regenerate title"],
      ["reset-title", "Reset title"],
      ["copy", "Copy"],
      ["project-settings", "Project settings"],
      ["archive", "Archive worktree"],
      ["delete", "Delete"],
    ]);
    const copy = items.find((item) => item.id === "copy");
    expect(copy?.children?.map((child) => child.id)).toEqual(["copy-path"]);
  });

  it.each([false, true])(
    "disables both lifecycle directions without permission (reversed: %s)",
    (reversed) => {
      const items = buildThreadActionMenuItems({
        ...baseState,
        canOperate: false,
        isPinned: reversed,
        isSettled: reversed,
        isSnoozed: reversed,
      });
      const expected = reversed
        ? [
            "unpin",
            "unsettle",
            "unsnooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ]
        : [
            "pin",
            "settle",
            "snooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ];
      expect(items.filter((item) => item.disabled).map((item) => item.id)).toEqual(expected);
      expect(
        items.find((item) => item.id === "snooze")?.children?.every((child) => child.disabled) ??
          true,
      ).toBe(true);
    },
  );

  it("disables archive while the thread is running", () => {
    const archiveItem = buildThreadActionMenuItems({ ...baseState, isRunning: true }).find(
      (item) => item.id === "archive",
    );
    expect(archiveItem?.disabled).toBe(true);
  });
});
