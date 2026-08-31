import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_VIEWER_BYTES,
  readWorkspaceFileBounded,
  resolveInsideWorkspace,
} from "./read-workspace-file.js";

const roots: string[] = [];
afterEach(async () => {
  for (const r of roots.splice(0))
    await rm(r, { recursive: true, force: true });
});
async function mkRoot(): Promise<string> {
  const r = await mkdtemp(join(tmpdir(), "viewer-read-"));
  roots.push(r);
  return r;
}

describe("readWorkspaceFileBounded (ADR 0050 §2)", () => {
  it("reads a workspace-relative text file with its relative path", async () => {
    const ws = await mkRoot();
    await mkdir(join(ws, "src"));
    await writeFile(join(ws, "src", "a.ts"), "one\ntwo\n");
    const r = await readWorkspaceFileBounded(ws, "src/a.ts");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.content).toBe("one\ntwo\n");
    expect(r.relative).toBe("src/a.ts");
    expect(r.truncated).toBe(false);
  });

  it("refuses paths that resolve outside the workspace", async () => {
    const ws = await mkRoot();
    const outside = await mkRoot();
    await writeFile(join(outside, "secret.txt"), "x");
    for (const p of [
      join(outside, "secret.txt"),
      `../${outside.split(/[\\/]/).pop()}/secret.txt`,
    ]) {
      const r = await readWorkspaceFileBounded(ws, p);
      expect(r.ok, p).toBe(false);
      if (!r.ok) expect(r.reason).toBe("outside_workspace");
    }
  });

  it("a symlink is judged by where it lands, not where it sits", async () => {
    const ws = await mkRoot();
    const outside = await mkRoot();
    await writeFile(join(outside, "target.txt"), "x");
    try {
      await symlink(join(outside, "target.txt"), join(ws, "innocent.txt"));
    } catch {
      return; // no symlink privilege on this machine — nothing to prove
    }
    const r = await readWorkspaceFileBounded(ws, "innocent.txt");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("outside_workspace");
  });

  it("a missing in-workspace file is not_found, not a jail message", async () => {
    const ws = await mkRoot();
    const r = await readWorkspaceFileBounded(ws, "gone.txt");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not_found");
  });

  it("a directory is not_a_file", async () => {
    const ws = await mkRoot();
    await mkdir(join(ws, "dir"));
    const r = await readWorkspaceFileBounded(ws, "dir");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not_a_file");
  });

  it("binary content answers binary instead of mojibake", async () => {
    const ws = await mkRoot();
    await writeFile(join(ws, "b.bin"), Buffer.from([0x89, 0x50, 0x00, 0x47]));
    const r = await readWorkspaceFileBounded(ws, "b.bin");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("binary");
  });

  it("an oversized file returns a truncated prefix and the honest size", async () => {
    const ws = await mkRoot();
    const big = "x".repeat(MAX_VIEWER_BYTES + 10_000);
    await writeFile(join(ws, "big.txt"), big);
    const r = await readWorkspaceFileBounded(ws, "big.txt");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.truncated).toBe(true);
    expect(r.content.length).toBe(MAX_VIEWER_BYTES);
    expect(r.size).toBe(big.length);
  });

  it("resolveInsideWorkspace normalizes to forward slashes", async () => {
    const ws = await mkRoot();
    await mkdir(join(ws, "a", "b"), { recursive: true });
    await writeFile(join(ws, "a", "b", "c.txt"), "x");
    const r = await resolveInsideWorkspace(ws, join("a", "b", "c.txt"));
    expect(r.kind === "ok" ? r.relative : r.kind).toBe("a/b/c.txt");
  });
});
