import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { diffCommittedRange, probeRepoState } from "./repo-probe.js";

const GIT_AVAILABLE = (() => {
  try {
    return spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
})();

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function mkDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

describe.skipIf(!GIT_AVAILABLE)("probeRepoState", { timeout: 20_000 }, () => {
  const git = (dir: string, ...a: string[]) =>
    spawnSync("git", a, { cwd: dir, encoding: "utf8" });

  function seeded(): string {
    const dir = mkDir("probe-");
    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "user.email", "t@t");
    git(dir, "config", "user.name", "T");
    git(dir, "config", "commit.gpgsign", "false");
    writeFileSync(join(dir, "a.ts"), "one\n");
    writeFileSync(join(dir, "b.ts"), "two\n");
    writeFileSync(join(dir, "gone.ts"), "three\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "init");
    return dir;
  }

  it("returns null on abort instead of throwing through its own contract", async () => {
    // `spawnGit` REJECTS on abort — correctly, since an interrupt is not a
    // tool failure — so a user's Stop landing mid-probe threw straight past
    // "returns null rather than throwing for every cannot-tell case". One
    // caller happened to wrap it; the invariant must not depend on that.
    const dir = seeded();
    const ac = new AbortController();
    ac.abort();
    await expect(probeRepoState(dir, ac.signal)).resolves.toBeNull();
  });

  it("separates what the dispatch changed from what was already dirty", async () => {
    const dir = seeded();
    // The USER has uncommitted work before the dispatch starts.
    writeFileSync(join(dir, "a.ts"), "one\nuser edit\n");
    const before = await probeRepoState(dir);
    expect(before?.dirty).toEqual(["a.ts"]);

    // 板砖 works through the SHELL — no editor tool involved, and one of these
    // is a DELETE, which no editor can even express.
    writeFileSync(join(dir, "b.ts"), "two\nbanzhuan\n");
    writeFileSync(join(dir, "new.ts"), "created\n");
    unlinkSync(join(dir, "gone.ts"));

    const after = await probeRepoState(dir);
    expect(after?.head).toBe(before?.head);
    const wasDirty = new Set(before?.dirty ?? []);
    const attributed = (after?.dirty ?? []).filter((p) => !wasDirty.has(p));
    expect(attributed.sort()).toEqual(["b.ts", "gone.ts", "new.ts"]);
    expect(attributed).not.toContain("a.ts");
  });

  it("reports an unborn branch as head null rather than failing", async () => {
    const dir = mkDir("probe-unborn-");
    git(dir, "init", "-q", "-b", "main");
    const snap = await probeRepoState(dir);
    expect(snap).not.toBeNull();
    expect(snap?.head).toBeNull();
  });

  it("returns null outside a repo, and never throws", async () => {
    await expect(probeRepoState(mkDir("probe-plain-"))).resolves.toBeNull();
    await expect(
      probeRepoState(join(mkDir("probe-gone-"), "no-such-dir")),
    ).resolves.toBeNull();
  });

  it("counts both sides of a rename as changed", async () => {
    const dir = seeded();
    const before = await probeRepoState(dir);
    git(dir, "mv", "a.ts", "renamed.ts");
    const after = await probeRepoState(dir);
    const wasDirty = new Set(before?.dirty ?? []);
    const attributed = (after?.dirty ?? []).filter((p) => !wasDirty.has(p));
    // The new path exists and the old one is gone — both are changes.
    expect(attributed.sort()).toEqual(["a.ts", "renamed.ts"]);
  });
});

describe.skipIf(!GIT_AVAILABLE)(
  "diffCommittedRange",
  { timeout: 20_000 },
  () => {
    const git = (dir: string, ...a: string[]) =>
      spawnSync("git", a, { cwd: dir, encoding: "utf8" });
    const head = (dir: string) =>
      git(dir, "rev-parse", "HEAD").stdout?.trim() ?? "";

    function seeded(): string {
      const dir = mkDir("range-");
      git(dir, "init", "-q", "-b", "main");
      git(dir, "config", "user.email", "t@t");
      git(dir, "config", "user.name", "T");
      git(dir, "config", "commit.gpgsign", "false");
      writeFileSync(join(dir, "a.ts"), "one\n");
      writeFileSync(join(dir, "gone.ts"), "three\n");
      git(dir, "add", "-A");
      git(dir, "commit", "-qm", "init");
      return dir;
    }

    it("attributes a forward range — add, modify, delete, and a rename as delete+create", async () => {
      const dir = seeded();
      const from = head(dir);
      writeFileSync(join(dir, "a.ts"), "one\nmore\n");
      writeFileSync(join(dir, "new.ts"), "created\n");
      unlinkSync(join(dir, "gone.ts"));
      git(dir, "add", "-A");
      git(dir, "commit", "-qm", "work");
      git(dir, "mv", "a.ts", "renamed.ts");
      git(dir, "commit", "-qm", "rename");
      const to = head(dir);

      const range = await diffCommittedRange(dir, from, to);
      expect(range).not.toBeNull();
      const byPath = new Map(range?.map((f) => [f.path, f.kind]));
      // --no-renames: the rename is honestly a delete + a create.
      expect(byPath.get("a.ts")).toBe("deleted");
      expect(byPath.get("renamed.ts")).toBe("created");
      expect(byPath.get("new.ts")).toBe("created");
      expect(byPath.get("gone.ts")).toBe("deleted");
    });

    it("returns null when the new head does not descend from the old (amend)", async () => {
      const dir = seeded();
      writeFileSync(join(dir, "a.ts"), "one\ntwo\n");
      git(dir, "add", "-A");
      git(dir, "commit", "-qm", "work");
      const from = head(dir);
      git(dir, "commit", "-q", "--amend", "-m", "work, amended");
      const to = head(dir);
      expect(to).not.toBe(from);
      await expect(diffCommittedRange(dir, from, to)).resolves.toBeNull();
    });

    it("rejects anything that is not a commit id — an option can never reach argv", async () => {
      const dir = seeded();
      const to = head(dir);
      await expect(
        diffCommittedRange(dir, "--ext-diff", to),
      ).resolves.toBeNull();
      await expect(diffCommittedRange(dir, to, "HEAD~1")).resolves.toBeNull();
    });

    it("returns null on abort and outside a repo, never throwing", async () => {
      const dir = seeded();
      const h = head(dir);
      const ac = new AbortController();
      ac.abort();
      await expect(
        diffCommittedRange(dir, h, h, ac.signal),
      ).resolves.toBeNull();
      await expect(
        diffCommittedRange(mkDir("range-plain-"), h, h),
      ).resolves.toBeNull();
    });
  },
);
