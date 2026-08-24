import { realpathSync, statSync } from "node:fs";
import { parse, resolve, sep } from "node:path";

export type WorkspaceRootCheck =
  | { ok: true; resolved: string }
  | {
      ok: false;
      code: "ws_not_found" | "ws_not_dir" | "ws_forbidden_root";
      message: string;
    };

/** Known OS/system directory prefixes (both platforms; checked equals-or-inside). */
const SYSTEM_DIRS = [
  "C:\\Windows",
  "C:\\Program Files",
  "C:\\Program Files (x86)",
  "/etc",
  "/usr",
  "/bin",
  "/sbin",
  "/var",
  "/System",
  "/Library",
  "/private",
];

/**
 * Canonicalize a workspace root through symlinks (audit S8).
 *
 * `resolveSafePath` realpaths every candidate file and then prefix-compares it
 * against the root. If the root itself is a symlink, those two can never
 * match: with the root at `/tmp/proj`, `a.ts` canonicalizes to
 * `/private/tmp/proj/a.ts`, which does not start with `/tmp/proj`, so EVERY
 * file operation is denied as outside the workspace. That is the whole of
 * macOS's `/tmp` and `/var`, plus any project reached through a symlink or a
 * Windows junction. The test suite already knew: `testing/tmp-workspace.ts`
 * realpaths its own root precisely so the suite does not hit this.
 *
 * NATIVE realpath first (user report 2026-08-24): `resolveSafePath` uses
 * `fsPromises.realpath`, which has native semantics — on Windows it resolves
 * subst and mapped network drives (`F:\ws` → `C:\real\ws` or `\\srv\share\ws`),
 * which the JS `realpathSync` walk does not (a drive mapping is not a reparse
 * point on any path component). A root canonicalized with the JS walk while
 * candidates canonicalize natively re-creates the S8 symptom wholesale for a
 * workspace on a mapped drive: even `resolveSafePath(root, ".")` is denied,
 * so 板砖 cannot run a single command. Both sides must share ONE semantics.
 * The JS walk stays as the middle fallback: on filesystems where the native
 * call fails (some network redirectors), candidate realpaths fail too and
 * `resolveSafePath` degrades to lexical prefix checks — the JS result keeps
 * the root in that same un-resolved spelling, so the two still agree.
 *
 * Falls back to the lexical resolve when the path does not exist — the caller
 * is about to reject it anyway, and a fallback keeps the error "no such
 * directory" instead of an EIO from deep inside a resolver.
 */
export function canonicalWorkspaceRoot(input: string): string {
  const lexical = resolve(input);
  try {
    return realpathSync.native(lexical);
  } catch {
    try {
      return realpathSync(lexical);
    } catch {
      return lexical;
    }
  }
}

/**
 * macOS reaches `/etc`, `/var` and `/tmp` through symlinks into `/private`, so
 * canonicalizing turns every one of them into a `/private/...` path. Comparing
 * those against SYSTEM_DIRS directly gets both answers wrong at once:
 * `/private/etc` is genuinely a system directory but is not spelled like one,
 * and `/private/tmp/proj` is ordinary scratch space that would be refused
 * merely for living under the `/private` entry.
 *
 * Stripping the prefix before the comparison restores the intent of the list —
 * `/private/etc` → `/etc` (refused, correctly), `/private/tmp/proj` →
 * `/tmp/proj` (allowed). `/private` itself stays on the list for the literal
 * case.
 */
function stripPrivatePrefix(p: string): string {
  return p.startsWith("/private/") ? p.slice("/private".length) : p;
}

/**
 * Ordinary user-writable scratch space that happens to sit inside a
 * SYSTEM_DIRS entry. `/var` is on that list for Linux (`/var/log`,
 * `/var/lib`), but on macOS `/var/folders/<hash>/T` is simply where
 * `os.tmpdir()` points — the user's own per-account temp directory, with no
 * system files in it. Refusing it there while accepting `/tmp` on Linux was
 * an accident of the list, not a decision.
 */
