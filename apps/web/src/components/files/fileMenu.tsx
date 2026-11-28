import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { formatFilePathForClipboard } from "@t3tools/client-runtime/media-actions";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import type {
  ContextMenuItem,
  ContextMenuSource,
  EnvironmentId,
  ProjectEntryKind,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";
import { resolvePathLinkTarget } from "@t3tools/shared/fileLinks";
import { isHostPath } from "@t3tools/shared/path";
import { useGT } from "gt-react";
import { createContext, type ReactNode, use, useState } from "react";

import { toastManager } from "~/components/ui/toast";
import { useComposerHandleContext } from "~/composerHandleContext";
import {
  type FileContextMenuAction,
  type FileContextMenuTarget,
  useFileContextMenu,
} from "~/fileContextMenu";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { useStableCallback } from "~/hooks/useStableCallback";
import { m } from "~/i18n/messages";
import { readLocalApi } from "~/localApi";
import { useRightPanelStore } from "~/rightPanelStore";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { projectEnvironment } from "~/state/projects";

import { isFileEntryActionId, parentDirectory, useFileEntryActions } from "./fileEntryActions";
import { useFileDownload } from "./useFileDownload";

export interface FileMenuTarget {
  /** Workspace-relative, with "" for the workspace root, or an absolute host path. */
  readonly path: string;
  /** Left out where the path may be a file or a folder, as on a tab; read when it matters. */
  readonly kind?: ProjectEntryKind;
}

interface FileMenuOptions {
  readonly onCreatedDirectory?: (relativePath: string) => void;
}

export interface FileMenu {
  readonly canEditEntries: boolean;
  /** Counts entry changes made here, which file views must reread like workspace mutations. */
  readonly revision: number;
  readonly items: (target: FileMenuTarget) => ContextMenuItem[];
  /** Runs a picked item, or returns false when the id is not this menu's. */
  readonly activate: (id: string, target: FileMenuTarget, options?: FileMenuOptions) => boolean;
  readonly show: (
    target: FileMenuTarget,
    position?: { x: number; y: number },
    source?: ContextMenuSource,
    options?: FileMenuOptions,
  ) => Promise<void>;
  readonly startCreate: (
    kind: ProjectEntryKind,
    directory: string,
    options?: FileMenuOptions,
  ) => void;
}

const FileMenuContext = createContext<FileMenu | null>(null);

/** The one menu every place that shows a workspace file or folder opens on right-click. */
export function useFileMenu(): FileMenu | null {
  return use(FileMenuContext);
}

export function fileViewMutationId(
  workspaceMutationId: string | null,
  revision: number | undefined,
): string | null {
  return revision ? `${workspaceMutationId ?? ""}:files-${revision}` : workspaceMutationId;
}

/** Separators go between the non-empty sections, never before the first. */
function joinSections(...sections: ContextMenuItem[][]): ContextMenuItem[] {
  return sections
    .filter((section) => section.length > 0)
    .flatMap((section, sectionIndex) =>
      section.map(({ separatorBefore: _separator, ...item }, index) =>
        sectionIndex > 0 && index === 0 ? { ...item, separatorBefore: true } : item,
      ),
    );
}

async function readEntryKind(
  environmentId: EnvironmentId,
  cwd: string,
  path: string,
): Promise<ProjectEntryKind> {
  const listing = await executeAtomQuery(
    appAtomRegistry,
    projectEnvironment.listEntries({
      environmentId,
      input: { cwd, directoryPath: parentDirectory(path) },
    }),
    { reportFailure: false, reportDefect: false },
  );
  return listing._tag === "Success"
    ? (listing.value.entries.find((entry) => entry.path === path)?.kind ?? "file")
    : "file";
}

export function FileMenuProvider(props: {
  readonly environmentId: EnvironmentId;
  /** The workspace root; without one there is no menu. */
  readonly cwd: string | null | undefined;
  readonly threadRef: ScopedThreadRef;
  readonly children: ReactNode;
}) {
  const { environmentId, threadRef } = props;
  const cwd = props.cwd ?? "";
  const gt = useGT();
  const composerRef = useComposerHandleContext();
  const fileContextMenu = useFileContextMenu(environmentId);
  const downloadFile = useFileDownload(environmentId);
  const [revision, setRevision] = useState(0);
  const entryActions = useFileEntryActions({
    environmentId,
    cwd,
    enabled: cwd !== "",
    onOpenFile: (path) => useRightPanelStore.getState().openFile(threadRef, path),
    onChanged: () => setRevision((value) => value + 1),
    onMoved: (from, to) => useRightPanelStore.getState().followEntryMove(threadRef, from, to),
  });

  const contextTarget = (target: FileMenuTarget): FileContextMenuTarget => {
    const isDirectory =
      target.kind === undefined ? {} : { isDirectory: target.kind === "directory" };
    return target.path === "" || isHostPath(target.path)
      ? { environmentId, filePath: target.path || cwd, workspaceRoot: undefined, ...isDirectory }
      : { environmentId, filePath: target.path, workspaceRoot: cwd, ...isDirectory };
  };

  const items = (target: FileMenuTarget): ContextMenuItem[] => {
    const root = target.path === "";
    const entryItems = isHostPath(target.path)
      ? { create: [], change: [] }
      : entryActions.menuItems();
    return joinSections(
      entryItems.create,
      [
        ...fileContextMenu.buildItems(contextTarget(target)),
        ...(root
          ? []
          : [
              ...(downloadFile && target.kind !== "directory"
                ? [{ id: "download", label: gt("Download", { $context: "verb, saves a file" }) }]
                : []),
              { id: "copy-path", label: gt("Copy path") },
              { id: "copy-mention", label: gt("Copy mention") },
              { id: "add-to-chat", label: gt("Add to chat") },
            ]),
      ],
      root ? entryItems.change.filter((item) => item.id === "paste-entry") : entryItems.change,
    );
  };

  const copy = async (text: string, failureTitle: string) => {
    try {
      await writeTextToClipboard(text);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: failureTitle,
        description: thrownErrorMessage(error, m) ?? gt("An error occurred."),
      });
    }
  };

  const addToChat = (mention: string) => {
    const composer = composerRef?.current;
    if (!composer) {
      toastManager.add({
        type: "error",
        title: gt("Unable to add to chat"),
        description: gt("Open a chat for this project and try again."),
      });
      return;
    }
    if (!composer.insertTextAtEnd(`${mention} `, { ensureLeadingBoundary: true })) {
      toastManager.add({
        type: "error",
        title: gt("Unable to add to chat"),
        description: gt("The chat isn't ready to accept input right now."),
      });
    }
  };

  const kindOf = async (target: FileMenuTarget) =>
    target.kind ?? (await readEntryKind(environmentId, cwd, target.path));

  const activate = (id: string, target: FileMenuTarget, options?: FileMenuOptions): boolean => {
    if (isFileEntryActionId(id)) {
      void (async () => {
        const entry = { path: target.path, kind: await kindOf(target) };
        await entryActions.activate(id, entry, options?.onCreatedDirectory);
      })();
      return true;
    }
    if (id === "open" || id === "reveal-in-folder" || id.startsWith("editor:")) {
      void (async () => {
        const kind = await kindOf(target);
        await fileContextMenu.activate(
          id as FileContextMenuAction,
          contextTarget({ ...target, kind }),
        );
      })();
      return true;
    }
    switch (id) {
      case "download": {
        if (!isHostPath(target.path)) {
          downloadFile?.(cwd, target.path);
          return true;
        }
        const cut = Math.max(target.path.lastIndexOf("/"), target.path.lastIndexOf("\\"));
        downloadFile?.(target.path.slice(0, Math.max(cut, 1)), target.path.slice(cut + 1));
        return true;
      }
      case "copy-path":
        void copy(
          formatFilePathForClipboard(target.path, resolvePathLinkTarget(target.path, cwd)),
          gt("Failed to copy path"),
        );
        return true;
      case "copy-mention":
        void copy(serializeComposerFileLink(target.path), gt("Failed to copy mention"));
        return true;
      case "add-to-chat":
        addToChat(serializeComposerFileLink(target.path));
        return true;
    }
    return false;
  };

  const show = async (
    target: FileMenuTarget,
    position?: { x: number; y: number },
    source?: ContextMenuSource,
    options?: FileMenuOptions,
  ) => {
    const api = readLocalApi();
    const menuItems = items(target);
    if (api === undefined || menuItems.length === 0) return;
    const clicked = await api.contextMenu.show(menuItems, position, source);
    if (clicked !== null) activate(clicked, target, options);
  };

  const startCreate = (kind: ProjectEntryKind, directory: string, options?: FileMenuOptions) =>
    entryActions.startCreate(kind, directory, options?.onCreatedDirectory);

  // Stable functions keep the value from changing on every chat render, which would re-render the open file.
  const stableItems = useStableCallback(items);
  const stableActivate = useStableCallback(activate);
  const stableShow = useStableCallback(show);
  const stableStartCreate = useStableCallback(startCreate);
  const menu: FileMenu = {
    canEditEntries: entryActions.enabled,
    revision,
    items: stableItems,
    activate: stableActivate,
    show: stableShow,
    startCreate: stableStartCreate,
  };

  return (
    <FileMenuContext value={cwd === "" ? null : menu}>
      {props.children}
      {entryActions.dialog}
    </FileMenuContext>
  );
}
