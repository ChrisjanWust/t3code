import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { rotateDefaultModelSelection } from "./modelRotation.ts";

const ultra = ProviderInstanceId.make("claudeAgent");
const personal = ProviderInstanceId.make("claudePersonal");
const driver = ProviderDriverKind.make("claudeAgent");

function claude(
  instanceId: ProviderInstanceId,
  ...windows: Array<Partial<ServerProviderUsageWindow>>
): ServerProvider {
  return {
    instanceId,
    driver,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-23T11:00:00.000Z",
    models: [{ slug: "claude-opus-5-5", name: "Opus 5.5", isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt: "2026-11-23T11:00:00.000Z",
      windows: windows.map((window) => ({
        id: "seven_day",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 0,
        resetsAt: "2026-11-26T09:00:00.000Z",
        ...window,
      })),
    },
  } as ServerProvider;
}

it.each([
  ["the account with the most room", claude(ultra, { usedPercent: 29 }), null, personal],
  ["the worktree's account over more room", claude(ultra, { usedPercent: 29 }), ultra, ultra],
  [
    "another account when the worktree's is out",
    claude(ultra, { usedPercent: 100 }),
    ultra,
    personal,
  ],
  [
    "an account whose high limit is for another model",
    claude(ultra, {}, { id: "seven_day_fable", usedPercent: 100 }),
    null,
    ultra,
  ],
  [
    "an account whose weekly limit resets soon with room left",
    claude(ultra, { usedPercent: 70, windowDurationMins: 10080, resetsAt: "2026-11-23T20:00:00Z" }),
    null,
    ultra,
  ],
  [
    "the most room when that reset is days away",
    claude(ultra, { usedPercent: 70, windowDurationMins: 10080, resetsAt: "2026-11-27T00:00:00Z" }),
    null,
    personal,
  ],
  [
    "the most room when the expiring account is nearly out",
    claude(ultra, { usedPercent: 95, windowDurationMins: 10080, resetsAt: "2026-11-23T20:00:00Z" }),
    null,
    personal,
  ],
  [
    "the most room when only a session limit resets soon",
    claude(ultra, {
      id: "five_hour",
      kind: "session",
      usedPercent: 70,
      windowDurationMins: 300,
      resetsAt: "2026-11-23T12:10:00Z",
    }),
    null,
    personal,
  ],
] as const)("picks %s", (_name, ultraProvider, worktreeInstanceId, expected) => {
  expect(
    rotateDefaultModelSelection({
      selection: { instanceId: ultra, model: "claude-opus-5-5" },
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: { [personal]: { driver, enabled: true, config: {} } },
        defaultModelRotation: [ultra, personal],
      },
      providers: [ultraProvider, claude(personal, { usedPercent: 6 })],
      projectId: null,
      worktreeInstanceId,
      now: Date.parse("2026-11-23T12:00:00.000Z"),
    })?.instanceId,
  ).toBe(expected);
});
