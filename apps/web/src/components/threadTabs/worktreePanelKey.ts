import type { ScopedThreadRef } from "@t3tools/contracts";

import { useComposerDraftStore } from "../../composerDraftStore";
import { getClientSettings, isClientSettingsHydrated } from "../../hooks/useSettings";
import { setRightPanelKeyResolver } from "../../rightPanelStore";
import { readThreadShell } from "../../state/entities";
import { draftWorktreeKey, worktreeKey } from "./threadTabs.logic";

/** The tabbed layout gives a worktree's tabs one right panel, so switching tabs keeps it. */
function worktreePanelKey(ref: ScopedThreadRef): string | null {
  if (!isClientSettingsHydrated()) return null;
  const settings = getClientSettings();
  if (!settings.threadTabsEnabled || settings.legacySidebarEnabled) return null;
  const shell = readThreadShell(ref);
  if (shell !== null) return `worktree:${worktreeKey(shell)}`;
  const draft = useComposerDraftStore.getState().getDraftThreadByRef(ref);
  const key = draft === null ? null : draftWorktreeKey(draft);
  return key === null ? null : `worktree:${key}`;
}

export function startWorktreePanelSharing(): () => void {
  setRightPanelKeyResolver(worktreePanelKey);
  return () => setRightPanelKeyResolver(null);
}
