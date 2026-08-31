/**
 * Locate the file name inside a localized row body (ADR 0050 §1). The
 * digest carries the path verbatim while the verb localizes around it, so
 * a substring split is exact when it works — and when it doesn't (a
 * projection or localization change reworded the arg), the row must
 * degrade to plain text, never to a broken control. Last occurrence on
 * purpose: a verb could legally contain the arg's characters, the tail
 * position cannot.
 */
export function splitBodyAtPath(
  body: string,
  path: string,
): {
  readonly before: string;
  readonly name: string;
  readonly after: string;
} | null {
  if (path.length === 0) return null;
  const idx = body.lastIndexOf(path);
  if (idx < 0) return null;
  return {
    before: body.slice(0, idx),
    name: path,
    after: body.slice(idx + path.length),
  };
}
