/**
 * Markdown Pipeline — Barrel Export
 *
 * Purpose: Remark-based markdown parsing and serialization (vendored from VMark).
 * Uses MDAST as the intermediate representation between markdown text
 * and ProseMirror documents.
 *
 * Architecture:
 *   markdown string → [parser] → MDAST → [mdastToProseMirror] → PM doc
 *   PM doc → [proseMirrorToMdast] → MDAST → [serializer] → markdown string
 *
 * Key decisions:
 *   - MDAST chosen as IR because remark ecosystem provides robust parsing
 *     and serialization, plus plugin support for GFM/math/frontmatter
 *   - GitHub alerts are read from blockquotes; `<details>`, `<video>` and
 *     other raw HTML stay html_block / html_inline
 *
 * @module utils/markdownPipeline
 *
 * @example
 * import { parseMarkdown, serializeMarkdown } from './markdownPipeline';
 * const doc = parseMarkdown(schema, "# Hello");
 * const md = serializeMarkdown(schema, doc);
 */

// Adapter - unified interface
export { parseMarkdown, serializeMarkdown } from "./adapter";

// Types
export * from "./types";
