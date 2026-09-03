/**
 * The abort predicate every provider seam uses — the retry loop, the SSE
 * reader and the deadline helpers — so an interrupt in flight is never
 * re-badged as a network failure, an SSE error, or an HTTP status. Since
 * 2026-09-03 it IS `@herta/core`'s `isAbortError` (name "AbortError" or
 * code "ABORT_ERR"); this file kept a wider copy of its own until the two
 * definitions were folded into one.
 */
export { isAbortError } from "@herta/core";

/** A fresh AbortError, named so `isAbortError` (both flavors) classifies it. */
export function abortError(message = "aborted"): Error {
  const e = new Error(message);
  e.name = "AbortError";
  return e;
}
