import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { describeLog } from "./log-list.js";

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

describe.skipIf(!GIT_AVAILABLE)(
  "describeLog (ADR 0059 §6)",
  { timeout: 60_000 },
  () => {
    const git = (dir: string, ...a: string[]) =>
      spawnSync("git", a, { cwd: dir, encoding: "utf8" });

    function seeded(commits: number): string {
      const dir = mkDir("log-");
      git(dir, "init", "-q", "-b", "main");
      git(dir, "config", "user.email", "t@t");
      git(dir, "config", "user.name", "Tester");
      git(dir, "config", "commit.gpgsign", "false");
      writeFileSync(join(dir, "a.ts"), "one\n");
      git(dir, "add", "-A");
      git(dir, "commit", "-qm", "step 1");
      for (let i = 2; i <= commits; i += 1) {
        git(dir, "commit", "-q", "--allow-empty", "-m", `step ${i}`);
      }
      return dir;
    }

    it("pages newest first, and hasMore is a fact from the extra row", async () => {
      const dir = seeded(7);
      const first = await describeLog(dir, { skip: 0, limit: 3 });
      expect(first?.entries.map((e) => e.subject)).toEqual([
        "step 7",
        "step 6",
        "step 5",
      ]);
      expect(first?.hasMore).toBe(true);
      expect(first?.upstream).toBeNull();
      expect(first?.entries[0]?.sha).toMatch(/^[0-9a-f]{40}$/);
      expect(first?.entries[0]?.shortSha).toMatch(/^[0-9a-f]{4,}$/);
      expect(first?.entries[0]?.author).toBe("Tester");
      expect(first?.entries[0]?.authoredAt).toMatch(/^\d{4}-/);
      expect(first?.entries.every((e) => !e.unpushed)).toBe(true);
      const last = await describeLog(dir, { skip: 6, limit: 3 });
      expect(last?.entries.map((e) => e.subject)).toEqual(["step 1"]);
      expect(last?.hasMore).toBe(false);
      expect(last?.skip).toBe(6);
    });

    it("marks the commits not on the upstream — the rev-list set, not the first N", async () => {
      const dir = seeded(2);
      const origin = mkDir("log-origin-");
      git(origin, "init", "-q", "--bare");
      git(dir, "remote", "add", "origin", origin);
      git(dir, "push", "-q", "-u", "origin", "main");
      git(dir, "commit", "-q", "--allow-empty", "-m", "local only 1");
      git(dir, "commit", "-q", "--allow-empty", "-m", "local only 2");
      const page = await describeLog(dir, { skip: 0, limit: 10 });
      expect(page?.upstream).toBe("origin/main");
      expect(page?.entries.map((e) => [e.subject, e.unpushed])).toEqual([
        ["local only 2", true],
        ["local only 1", true],
        ["step 2", false],
        ["step 1", false],
      ]);
    });

    it("an unborn repository has an empty page; bad paging and no repo answer null", async () => {
      const dir = mkDir("log-unborn-");
      git(dir, "init", "-q", "-b", "main");
      const page = await describeLog(dir, { skip: 0, limit: 10 });
      expect(page?.entries).toEqual([]);
      expect(page?.hasMore).toBe(false);
      const seededDir = seeded(1);
      await expect(
        describeLog(seededDir, { skip: -1, limit: 10 }),
      ).resolves.toBeNull();
      await expect(
        describeLog(seededDir, { skip: 0, limit: 0 }),
      ).resolves.toBeNull();
      await expect(
        describeLog(mkDir("log-plain-"), { skip: 0, limit: 10 }),
      ).resolves.toBeNull();
    });
  },
);
