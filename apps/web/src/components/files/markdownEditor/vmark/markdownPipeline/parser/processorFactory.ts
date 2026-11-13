/**
 * Unified processor factory.
 *
 * `createProcessor` builds — and caches — a content-aware processor for the
 * editor pipeline (lazy plugin loading).
 *
 * @module utils/markdownPipeline/parser/processorFactory
 */

import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkFrontmatter from "remark-frontmatter";
import remarkBreaks from "remark-breaks";
import type { MarkdownPipelineOptions } from "../types";
import {
  analyzeContent,
  remarkDepthLimit,
  remarkDisableSetextHeadings,
  remarkValidateMath,
  type ContentAnalysis,
} from "./remarkPlugins";
import { remarkResolveReferences } from "./resolveReferences";

/**
 * Build a unified processor configured for markdown parsing. Order is
 * significant: remark plugin order affects tokenisation.
 *
 * - remark-parse: Always (base CommonMark parser)
 * - remark-gfm: Always (tables, task lists, strikethrough, autolinks);
 *   single-tilde strikethrough OFF
 * - remarkDisableSetextHeadings: Only if the document holds an indented lone
 *   list marker, the one shape it repairs
 * - remark-math + remarkValidateMath: Only if document contains `$`
 * - remarkDepthLimit: Always (flattens adversarially deep trees)
 * - remark-frontmatter: Only if document opens with a closed `---` fence
 * - remarkResolveReferences: Always
 * - remark-breaks: Only with the `preserveLineBreaks` option
 */
function buildProcessor(analysis: ContentAnalysis, preserveLineBreaks: boolean) {
  const processor = unified().use(remarkParse).use(remarkGfm, { singleTilde: false });
  if (analysis.hasAmbiguousListUnderline) processor.use(remarkDisableSetextHeadings);
  if (analysis.hasMath) processor.use(remarkMath);
  processor.use(remarkDepthLimit);
  if (analysis.hasMath) processor.use(remarkValidateMath);
  if (analysis.hasFrontmatter) processor.use(remarkFrontmatter, ["yaml"]);
  processor.use(remarkResolveReferences);
  if (preserveLineBreaks) processor.use(remarkBreaks);
  return processor;
}

/** Stable cache key over every input that changes the plugin set. */
function processorCacheKey(analysis: ContentAnalysis, preserveLineBreaks: boolean): string {
  return [
    analysis.hasMath,
    analysis.hasFrontmatter,
    analysis.hasAmbiguousListUnderline,
    preserveLineBreaks,
  ]
    .map((flag) => (flag ? "1" : "0"))
    .join("");
}

/**
 * Cache of built processors keyed by content-analysis flags. A unified
 * processor is safe to reuse across `.parse()`/`.runSync()` calls once its
 * plugin set is fixed, so caching avoids rebuilding the pipeline on every
 * parse. Bounded by the flag combination space (2^4 entries).
 */
const processorCache = new Map<string, ReturnType<typeof buildProcessor>>();

/**
 * Return a unified processor matching the markdown's plugin needs.
 *
 * Processors are cached by content-analysis flags: every parse that needs the
 * same plugin set reuses one processor instead of reconstructing it.
 */
export function createProcessor(markdown: string, options: MarkdownPipelineOptions = {}) {
  const analysis = analyzeContent(markdown);
  const preserveLineBreaks = options.preserveLineBreaks === true;
  const key = processorCacheKey(analysis, preserveLineBreaks);

  const cached = processorCache.get(key);
  if (cached) return cached;

  const processor = buildProcessor(analysis, preserveLineBreaks);
  processorCache.set(key, processor);
  return processor;
}
