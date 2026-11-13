/**
 * mdast → ProseMirror converter table.
 *
 * Purpose: dispatch for the mdast → PM direction, keyed on `node.type`.
 *
 * Converters receive one argument object rather than a positional list: this
 * direction needs the node, the active marks, block-vs-inline context, the
 * schema, the shared conversion context, and an inline-children helper.
 *
 * @coordinates-with mdastToProseMirror.ts — the caller
 * @module utils/markdownPipeline/mdastConverters.registry
 */
import type { Node as PMNode, Schema, Mark } from "@tiptap/pm/model";
import type { Content } from "mdast";
import * as inlineConverters from "./mdastInlineConverters";
import * as blockConverters from "./mdastBlockConverters";
import * as containerConverters from "./mdastContainerConverters";
import { convertParagraph } from "./mdastParagraphConverter";
import type { MdastToPmContext } from "./mdastConverterHelpers";

/** Everything an mdast → PM converter may need. */
export interface MdastConvertArgs {
  node: Content;
  marks: Mark[];
  /** Whether the node is being converted in block or inline position. */
  position: "block" | "inline";
  schema: Schema;
  ctx: MdastToPmContext;
  convertInlineChildren: (children: readonly Content[], nextMarks: Mark[]) => PMNode[];
}

export type MdastToPmResult = PMNode | PMNode[] | null;

// mdast's Content union does not narrow through a table lookup, so each converter
// re-asserts its own node type.
type A = MdastConvertArgs;

/** `[mdastType, extensionId, convert]` for every migrated arm. */
const ENTRIES: ReadonlyArray<[string, string, (a: A) => MdastToPmResult]> = [
  // ---- blocks ----
  ["paragraph", "vmark.paragraph", (a) => convertParagraph(a.ctx, a.node as any, a.marks)],
  [
    "heading",
    "vmark.heading",
    (a) => blockConverters.convertHeading(a.ctx, a.node as any, a.marks),
  ],
  ["code", "vmark.codeBlock", (a) => blockConverters.convertCode(a.ctx, a.node as any)],
  [
    "blockquote",
    "vmark.blockquote",
    (a) => containerConverters.convertBlockquote(a.ctx, a.node as any, a.marks),
  ],
  ["list", "vmark.list", (a) => blockConverters.convertList(a.ctx, a.node as any, a.marks)],
  [
    "listItem",
    "vmark.listItem",
    (a) => blockConverters.convertListItem(a.ctx, a.node as any, a.marks),
  ],
  [
    "thematicBreak",
    "vmark.horizontalRule",
    (a) => blockConverters.convertThematicBreak(a.ctx, a.node as any),
  ],
  ["table", "vmark.tableUI", (a) => blockConverters.convertTable(a.ctx, a.node as any, a.marks)],
  ["math", "vmark.latex.mathBlock", (a) => blockConverters.convertMathBlock(a.ctx, a.node as any)],
  [
    "definition",
    "vmark.markdownArtifacts.linkDefinition",
    (a) => blockConverters.convertDefinition(a.ctx, a.node as any),
  ],
  [
    "footnoteDefinition",
    "vmark.footnotePopup.definition",
    (a) => blockConverters.convertFootnoteDefinition(a.ctx, a.node as any, a.marks),
  ],
  [
    "yaml",
    "vmark.markdownArtifacts.frontmatter",
    (a) => blockConverters.convertFrontmatter(a.ctx, a.node as any),
  ],
  [
    "html",
    "vmark.markdownArtifacts.html",
    (a) => blockConverters.convertHtml(a.ctx, a.node as any, a.position === "inline"),
  ],

  // ---- inline ----
  ["text", "vmark.text", (a) => inlineConverters.convertText(a.schema, a.node as any, a.marks)],
  [
    "strong",
    "vmark.bold",
    (a) =>
      inlineConverters.convertStrong(a.schema, a.node as any, a.marks, a.convertInlineChildren),
  ],
  [
    "emphasis",
    "vmark.italic",
    (a) =>
      inlineConverters.convertEmphasis(a.schema, a.node as any, a.marks, a.convertInlineChildren),
  ],
  [
    "delete",
    "vmark.strike",
    (a) =>
      inlineConverters.convertDelete(a.schema, a.node as any, a.marks, a.convertInlineChildren),
  ],
  [
    "inlineCode",
    "vmark.code",
    (a) => inlineConverters.convertInlineCode(a.schema, a.node as any, a.marks),
  ],
  [
    "link",
    "vmark.link",
    (a) => inlineConverters.convertLink(a.schema, a.node as any, a.marks, a.convertInlineChildren),
  ],
  [
    "image",
    "vmark.imageView",
    (a) => inlineConverters.convertImage(a.schema, a.node as any, a.marks),
  ],
  ["break", "vmark.hardBreak", (a) => inlineConverters.convertBreak(a.schema)],
  [
    "inlineMath",
    "vmark.latex.mathInline",
    (a) => inlineConverters.convertInlineMath(a.schema, a.node as any),
  ],
  [
    "footnoteReference",
    "vmark.footnotePopup.reference",
    (a) => inlineConverters.convertFootnoteReference(a.schema, a.node as any),
  ],
];

const CONVERTERS: ReadonlyMap<string, (a: A) => MdastToPmResult> = new Map(
  ENTRIES.map(([nodeType, , convert]) => [nodeType, convert]),
);

/**
 * Convert one mdast node through the table.
 *
 * Returns `{ handled: false }` for a type no converter claims — the caller
 * warns and yields nothing.
 */
export function tryMdastRegistry(
  args: MdastConvertArgs,
): { handled: true; result: MdastToPmResult } | { handled: false } {
  const convert = CONVERTERS.get(args.node.type);
  return convert ? { handled: true, result: convert(args) } : { handled: false };
}
