import type { ScopedThreadRef } from "@t3tools/contracts";

import ChatMarkdown from "~/components/ChatMarkdown";
import type { MarkdownExtensions } from "~/markdown/wordsHast";
import { resolvePathLinkTarget } from "@t3tools/shared/fileLinks";
import { maskMarkdownFrontmatter } from "@t3tools/shared/markdownFrontmatter";

/** Relative image paths in a Markdown file resolve against the file's own directory. */
export function markdownImageBaseDir(cwd: string, relativePath: string): string {
  const lastSeparator = Math.max(relativePath.lastIndexOf("/"), relativePath.lastIndexOf("\\"));
  return lastSeparator >= 0
    ? resolvePathLinkTarget(relativePath.slice(0, lastSeparator + 1), cwd)
    : cwd;
}

export function FileMarkdownPreview(props: {
  readonly cwd: string;
  readonly relativePath: string;
  readonly text: string;
  readonly threadRef: ScopedThreadRef;
  readonly workspaceMutationId: string | null;
  readonly className?: string;
  readonly extensions?: MarkdownExtensions | undefined;
  readonly onTaskListChange?:
    | ((input: { readonly markerOffset: number; readonly checked: boolean }) => void)
    | undefined;
}) {
  return (
    <ChatMarkdown
      text={maskMarkdownFrontmatter(props.text)}
      cwd={props.cwd}
      imageBaseDir={markdownImageBaseDir(props.cwd, props.relativePath)}
      threadRef={props.threadRef}
      workspaceMutationId={props.workspaceMutationId}
      className={props.className ?? "chat-markdown-document"}
      wideTables
      {...(props.extensions ? { extensions: props.extensions } : {})}
      onTaskListChange={props.onTaskListChange}
    />
  );
}
