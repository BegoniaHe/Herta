import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import {
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  HertaTool,
  ToolCallRequest,
  ToolContext,
  ToolResult,
  ToolSchema,
} from "@herta/core";
import { errResult } from "../errors.js";
import { formatInputIssues } from "../input-issues.js";
import { resolveSafePath } from "../path-safety.js";
import { writeNewFileInputSchema, writeNewFileJsonSchema } from "./schema.js";

export type { WriteNewFileRuleDeps } from "./rule.js";
export { makeWriteNewFileRule, registerWriteNewFileRule } from "./rule.js";
export type { WriteNewFileInput } from "./schema.js";

const MAX_CONTENT_BYTES = 10 * 1024 * 1024;

export interface WriteNewFileData {
  relPath: string;
  bytesWritten: number;
  sha256: string;
}

function basenameOf(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i < 0 ? p : p.slice(i + 1);
}

export function writeNewFileTool(): HertaTool {
  return {
    name: "write_new_file",
    schema(): ToolSchema {
      return {
        name: "write_new_file",
        description:
          "Create a new UTF-8 text file with the given content. Refuses to overwrite existing files (use edit_file for that). Auto-creates missing parent directories within the workspace.",
        inputSchema: writeNewFileJsonSchema,
      };
    },
    async run(
      call: ToolCallRequest,
      ctx: ToolContext,
    ): Promise<ToolResult<WriteNewFileData>> {
      const parsed = writeNewFileInputSchema.safeParse(call.input);
      if (!parsed.success) {
        return errResult(
          "invalid_input",
          formatInputIssues(parsed.error),
          "usage: {path, content}",
          "invalid input",
        );
      }
      const { path, content } = parsed.data;

      const safe = await resolveSafePath(ctx.workspaceRoot, path, {
        mutation: true,
      });
      if (!safe.ok) {
        return errResult(
          safe.code,
          safe.message,
          undefined,
          `denied: ${safe.message}`,
        );
      }

      const byteLength = Buffer.byteLength(content, "utf-8");
      if (byteLength > MAX_CONTENT_BYTES) {
        return errResult(
          "file_too_large",
          `${byteLength} bytes > cap ${MAX_CONTENT_BYTES}`,
          "split into smaller files",
          `too large: ${safe.relative}`,
        );
      }

      let info: Stats | null = null;
      try {
        info = await stat(safe.resolved);
      } catch (err: unknown) {
        const code = (err as { code?: string }).code;
        if (code !== "ENOENT") {
          return errResult(
            "read_failed",
            (err as Error).message ?? "stat failed",
            undefined,
            "stat failed",
          );
        }
      }
      if (info !== null) {
        return errResult(
          "file_exists",
          `${safe.relative} already exists${info.isDirectory() ? " (directory)" : ""}`,
          "use edit_file to modify existing files",
          `exists: ${safe.relative}`,
        );
      }

      const parentDir = dirname(safe.resolved);
      try {
        await mkdir(parentDir, { recursive: true });
      } catch (err: unknown) {
        return errResult(
          "write_failed",
          (err as Error).message ?? "mkdir failed",
          undefined,
          "mkdir failed",
        );
      }

      const contentBuf = Buffer.from(content, "utf-8");
      const tmp = join(
        parentDir,
        `.${basenameOf(safe.resolved)}.herta-tmp-${randomUUID()}`,
      );
      try {
        await writeFile(tmp, contentBuf, { flag: "wx" });
      } catch (err: unknown) {
        const code = (err as { code?: string }).code;
        return errResult(
          "write_failed",
          (err as Error).message ?? "temp write failed",
          undefined,
          "write failed",
          code === "EBUSY" || code === "EAGAIN",
        );
      }
      try {
        await rename(tmp, safe.resolved);
      } catch (err: unknown) {
        try {
          await unlink(tmp);
        } catch {
          // best-effort
        }
        const code = (err as { code?: string }).code;
        return errResult(
          "write_failed",
          (err as Error).message ?? "rename failed",
          undefined,
          "rename failed",
          code === "EBUSY" || code === "EAGAIN",
        );
      }

      const newBuf = await readFile(safe.resolved);
      const sha256 = createHash("sha256").update(newBuf).digest("hex");
      ctx.reads.record(safe.resolved, sha256);

      const data: WriteNewFileData = {
        relPath: safe.relative,
        bytesWritten: contentBuf.byteLength,
        sha256,
      };
      return {
        ok: true,
        data,
        summary: `wrote ${safe.relative} (${contentBuf.byteLength} bytes)`,
      };
    },
  };
}
