import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { probeRepoState } from "./repo-probe.js";

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
