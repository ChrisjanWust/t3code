/**
 * Types for the markdown pipeline
 *
 * @module utils/markdownPipeline/types
 */

export interface MarkdownPipelineOptions {
  preserveLineBreaks?: boolean;
  hardBreakStyle?: "backslash" | "twoSpaces";
  /**
   * When true, re-emit captured inter-block blank-line runs (the
   * `blankLinesBefore` PM attribute) instead of collapsing them to a single
   * blank line. Default false = legacy output.
   */
  preserveBlankLines?: boolean;
}
