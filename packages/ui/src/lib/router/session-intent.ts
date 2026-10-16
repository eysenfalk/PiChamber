type SessionDraftLike = { open?: boolean; automatic?: boolean } | null | undefined;

/**
 * A draft with no materialized session is an explicit blank-chat intent.
 * A draft opened automatically because nothing was shown yet is only a
 * fallback: the start still restores the remembered session over it.
 */
export const isNewSessionDraftActive = (
  draft: SessionDraftLike,
  currentSessionId: string | null,
): boolean => draft?.open === true && draft.automatic !== true && currentSessionId === null;

/**
 * Resolve the session identity that belongs in the browser route.
 *
 * The Pi store may keep a selected session for background/folder continuity,
 * but that historical pointer is not the visible session while a new draft is
 * open.
 */
export const routeSessionIdForState = (input: {
  currentSessionId: string | null;
  piSelectedSessionId: string | null;
  draft: SessionDraftLike;
}): string | null => (
  input.currentSessionId
  ?? (isNewSessionDraftActive(input.draft, input.currentSessionId) ? null : input.piSelectedSessionId)
);

