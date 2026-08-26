import type {
  PermissionRule,
  RulePermissionEngine,
  RuleVerdict,
  ToolCallRequest,
  ToolContext,
} from "@herta/core";
import { formatInputIssues } from "../input-issues.js";
import { resolveSafePath } from "../path-safety.js";
import { classifyCommand } from "./classifier.js";
import { checkReaderArgvPaths } from "./reader-guard.js";
import { runCommandInputSchema } from "./schema.js";

export function makeRunCommandRule(): PermissionRule {
  return async (
    call: ToolCallRequest,
    ctx: ToolContext,
  ): Promise<RuleVerdict> => {
    const parsed = runCommandInputSchema.safeParse(call.input);
    if (!parsed.success) {
      return {
        kind: "deny",
        code: "invalid_input",
        reason: formatInputIssues(parsed.error),
      };
    }
    const { argv, cwd } = parsed.data;

    const safe = await resolveSafePath(ctx.workspaceRoot, cwd ?? ".");
    if (!safe.ok) {
      return { kind: "deny", code: safe.code, reason: safe.message };
    }

    const verdict = classifyCommand(argv);
    if (verdict.kind === "block") {
      return {
        kind: "deny",
        code: verdict.code,
        reason: verdict.reason,
      };
    }
    if (verdict.kind === "allow") {
      // The classifier auto-allowed a reader after a TEXT-only argv check; an
      // innocent-basename symlink whose realpath leaves the repo or names a
      // credential slips that check (audit T3.4). Realpath the operands now
      // (the rule is async and has the effective cwd) and hard-deny a
      // disguised read — matching read_file.
      const readerDenial = await checkReaderArgvPaths(
        ctx.workspaceRoot,
        safe.resolved,
        argv,
      );
      if (readerDenial !== null) {
        // A refused READ (2026-08-26, same as the bash rule's reader guard):
        // withheld information, not a refused mutation — must not cap the
        // brief's status.
        return {
          kind: "deny",
          code: readerDenial.code,
          reason: readerDenial.message,
          risk: "workspace_read",
        };
      }
      return { kind: "allow" };
    }
    return {
      kind: "ask",
      reason: verdict.reason,
      risk: verdict.risk,
      code: verdict.code,
    };
  };
}

export function registerRunCommandRule(engine: RulePermissionEngine): void {
  engine.registerRule("run_command", makeRunCommandRule());
}
