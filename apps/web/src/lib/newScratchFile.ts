import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useRightPanelStore } from "~/rightPanelStore";
import { projectEnvironment } from "~/state/projects";

function reportScratchFailure(result: AtomCommandResult<unknown, unknown>): void {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
  const error = squashAtomCommandFailure(result);
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title: "Could not create scratch file",
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}

/**
 * Creates a scratch file in `cwd` and opens it in the thread's right panel. Without a path it
 * is the next `tmp/scratch_N.md`. Resolves to whether the file was created.
 */
export async function openNewScratchFile(
  threadRef: ScopedThreadRef,
  cwd: string,
  file?: { readonly relativePath: string; readonly contents: string },
): Promise<boolean> {
  const result = await runAtomCommand(
    appAtomRegistry,
    projectEnvironment.createScratchFile,
    { environmentId: threadRef.environmentId, input: { cwd, ...file } },
    { reportFailure: false },
  );
  if (result._tag === "Success") {
    // An empty file is for typing in: a line reveal keeps it out of the rendered Markdown view.
    useRightPanelStore
      .getState()
      .openFile(threadRef, result.value.relativePath, file ? undefined : 1);
    return true;
  }
  reportScratchFailure(result);
  return false;
}

/** The next unused `tmp/scratch_N.md` in `cwd`, or null after reporting why it is unknown. */
export async function suggestScratchFilePath(
  threadRef: ScopedThreadRef,
  cwd: string,
): Promise<string | null> {
  const result = await runAtomCommand(
    appAtomRegistry,
    projectEnvironment.suggestScratchFile,
    { environmentId: threadRef.environmentId, input: { cwd } },
    { reportFailure: false },
  );
  if (result._tag === "Success") return result.value.relativePath;
  reportScratchFailure(result);
  return null;
}
