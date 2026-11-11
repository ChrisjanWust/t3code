import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  ContextMenuItem,
  EnvironmentId,
  ProjectEntryAction,
  ProjectEntryKind,
} from "@t3tools/contracts";
import { useId, useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { toastManager } from "~/components/ui/toast";
import { readLocalApi } from "~/localApi";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";

export interface FileEntryTarget {
  readonly path: string;
  readonly kind: ProjectEntryKind;
}

const ENTRY_ACTIONS = [
  "new-file",
  "new-folder",
  "copy-entry",
  "paste-entry",
  "duplicate-entry",
  "rename-entry",
  "delete-entry",
] as const;
export type FileEntryActionId = (typeof ENTRY_ACTIONS)[number];

export function isFileEntryActionId(id: string): id is FileEntryActionId {
  return (ENTRY_ACTIONS as readonly string[]).includes(id);
}

type NameRequest =
  | { readonly mode: "create"; readonly kind: ProjectEntryKind; readonly directory: string }
  | { readonly mode: "rename"; readonly entry: FileEntryTarget };

export function parentDirectory(path: string): string {
  return path.slice(0, Math.max(0, path.lastIndexOf("/")));
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function joinPath(directory: string, name: string): string {
  return directory ? `${directory}/${name}` : name;
}

/** Where `path` lands after `from` moves to `to`, or null when the move leaves it alone. */
function pathAfterMove(path: string, from: string, to: string): string | null {
  if (path === from) return to;
  return path.startsWith(`${from}/`) ? `${to}${path.slice(from.length)}` : null;
}

function normalizeEnteredPath(value: string): string {
  return value
    .trim()
    .split("/")
    .filter((segment) => segment.length > 0)
    .join("/");
}

export function useFileEntryActions(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  /** False where entries are not workspace-relative, such as a host folder. */
  readonly enabled: boolean;
  readonly selectedPath: string | null;
  readonly onOpenFile: (relativePath: string) => void;
  readonly onCreatedDirectory: (relativePath: string) => void;
  readonly onChanged: () => void;
  readonly onSelectedFileChanged: () => void;
  /** The open path moved or is gone; show `path` in its place, not beside it. */
  readonly onSelectedPathReplaced: (path: string) => void;
}) {
  const { environmentId, cwd, selectedPath } = props;
  const mutateEntry = useAtomCommand(projectEnvironment.mutateEntry, { reportFailure: false });
  const permitted = useAtomValue(projectEnvironment.mutateEntry.permissionAtom(environmentId));
  const enabled = permitted && props.enabled;
  const [nameRequest, setNameRequest] = useState<NameRequest | null>(null);
  const [copiedEntry, setCopiedEntry] = useState<FileEntryTarget | null>(null);

  /** Resolves to the entry's new path, or to the reason it failed. */
  const run = async (
    relativePath: string,
    action: ProjectEntryAction,
  ): Promise<{ path: string } | { error: string } | null> => {
    const result = await mutateEntry({ environmentId, input: { cwd, relativePath, action } });
    if (result._tag === "Success") {
      props.onChanged();
      return { path: result.value.relativePath };
    }
    if (isAtomCommandInterrupted(result)) return null;
    const error = squashAtomCommandFailure(result);
    return { error: error instanceof Error ? error.message : "The change could not be made." };
  };

  const runWithToast = async (title: string, relativePath: string, action: ProjectEntryAction) => {
    const result = await run(relativePath, action);
    if (result !== null && "error" in result) {
      toastManager.add({ type: "error", title, description: result.error });
    }
    return result !== null && "path" in result ? result.path : null;
  };

  const deleteEntry = async (entry: FileEntryTarget) => {
    const confirmed = await readLocalApi()?.dialogs.confirm(
      [
        `Delete "${baseName(entry.path)}"?`,
        entry.kind === "directory"
          ? "This permanently deletes the folder and everything in it."
          : "This permanently deletes the file.",
      ].join("\n"),
      { variant: "destructive" },
    );
    if (!confirmed) return;
    const deleted = await runWithToast("Could not delete", entry.path, { type: "delete" });
    if (deleted === null) return;
    if (copiedEntry !== null && pathAfterMove(copiedEntry.path, entry.path, "") !== null) {
      setCopiedEntry(null);
    }
    // Left open, the editor would write the deleted file back on the next keystroke.
    if (selectedPath !== null && pathAfterMove(selectedPath, entry.path, "") !== null) {
      props.onSelectedPathReplaced(parentDirectory(entry.path));
    }
  };

  const copyInto = async (source: FileEntryTarget, directory: string) => {
    if (pathAfterMove(directory, source.path, "") !== null) {
      toastManager.add({ type: "error", title: "A folder can't be pasted into itself" });
      return;
    }
    await runWithToast("Could not copy", source.path, {
      type: "copy",
      toRelativePath: joinPath(directory, baseName(source.path)),
    });
  };

  const submitName = async (request: NameRequest, value: string): Promise<string | null> => {
    const path = normalizeEnteredPath(value);
    if (!path) return "Enter a name.";
    if (request.mode === "create") {
      // The prefilled folder on its own names nothing new.
      if (path === request.directory) return "Enter a name.";
      const result = await run(path, { type: "create", kind: request.kind });
      if (result === null) return null;
      if ("error" in result) return result.error;
      // Creating the file an open tab already points at leaves the path unchanged, so reload it.
      if (result.path === selectedPath) props.onSelectedFileChanged();
      else if (request.kind === "file") props.onOpenFile(result.path);
      else props.onCreatedDirectory(result.path);
      return null;
    }
    const source = request.entry.path;
    if (path === source) return null;
    if (pathAfterMove(path, source, "") !== null) return "It can't be moved into itself.";
    const result = await run(source, { type: "move", toRelativePath: path });
    if (result === null) return null;
    if ("error" in result) return result.error;
    if (copiedEntry !== null) {
      const copiedPath = pathAfterMove(copiedEntry.path, source, result.path);
      if (copiedPath !== null) setCopiedEntry({ ...copiedEntry, path: copiedPath });
    }
    const movedSelection =
      selectedPath === null ? null : pathAfterMove(selectedPath, source, result.path);
    if (movedSelection !== null) props.onSelectedPathReplaced(movedSelection);
    return null;
  };

  const directoryOf = (entry: FileEntryTarget) =>
    entry.kind === "directory" ? entry.path : parentDirectory(entry.path);

  return {
    enabled,
    /** Menu entries that add something new, and those that change the clicked entry. */
    menuItems: (): Record<"create" | "change", ContextMenuItem<FileEntryActionId>[]> =>
      enabled
        ? {
            create: [
              { id: "new-file", label: "New file…" },
              { id: "new-folder", label: "New folder…" },
            ],
            change: [
              { id: "copy-entry", label: "Copy", separatorBefore: true },
              ...(copiedEntry === null
                ? []
                : [
                    {
                      id: "paste-entry" as const,
                      label: `Paste "${baseName(copiedEntry.path)}"`,
                    },
                  ]),
              { id: "duplicate-entry", label: "Duplicate" },
              { id: "rename-entry", label: "Rename or move…" },
              { id: "delete-entry", label: "Delete", destructive: true },
            ],
          }
        : { create: [], change: [] },
    activate: (id: FileEntryActionId, entry: FileEntryTarget): Promise<void> | void => {
      if (!enabled) return;
      switch (id) {
        case "new-file":
        case "new-folder":
          setNameRequest({
            mode: "create",
            kind: id === "new-file" ? "file" : "directory",
            directory: directoryOf(entry),
          });
          return;
        case "copy-entry":
          setCopiedEntry(entry);
          return;
        case "paste-entry":
          return copiedEntry === null ? undefined : copyInto(copiedEntry, directoryOf(entry));
        case "duplicate-entry":
          return copyInto(entry, parentDirectory(entry.path));
        case "rename-entry":
          setNameRequest({ mode: "rename", entry });
          return;
        case "delete-entry":
          return deleteEntry(entry);
      }
    },
    startCreate: (kind: ProjectEntryKind, directory: string) => {
      if (enabled) setNameRequest({ mode: "create", kind, directory });
    },
    dialog:
      nameRequest === null ? null : (
        <EntryNameDialog
          // A new request must not inherit the previous one's typed value.
          key={
            nameRequest.mode === "create"
              ? `create:${nameRequest.kind}:${nameRequest.directory}`
              : `rename:${nameRequest.entry.path}`
          }
          request={nameRequest}
          onClose={() => setNameRequest(null)}
          onSubmit={(value) => submitName(nameRequest, value)}
        />
      ),
  };
}

function EntryNameDialog(props: {
  readonly request: NameRequest;
  readonly onClose: () => void;
  /** Resolves to an error message to show, or null once the change is made. */
  readonly onSubmit: (value: string) => Promise<string | null>;
}) {
  const { request } = props;
  const inputId = useId();
  const initialValue =
    request.mode === "create"
      ? request.directory
        ? `${request.directory}/`
        : ""
      : request.entry.path;
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const noun = request.mode === "create" ? request.kind : request.entry.kind;
  const nounLabel = noun === "file" ? "file" : "folder";

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) props.onClose();
      }}
    >
      <DialogPopup className="sm:max-w-md">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (pending) return;
            setPending(true);
            setError(null);
            void props.onSubmit(value).then((failure) => {
              setPending(false);
              if (failure === null) props.onClose();
              else setError(failure);
            });
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {request.mode === "create" ? `New ${nounLabel}` : `Rename or move ${nounLabel}`}
            </DialogTitle>
            <DialogDescription>
              {request.mode === "create"
                ? "Path from the project root. Folders that don't exist yet are created."
                : "Change the name to rename it, or the folders before it to move it."}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <label htmlFor={inputId} className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">Path</span>
              <Input
                id={inputId}
                nativeInput
                font="mono"
                autoFocus
                value={value}
                spellCheck={false}
                autoComplete="off"
                aria-invalid={error !== null}
                placeholder={noun === "file" ? "src/example.ts" : "src/example"}
                onChange={(event) => {
                  setValue(event.target.value);
                  setError(null);
                }}
                onFocus={(event) => {
                  const input = event.currentTarget;
                  if (input.value !== initialValue) return;
                  // Renames start with the name selected, minus the extension, ready to retype.
                  const nameStart = initialValue.lastIndexOf("/") + 1;
                  const extension =
                    request.mode === "rename" && noun === "file"
                      ? initialValue.lastIndexOf(".")
                      : -1;
                  input.setSelectionRange(
                    request.mode === "rename" ? nameStart : initialValue.length,
                    extension > nameStart ? extension : initialValue.length,
                  );
                }}
              />
            </label>
            {error === null ? null : (
              <p role="alert" className="mt-2 text-xs text-destructive">
                {error}
              </p>
            )}
          </DialogPanel>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={props.onClose}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={pending || value.trim().length === 0}>
              {request.mode === "create" ? "Create" : "Rename"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
