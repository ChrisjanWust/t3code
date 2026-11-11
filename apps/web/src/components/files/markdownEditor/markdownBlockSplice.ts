import { Fragment, type Node as ProseMirrorNode, type Schema } from "@tiptap/pm/model";

import { parseMarkdown, serializeMarkdown } from "./vmark/markdownPipeline";
import { normalizeBareListMarkers } from "./vmark/markdownPipeline/parser/listNormalization";
import {
  escapeUnclosedMathFences,
  normalizeMathDelimiters,
} from "./vmark/markdownPipeline/parser/mathSourceGuards";

// The serializer writes one house style (`-` bullets, `**bold**`, padded tables),
// so writing the whole document back would reformat blocks nobody touched.
// Saving keeps the source text of every unchanged top-level block instead.

export interface MarkdownDocument {
  readonly source: string;
  readonly doc: ProseMirrorNode;
  /** Source offset where each top-level block starts, or null when they can't be trusted. */
  readonly blockStarts: ReadonlyArray<number> | null;
  readonly blockIndex: ReadonlyMap<ProseMirrorNode, number>;
}

const SERIALIZE_OPTIONS = { preserveBlankLines: true } as const;

function blockStartOffsets(source: string, doc: ProseMirrorNode): number[] | null {
  // The parser counts a lone CR as a line ending and rewrites a few shapes before
  // parsing; either leaves the recorded source lines pointing at the wrong text.
  const math = normalizeMathDelimiters(source);
  if (
    /\r(?!\n)/.test(source) ||
    math.split("\n").length !== source.split("\n").length ||
    escapeUnclosedMathFences(math) !== math ||
    normalizeBareListMarkers(math).modified
  ) {
    return null;
  }
  const lineStarts = [0];
  for (let index = source.indexOf("\n"); index !== -1; index = source.indexOf("\n", index + 1)) {
    lineStarts.push(index + 1);
  }
  const starts: number[] = [];
  let previous = -1;
  for (let index = 0; index < doc.childCount; index++) {
    const line: unknown = doc.child(index).attrs.sourceLine;
    if (typeof line !== "number") return null;
    const start = lineStarts[line - 1];
    if (start === undefined || start <= previous) return null;
    starts.push(start);
    previous = start;
  }
  if (starts[0] === undefined || source.slice(0, starts[0]).trim() !== "") return null;
  return starts;
}

export function loadMarkdownDocument(schema: Schema, source: string): MarkdownDocument {
  const doc = parseMarkdown(schema, source);
  const blockIndex = new Map<ProseMirrorNode, number>();
  doc.forEach((child, _offset, index) => blockIndex.set(child, index));
  return { source, doc, blockStarts: blockStartOffsets(source, doc), blockIndex };
}

const LIST_BLOCKS = new Set(["bulletList", "orderedList"]);

// A fence or HTML block the source never closed swallows whatever is written after it.
function leftOpenInSource(block: ProseMirrorNode, span: string): boolean {
  if (block.type.name === "html_block") return true;
  if (block.type.name !== "codeBlock") return false;
  const lines = span.trimEnd().split(/\r?\n/);
  const fence = /^ {0,3}(`{3,}|~{3,})/.exec(lines[0] ?? "")?.[1];
  if (!fence) return false;
  const closing = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*$`);
  return lines.length < 2 || !closing.test(lines.at(-1)!);
}

function trailingWhitespace(text: string): string {
  return /\s*$/.exec(text)?.[0] ?? "";
}

export function saveMarkdownDocument(
  schema: Schema,
  loaded: MarkdownDocument,
  current: ProseMirrorNode,
): string {
  const { source, doc: original, blockStarts } = loaded;
  if (current.eq(original)) return source;
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const serialize = (blocks: ReadonlyArray<ProseMirrorNode>) => {
    const markdown = serializeMarkdown(
      schema,
      schema.topNodeType.create(null, Fragment.fromArray([...blocks])),
      SERIALIZE_OPTIONS,
    ).replace(/^\n+|\s+$/g, "");
    return eol === "\n" ? markdown : markdown.replace(/\r?\n/g, eol);
  };
  const fileEnd = source === "" ? "\n" : trailingWhitespace(source);

  // An emptied paragraph writes nothing, so it can't keep its neighbours apart.
  const blocks: ProseMirrorNode[] = [];
  current.forEach((child) => {
    if (child.type.name !== "paragraph" || child.childCount > 0) blocks.push(child);
  });

  if (!blockStarts) {
    const markdown = serialize(blocks);
    return markdown === "" ? "" : markdown + (fileEnd.includes("\n") ? eol : "");
  }

  // kept[i] is the original index whose source text block i reuses, or -1.
  const kept: number[] = [];
  let lastKept = -1;
  for (const child of blocks) {
    let index = loaded.blockIndex.get(child) ?? -1;
    if (index <= lastKept) {
      const next = lastKept + 1;
      index = next < original.childCount && child.eq(original.child(next)) ? next : -1;
    }
    if (index !== -1) lastKept = index;
    kept.push(index);
  }

  const spanEnd = (index: number) => blockStarts[index + 1] ?? source.length;
  const contiguous = (index: number) =>
    kept[index] !== -1 && kept[index + 1] !== -1 && kept[index + 1] === kept[index]! + 1;
  for (let changed = true; changed;) {
    changed = false;
    for (let index = 0; index < kept.length; index++) {
      if (kept[index] === -1) continue;
      const block = blocks[index]!;
      const before = blocks[index - 1];
      const after = blocks[index + 1];
      const span = source.slice(blockStarts[kept[index]!], spanEnd(kept[index]!));
      const list = LIST_BLOCKS.has(block.type.name);
      // Two same-kind lists side by side only stay apart when written together.
      const fusesBefore = list && before?.type === block.type && !contiguous(index - 1);
      const fusesAfter = list && after?.type === block.type && !contiguous(index);
      // Indented text continues whatever list, footnote or code block now precedes it.
      const absorbed = before !== undefined && !contiguous(index - 1) && /^[ \t]/.test(span);
      const leftOpen = after !== undefined && !contiguous(index) && leftOpenInSource(block, span);
      if (fusesBefore || fusesAfter || absorbed || leftOpen) {
        kept[index] = -1;
        changed = true;
      }
    }
  }

  let output = source.slice(0, blockStarts[0]);
  let separator = "";
  for (let index = 0; index < kept.length;) {
    const originalIndex = kept[index]!;
    let body: string;
    let gap: string;
    if (originalIndex !== -1) {
      const span = source.slice(blockStarts[originalIndex], spanEnd(originalIndex));
      gap = contiguous(index) ? trailingWhitespace(span) : eol + eol;
      body = span.slice(0, span.length - trailingWhitespace(span).length);
      index++;
    } else {
      const run: ProseMirrorNode[] = [];
      while (index < kept.length && kept[index] === -1) run.push(blocks[index++]!);
      body = serialize(run);
      gap = eol + eol;
    }
    if (body === "") continue;
    output += separator + body;
    separator = gap;
  }
  // A rule that newly opens the file would read as a frontmatter fence.
  if (blocks[0]?.type.name === "horizontalRule" && kept[0] !== 0) {
    output = output.replace(/^(\s*)---/, "$1***");
  }
  return output.trim() === "" ? "" : output + fileEnd;
}
