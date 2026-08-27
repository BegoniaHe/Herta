import type { HertaBridge } from "../ipc/bridge-types.js";
import type { SessionStore } from "../store/session-store.js";

/**
 * Send a user message: optimistically echo it, then dispatch to the backend.
 * If the backend reports no DeepSeek key is set (`needsKey`), open the no-key
 * onboarding card holding this text (the saved key re-submits it). Shared by
 * the Composer and the KeyPrompt's re-send so the no-key handling lives in one
 * place.
 *
 * `submitText` resolves at TURN END for a real turn (so the `.then` lands late
 * and is a no-op by then — the real user block long since replaced the echo),
 * but resolves IMMEDIATELY in the no-key case (the session pre-checks the key
 * before running anything).
 */
export function submitMessage(
  bridge: HertaBridge,
  store: SessionStore,
  text: string,
  /** Pictures staged in the composer that ride THIS message (ADR 0048 §4).
   *  Their record blocks land right after the user block. */
  stagedImageIds?: readonly string[],
): void {
  store.markPendingUser(text);
  bridge.submitText(text, stagedImageIds).then(
    (result) => {
      if (result && "needsKey" in result) {
        store.requestKeyPrompt(text);
      }
    },
    () => {
      // Rejection path (audit 2026-07-10): `session.submitText` can throw the
      // single-turn invariant BEFORE emitting any lifecycle event (e.g. the
      // narrow idle-frame window while the opening seed / orphan-reply turn
      // is claiming the session), so no turn.started/failed safety net will
      // ever clear the optimistic echo — the phantom user bubble stuck until
      // the next successful turn. Withdraw the echo and restore the text to
      // the composer so nothing the user typed is lost.
      store.withdrawPendingUser(text);
    },
  );
}
