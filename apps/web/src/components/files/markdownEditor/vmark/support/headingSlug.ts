/**
 * Heading Slug Utilities
 *
 * Generates stable, unique IDs for document headings.
 *
 * @module utils/headingSlug
 */

/**
 * Generate a URL-safe slug from heading text.
 * Follows GitHub-style slug generation: keeps all Unicode letters
 * (Latin, Han, kana, hangul, ...), combining marks, and numbers.
 */
export function generateSlug(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, "") // Keep letters, marks, numbers, spaces, underscores, hyphens
    .replace(/\s+/g, "-") // Spaces to hyphens
    .replace(/-+/g, "-") // Collapse multiple hyphens
    .replace(/^-|-$/g, ""); // Trim leading/trailing hyphens
}

/**
 * Make a slug unique by appending a counter if needed.
 */
export function makeUniqueSlug(slug: string, existing: Set<string>): string {
  if (!slug) return "";
  if (!existing.has(slug)) return slug;

  let counter = 1;
  while (existing.has(`${slug}-${counter}`)) {
    counter++;
  }
  return `${slug}-${counter}`;
}
