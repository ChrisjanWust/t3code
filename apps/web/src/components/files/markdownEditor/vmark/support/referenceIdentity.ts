/**
 * Reference identity carried by nodes that came from Markdown image syntax.
 *
 * Purpose: `![alt][id]` is resolved to an inline image for editing — the
 * editor needs a real `src` to render — but must serialize back as the
 * reference the author wrote. The node therefore carries `referenceId` /
 * `referenceType` attrs (default null). If the user changes `src`, the editor
 * must clear them: re-emitting `![alt][id]` would point at the OLD definition.
 *
 * @module utils/referenceIdentity
 */

/** The reference a resolved image node came from, if any. */
interface ReferenceIdentity {
  referenceId: string | null;
  referenceType: string | null;
}

/** Read reference identity off arbitrary node attrs, normalising absent to null. */
export function readReferenceIdentity(
  attrs: Record<string, unknown> | undefined,
): ReferenceIdentity {
  const id = attrs?.referenceId;
  const type = attrs?.referenceType;
  return {
    referenceId: typeof id === "string" && id !== "" ? id : null,
    referenceType: typeof type === "string" && type !== "" ? type : null,
  };
}
