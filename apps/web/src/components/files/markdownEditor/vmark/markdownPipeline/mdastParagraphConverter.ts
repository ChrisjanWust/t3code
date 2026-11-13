/**
 * MDAST Paragraph Converter
 *
 * Purpose: Converts paragraph MDAST nodes to ProseMirror nodes. A paragraph
 * holding a lone image child becomes a block_image (when the schema has one);
 * everything else is an ordinary paragraph.
 *
 * @coordinates-with mdastBlockConverters.ts — re-export hub for all block converters
 * @module utils/markdownPipeline/mdastParagraphConverter
 */

import type { Node as PMNode, Mark } from "@tiptap/pm/model";
import type { Content, Image, Paragraph } from "mdast";
import * as inlineConverters from "./mdastInlineConverters";
import { getSourceLine, type MdastToPmContext } from "./mdastConverterHelpers";

/** The paragraph's only child when it is an image node, else null. */
function soleImageChild(node: Paragraph): Image | null {
  if (node.children.length !== 1) return null;
  const child = node.children[0];
  return child?.type === "image" ? child : null;
}

/** block_image built from the inline image converter. */
function buildBlockImage(
  context: MdastToPmContext,
  image: Image,
  sourceLine: number | null,
): PMNode | null {
  const blockImageType = context.schema.nodes.block_image;
  if (!blockImageType) return null;
  const imageNode = inlineConverters.convertImage(context.schema, image);
  if (!imageNode) return null;
  return blockImageType.create({
    src: imageNode.attrs.src ?? "",
    alt: imageNode.attrs.alt ?? "",
    title: imageNode.attrs.title ?? "",
    sourceLine,
    // A lone `![alt][id]` promoted to a block image must still remember the
    // reference, or saving rewrites it inline and orphans the definition.
    referenceId: imageNode.attrs.referenceId ?? null,
    referenceType: imageNode.attrs.referenceType ?? null,
  });
}

export function convertParagraph(
  context: MdastToPmContext,
  node: Paragraph,
  marks: Mark[],
): PMNode | null {
  const type = context.schema.nodes.paragraph;
  if (!type) return null;
  const sourceLine = getSourceLine(node);

  const image = soleImageChild(node);
  // A block image may decline to build (schema lacks the node type);
  // preserving the paragraph is always safe.
  const blockImage = image ? buildBlockImage(context, image, sourceLine) : null;
  if (blockImage) return blockImage;

  return type.create(
    { sourceLine },
    context.convertChildren(node.children as Content[], marks, "inline"),
  );
}
