import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { spawnGit } from "../git/spawn-git.js";
import { mkTmpWorkspace } from "../testing/tmp-workspace.js";
import { mkToolContext } from "../testing/tool-context.js";
import { gitDiffTool } from "./index.js";

const GIT_AVAILABLE = (() => {
  try {
    const r = spawnSync("git", ["--version"], { stdio: "ignore" });
    return r.status === 0;
  } catch {
    return false;
  }
})();

async function seedRepo(root: string): Promise<void> {
  const sig = new AbortController().signal;
  await spawnGit(root, ["init", "-q"], sig);
  await spawnGit(root, ["config", "user.email", "test@example.com"], sig);
  await spawnGit(root, ["config", "user.name", "Test"], sig);
  await spawnGit(root, ["config", "commit.gpgsign", "false"], sig);
}

async function commitFile(
  root: string,
  rel: string,
  content: string,
  message: string,
): Promise<void> {
  await writeFile(join(root, rel), content, "utf8");
  const sig = new AbortController().signal;
  await spawnGit(root, ["add", rel], sig);
  await spawnGit(root, ["commit", "-q", "-m", message], sig);
}

// File-level timeout: every test here spawns several real git processes
// (init + config + add + commit + diff); under full-suite load these have
// been observed at 3.5s+ and one tripped the 5s default (flaked 2026-07-05).
describe.skipIf(!GIT_AVAILABLE)("git_diff tool", { timeout: 20_000 }, () => {
  it("rejects { staged: true, ref: 'HEAD' } with invalid_input", async () => {
    const ws = await mkTmpWorkspace({});
    try {
      const r = await gitDiffTool().run(
        {
          id: "c1",
          tool: "git_diff",
          input: { staged: true, ref: "HEAD" },
        },
        mkToolContext({ workspaceRoot: ws.root }),
        () => {},
      );
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe("invalid_input");
    } finally {
      await ws.cleanup();
    }
  });

  it("rejects ref with shell metacharacters via regex", async () => {
    const ws = await mkTmpWorkspace({});
    try {
      const r = await gitDiffTool().run(
        { id: "c1", tool: "git_diff", input: { ref: "HEAD; rm -rf" } },
        mkToolContext({ workspaceRoot: ws.root }),
        () => {},
      );
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe("invalid_input");
    } finally {
      await ws.cleanup();
    }
  });

  it("default mode: returns working-tree diff (staged + unstaged)", async () => {
    const ws = await mkTmpWorkspace({});
    try {
      await seedRepo(ws.root);
      await commitFile(ws.root, "a.txt", "hello\n", "init");
      await writeFile(join(ws.root, "a.txt"), "hello\nworld\n", "utf8");
      const r = await gitDiffTool().run(
        { id: "c1", tool: "git_diff", input: {} },
        mkToolContext({ workspaceRoot: ws.root }),
        () => {},
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const data = r.data as {
        mode: string;
        files: { path: string }[];
        empty: boolean;
      };
      expect(data.mode).toBe("working-tree");
      expect(data.empty).toBe(false);
      expect(data.files.some((f) => f.path === "a.txt")).toBe(true);
    } finally {
      await ws.cleanup();
    }
  });

  it("staged mode: returns only --cached diff", async () => {
    const ws = await mkTmpWorkspace({});
    try {
      await seedRepo(ws.root);
      await commitFile(ws.root, "a.txt", "hello\n", "init");
      await writeFile(join(ws.root, "a.txt"), "hello\nstaged\n", "utf8");
      await spawnGit(ws.root, ["add", "a.txt"], new AbortController().signal);
      await writeFile(
        join(ws.root, "a.txt"),
        "hello\nstaged\nunstaged\n",
        "utf8",
      );
      const r = await gitDiffTool().run(
        { id: "c1", tool: "git_diff", input: { staged: true } },
        mkToolContext({ workspaceRoot: ws.root }),
        () => {},
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const data = r.data as { mode: string; empty: boolean };
      expect(data.mode).toBe("staged");
      expect(data.empty).toBe(false);
    } finally {
      await ws.cleanup();
    }
  });

  it("ref mode with bad ref returns git_failed", async () => {
    const ws = await mkTmpWorkspace({});
    try {
      await seedRepo(ws.root);
      await commitFile(ws.root, "a.txt", "hi\n", "init");
      const r = await gitDiffTool().run(
        { id: "c1", tool: "git_diff", input: { ref: "no-such-ref" } },
        mkToolContext({ workspaceRoot: ws.root }),
        () => {},
      );
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe("git_failed");
    } finally {
      await ws.cleanup();
    }
  });

  // 2026-08-25: against real git, the `--stat` parser reported a 400-insertion
  // change as +66 (it counted a histogram git scales to terminal width) and
  // returned `.../X.tsx` for any long path — which read_file, show_excerpt and
  // report_finding all reject, so the answer could not become a next step.
  it.runIf(GIT_AVAILABLE)(
    "reports real line counts and whole paths, against real git",
    async () => {
      const ws = await mkTmpWorkspace({});
      try {
        await seedRepo(ws.root);
        await commitFile(ws.root, "f.txt", "base\n", "base");
        const deep =
          "packages/gui/src/renderer/components/Conversation/Controller.tsx";
        await import("node:fs/promises").then((fs) =>
          fs.mkdir(join(ws.root, deep, ".."), { recursive: true }),
        );
        await commitFile(ws.root, deep, "a\n", "deep");
        await writeFile(
          join(ws.root, "f.txt"),
          `base\n${Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n")}\n`,
          "utf8",
        );
        const r = await gitDiffTool().run(
          { id: "1", tool: "git_diff", input: {} },
          mkToolContext({ workspaceRoot: ws.root }),
          () => {},
        );
        expect(r.ok).toBe(true);
        const data = r.data as {
          totalAdditions: number;
          files: readonly { path: string; additions: number }[];
        };
        // The f.txt entry specifically — the workspace fixture may carry other
        // files, and the point is that THIS count is the real one.
        const f = data.files.find((x) => x.path === "f.txt");
        expect(f?.additions).toBe(400);
        for (const x of data.files)
          expect(x.path.startsWith("...")).toBe(false);
        expect(data.files.some((x) => x.path.includes("Controller.tsx"))).toBe(
          false,
        );
      } finally {
        await ws.cleanup();
      }
    },
  );

  it("rejects a ref that is really an option", async () => {
    // `-` is a literal in the ref character class, so `--ext-diff` used to
    // validate — and git parses it as an OPTION (exit 0), re-enabling the
    // external diff driver this tool passes `--no-ext-diff` to disable, in a
    // readOnly tool that raises no approval card.
    const ws = await mkTmpWorkspace({});
    try {
      for (const ref of ["--ext-diff", "-c", "--output=/tmp/x"]) {
        const r = await gitDiffTool().run(
          { id: "1", tool: "git_diff", input: { ref } },
          mkToolContext({ workspaceRoot: ws.root }),
          () => {},
        );
        expect(r.ok, ref).toBe(false);
        expect(r.error?.code, ref).toBe("invalid_input");
      }
    } finally {
      await ws.cleanup();
    }
  });
});
