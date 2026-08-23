import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AskResolver } from "@herta/core";
import { FakeProvider } from "@herta/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createBackendStack } from "./session-wiring.js";

const originalEnv = { ...process.env };
const tmpDirs: string[] = [];
afterEach(() => {
  process.env = { ...originalEnv };
  for (const d of tmpDirs.splice(0))
    rmSync(d, { recursive: true, force: true });
});

function mkWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "herta-wiring-"));
  tmpDirs.push(dir);
  return dir;
}

const noAsk: AskResolver = {
  present: async () => "deny",
};

describe("createBackendStack", () => {
  it("standard contract: registers the MVP tool set and the file/command rules", () => {
    const root = mkWorkspace();
    let seen: { cacheSize: number; rulesListed: number } | null = null;
    const stack = createBackendStack({
      wsHolder: { current: root },
      workspaceRoot: root,
      lang: "zh",
      wantMinimal: false,
      backendProvider: new FakeProvider({ turns: [] }),
      digestModel: null,
      makeAsk: ({ cache, rules }) => {
        seen = { cacheSize: cache.size(), rulesListed: rules.list().length };
        return noAsk;
      },
    });
    expect(stack.contract).toBe("standard");
    expect(stack.bashPath).toBeNull();
    // The ask resolver was built from the SAME cache/rules the stack exposes.
    expect(seen).toEqual({ cacheSize: 0, rulesListed: 0 });
    const names = stack.backendTools.list().map((t) => t.name);
    expect(names).toContain("read_file");
    expect(names).toContain("edit_file");
    expect(names).toContain("run_command");
    expect(names).toContain("report_finding");
    // Both contracts mount the digest tool (ADR 0043) — with a null model it
    // answers `unavailable` instead of disappearing.
    expect(names).toContain("digest_document");
    expect(names).not.toContain("bash");
    expect(names).not.toContain("str_replace_editor");
  });

  it("minimal contract falls back to standard when no bash is found", () => {
    const root = mkWorkspace();
    // HERTA_BASH pointing at a nonexistent file makes findBash return null
    // without probing PATH — deterministic on every machine.
    process.env.HERTA_BASH = join(root, "no-such-bash.exe");
    const stack = createBackendStack({
      wsHolder: { current: root },
      workspaceRoot: root,
      lang: "en",
      wantMinimal: true,
      backendProvider: new FakeProvider({ turns: [] }),
      digestModel: null,
      makeAsk: () => noAsk,
    });
    expect(stack.contract).toBe("standard");
    expect(stack.bashPath).toBeNull();
    expect(stack.backendTools.list().map((t) => t.name)).not.toContain("bash");
  });
});
