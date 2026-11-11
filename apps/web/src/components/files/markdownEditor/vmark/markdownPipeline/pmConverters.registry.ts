/**
 * PM → mdast converter table.
 *
 * Purpose: dispatch for the PM → mdast direction, keyed on the ProseMirror node
 * type name. PM → mdast has no ambiguity: the node type is definitive.
 *
 * Not here, and deliberately:
 *   - Marks — `groupInlineItems` factors mark runs across ALL marks at once and
 *     cannot decompose per mark; that stays central by design.
 *   - `html_inline` and text — inline content goes through
 *     `convertInlineContent` in proseMirrorToMdast.ts.
 *
 * @coordinates-with proseMirrorToMdast.ts — the caller
 * @module utils/markdownPipeline/pmConverters.registry
 */
import type { Node as PMNode } from "@tiptap/pm/model";
import * as inlineConverters from "./pmInlineConverters";
import {
  convertAlertBlock,
  convertBlockImage,
  convertBlockquote,
  convertCodeBlock,
  convertDefinition,
  convertFrontmatter,
  convertHeading,
  convertHorizontalRule,
  convertHtmlBlock,
  convertList,
  convertListItem,
  convertParagraph,
  convertTable,
  type PmToMdastContext,
  type PmToMdastNode,
} from "./pmBlockConverters";
import { convertFootnoteDefinition } from "./pmFootnoteConverters";

export type PmToMdastResult = PmToMdastNode | PmToMdastNode[] | null;

type PmConverter = (node: PMNode, ctx: PmToMdastContext) => PmToMdastResult;

const CONVERTERS: ReadonlyMap<string, PmConverter> = new Map<string, PmConverter>([
  ["horizontalRule", () => convertHorizontalRule()],
  ["frontmatter", (node) => convertFrontmatter(node)],
  ["link_definition", (node) => convertDefinition(node)],
  ["html_block", (node) => convertHtmlBlock(node)],
  ["hardBreak", () => inlineConverters.convertHardBreak()],
  ["image", (node) => inlineConverters.convertImage(node)],
  ["math_inline", (node) => inlineConverters.convertMathInline(node)],
  ["footnote_reference", (node) => inlineConverters.convertFootnoteReference(node)],

  // ---- structural ----
  ["paragraph", (node, ctx) => convertParagraph(ctx, node)],
  ["heading", (node, ctx) => convertHeading(ctx, node)],
  ["codeBlock", (node) => convertCodeBlock(node)],
  ["blockquote", (node, ctx) => convertBlockquote(ctx, node)],
  ["alertBlock", (node, ctx) => convertAlertBlock(ctx, node)],
  ["bulletList", (node, ctx) => convertList(ctx, node, false)],
  ["orderedList", (node, ctx) => convertList(ctx, node, true)],
  ["listItem", (node, ctx) => convertListItem(ctx, node)],
  ["table", (node, ctx) => convertTable(ctx, node)],
  ["block_image", (node) => convertBlockImage(node)],
  ["footnote_definition", (node, ctx) => convertFootnoteDefinition(ctx, node)],
]);

/**
 * Convert one node through the table.
 *
 * Returns `{ handled: false }` for a node type no converter claims — the caller
 * warns and emits nothing.
 */
export function tryRegistry(
  node: PMNode,
  context: PmToMdastContext,
): { handled: true; result: PmToMdastResult } | { handled: false } {
  const convert = CONVERTERS.get(node.type.name);
  return convert ? { handled: true, result: convert(node, context) } : { handled: false };
}
