import type { ScopedProjectRef } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import {
  rotateDefaultModelSelection,
  worktreeProviderInstanceId,
} from "@t3tools/shared/modelRotation";
import { resolveNewThreadModelSelection } from "@t3tools/shared/usageLimits";

import { type DraftId, useComposerDraftStore } from "../composerDraftStore";
import { resolveProjectDefaultProviderModelSelection } from "../providerInstances";
import { readProject, readThreadShells } from "../state/entities";
import { readEnvironment, readEnvironmentProviders } from "../state/environments";
import { hasExplicitComposerModelSelection } from "./chatThreadActions";

/** Gives a draft that moved project, machine or worktree the model a new thread there would start with. */
export function seedDraftModelSelection(
  draftId: DraftId,
  projectRef: ScopedProjectRef,
  worktreePath: string | null = null,
): void {
  const store = useComposerDraftStore.getState();
  if (hasExplicitComposerModelSelection(store.getComposerDraft(draftId))) return;
  store.applyStickyState(draftId);
  const project = readProject(projectRef);
  const settings = readEnvironment(projectRef.environmentId)?.serverConfig?.settings;
  const providers = readEnvironmentProviders(projectRef.environmentId) ?? [];
  const defaultSelection = settings
    ? rotateDefaultModelSelection({
        selection: resolveProjectSettings(settings, projectRef.projectId, project ?? undefined)
          .settings.defaultModelSelection,
        settings,
        providers,
        projectId: projectRef.projectId,
        worktreeInstanceId: worktreeProviderInstanceId(readThreadShells(), {
          environmentId: projectRef.environmentId,
          worktreePath,
        }),
        now: Date.now(),
      })
    : (project?.defaultModelSelection ?? null);
  const resolution = resolveNewThreadModelSelection({
    defaultSelection:
      defaultSelection ??
      (useComposerDraftStore.getState().stickyActiveProvider !== null || !settings
        ? null
        : resolveProjectDefaultProviderModelSelection(providers, settings, projectRef.projectId)),
    fallbackSelection: settings?.fallbackModelSelection ?? null,
    providers,
    ...(settings ? { settings } : {}),
    projectId: projectRef.projectId,
    now: Date.now(),
  });
  const selection = resolution.fallback ? resolution.selection : defaultSelection;
  if (selection) store.setModelSelection(draftId, selection, { replaceOptions: true });
}
