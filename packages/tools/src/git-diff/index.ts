import type {
  HertaTool,
  ToolCallRequest,
  ToolContext,
  ToolResult,
  ToolSchema,
} from "@herta/core";
import { errResult } from "../errors.js";
import { type GitDiffFile, parseDiffStatZ } from "../git/parse-diff-stat.js";
import { hardenedGitArgs, spawnGit } from "../git/spawn-git.js";
import { formatInputIssues } from "../input-issues.js";
import { gitDiffInputSchema, gitDiffJsonSchema } from "./schema.js";

export type { GitDiffFile } from "../git/parse-diff-stat.js";
export type { GitDiffInput } from "./schema.js";

export interface GitDiffData {
  mode: "working-tree" | "staged" | "ref";
  ref?: string;
  files: readonly GitDiffFile[];
  totalAdditions: number;
  totalDeletions: number;
  empty: boolean;
}

export function gitDiffTool(): HertaTool {
  return {
    name: "git_diff",
    readOnly: true,
    schema(): ToolSchema {
      return {
        name: "git_diff",
        description:
          "Return a structured per-file diff summary: exact added/deleted line counts and full repo-relative paths. Defaults to working-tree-vs-HEAD. Pass { staged: true } for staged-only or { ref } for vs-ref (a ref, not an option). ref and staged are mutually exclusive. Read-only.",
        inputSchema: gitDiffJsonSchema,
      };
    },
    async run(
      call: ToolCallRequest,
      ctx: ToolContext,
    ): Promise<ToolResult<GitDiffData>> {
      const parsed = gitDiffInputSchema.safeParse(call.input);
      if (!parsed.success) {
        return errResult(
          "invalid_input",
          formatInputIssues(parsed.error),
          "usage: {} or {staged: true} or {ref} — staged and ref are exclusive",
          "invalid input",
        );
      }
      const input = parsed.data;

      // `--numstat -z` rather than `--stat`: real counts and full paths (see
      // parseDiffStatZ). `--no-ext-diff` / `--no-textconv` stop a REPOSITORY's
      // own config turning this read-only tool into a program launcher, and
      // the trailing `--` ends the revision list so nothing after it can be
      // read as an option.
      const base = [
        "diff",
        "--numstat",
        "-z",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
      ];
      let mode: GitDiffData["mode"];
      let argv: string[];
      if (input.staged === true) {
        mode = "staged";
        argv = [...base, "--cached", "--"];
      } else if (input.ref !== undefined) {
        mode = "ref";
        argv = [...base, input.ref, "--"];
      } else {
        mode = "working-tree";
        argv = [...base, "HEAD", "--"];
      }

      const r = await spawnGit(
        ctx.workspaceRoot,
        hardenedGitArgs(argv),
        ctx.signal,
      );
      if (!r.ok) {
        if (r.code === "not_a_repo") {
          return errResult(
            "not_a_repo",
            r.message,
            "this workspace is not a git repository — git tools are unavailable",
            "not a git repo",
          );
        }
        if (r.code === "git_timeout") {
          return errResult(
            "git_timeout",
            r.message,
            undefined,
            "git timed out",
          );
        }
        if (r.code === "spawn_failed") {
          // Say which failure it was. Overriding this with a blanket "git is
          // not on PATH" told a user whose workspace drive had vanished to
          // install software they already had.
          return errResult(
            "spawn_failed",
            r.message,
            r.cause === "git_not_found"
              ? "install git, or add it to PATH, and restart"
              : r.cause === "workspace_missing"
                ? "the workspace path is gone — reopen the project"
                : undefined,
            "spawn failed",
          );
        }
        return errResult("git_failed", r.message, undefined, "git failed");
      }

      const stat = parseDiffStatZ(r.stdout);
      const data: GitDiffData = {
        mode,
        ...(mode === "ref" && input.ref !== undefined
          ? { ref: input.ref }
          : {}),
        files: stat.files,
        totalAdditions: stat.totalAdditions,
        totalDeletions: stat.totalDeletions,
        empty: stat.files.length === 0,
      };
      const summary = data.empty
        ? "no diff"
        : `${data.files.length} files, +${data.totalAdditions}/-${data.totalDeletions}`;
      return { ok: true, data, summary };
    },
  };
}
