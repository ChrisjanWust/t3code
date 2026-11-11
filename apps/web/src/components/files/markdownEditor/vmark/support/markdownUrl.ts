/**
 * Markdown URL helper: which URLs need the angle-bracket `<url>` destination
 * form (CommonMark) because they contain whitespace.
 *
 * @module utils/markdownUrl
 */

/** Pattern matching whitespace characters that need special handling in markdown URLs */
const WHITESPACE_PATTERN = /[\s\u00A0\u2002-\u200A\u202F\u205F\u3000]/;

/**
 * Check if a URL contains whitespace that needs angle bracket wrapping.
 */
export function urlNeedsBrackets(url: string): boolean {
  if (!url) return false;
  return WHITESPACE_PATTERN.test(url);
}