const SCRATCH_EXCEPTIONS = ["/var/folders"];

function eqOrInside(child: string, parent: string): boolean {
  const c = child.toLowerCase();
  const p = parent.toLowerCase();
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/** Same equals-or-inside check but with a fixed "/" boundary, for comparing
 *  slash-normalized strings independent of the host platform separator. */
function eqOrInsideSlash(child: string, parent: string): boolean {
  const c = child.toLowerCase();
  const p = parent.toLowerCase();
  return c === p || c.startsWith(p.endsWith("/") ? p : `${p}/`);
}

/**
 * Validate a USER-SUPPLIED backend-workspace root (deterministic, D4). Rejects
 * a drive/filesystem root, the home root itself, OS/system dirs, and anything
 * at or under `<home>/.herta`. The managed default (under ~/.herta/workspaces)
 * is set by trusted internal code paths and must NOT pass through here.
 */
export function validateWorkspaceRoot(
  input: string,
  opts: { home: string },
): WorkspaceRootCheck {
  if (typeof input !== "string" || input.length === 0) {
    return { ok: false, code: "ws_not_found", message: "empty path" };
  }
  // Canonical from here down (audit S8): this string becomes the workspace
  // root every later path check compares against, so it has to be the same
  // form resolveSafePath produces for the files inside it.
  const resolved = canonicalWorkspaceRoot(input);
  const home = canonicalWorkspaceRoot(opts.home);

  if (parse(resolved).root === resolved) {
    return {
      ok: false,
      code: "ws_forbidden_root",
      message: `refusing a filesystem root: ${resolved}`,
    };
  }
  if (resolved.toLowerCase() === home.toLowerCase()) {
    return {
      ok: false,
      code: "ws_forbidden_root",
      message: `refusing the home directory: ${resolved}`,
    };
  }
  if (eqOrInside(resolved, resolve(home, ".herta"))) {
    return {
      ok: false,
      code: "ws_forbidden_root",
      message: `refusing a path under ~/.herta: ${resolved}`,
    };
  }
  // Match against the resolved path AND the raw, slash-normalized input so a
  // POSIX-style system path (e.g. "/etc") is rejected even on Windows, where
  // resolve() would rewrite it onto the current drive (C:\etc) and lose intent.
  const rawNormalized = input.replace(/\\/g, "/");
  // Both forms, because each catches what the other cannot: the canonical one
  // catches a symlink the user made that points into /etc, the raw one catches
  // a POSIX system path typed on Windows, where resolve() would rewrite "/etc"
  // onto the current drive (C:\etc) and lose the intent.
  const canonical = stripPrivatePrefix(resolved.replace(/\\/g, "/"));
  const isScratch = SCRATCH_EXCEPTIONS.some(
    (p) => eqOrInsideSlash(canonical, p) || eqOrInsideSlash(rawNormalized, p),
  );
  for (const dir of isScratch ? [] : SYSTEM_DIRS) {
    const dirSlash = dir.replace(/\\/g, "/");
    if (
      eqOrInsideSlash(canonical, dirSlash) ||
      eqOrInsideSlash(rawNormalized, dirSlash)
    ) {
      return {
        ok: false,
        code: "ws_forbidden_root",
        message: `refusing a system directory: ${resolved}`,
      };
    }
  }
  if (resolved.toLowerCase().split(sep).includes("system32")) {
    return {
      ok: false,
      code: "ws_forbidden_root",
      message: `refusing a system directory: ${resolved}`,
    };
  }
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(resolved);
  } catch {
    return {
      ok: false,
      code: "ws_not_found",
      message: `no such directory: ${resolved}`,
    };
  }
  if (!st.isDirectory()) {
    return {
      ok: false,
      code: "ws_not_dir",
      message: `not a directory: ${resolved}`,
    };
  }
  return { ok: true, resolved };
}
