import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Electron is a path string under Node, so the real `app`/`safeStorage` are
// absent in tests. Mock them: `app.getPath` points at a per-test temp dir, and
// `safeStorage` does a reversible toy "encryption" so the round-trip is real.
const state = vi.hoisted(() => ({ userData: "", encAvailable: true }));
vi.mock("electron", () => ({
  app: { getPath: () => state.userData },
  safeStorage: {
    isEncryptionAvailable: () => state.encAvailable,
    encryptString: (s: string) => Buffer.from(`enc:${s}`, "utf-8"),
    decryptString: (b: Buffer) => b.toString("utf-8").replace(/^enc:/, ""),
  },
}));

import {
  clearDeepSeekKey,
  clearMiniMaxKey,
  clearMiniMaxPlanKey,
  getDeepSeekKeyStatus,
  getMiniMaxKeyStatus,
  getMiniMaxPlanKeyStatus,
  readDeepSeekKeyPlain,
  readMiniMaxKeyPlain,
  readMiniMaxPlanKeyPlain,
  setDeepSeekKey,
  setMiniMaxKey,
  setMiniMaxPlanKey,
} from "./key-store.js";

describe("key-store", () => {
  beforeEach(() => {
    state.userData = mkdtempSync(join(tmpdir(), "herta-key-store-"));
    state.encAvailable = true;
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("round-trips: set → readPlain returns the key, status is masked (last4)", () => {
    const r = setDeepSeekKey("sk-abcd1234");
    expect(r.encrypted).toBe(true);
    expect(readDeepSeekKeyPlain()).toBe("sk-abcd1234");
    expect(getDeepSeekKeyStatus()).toEqual({
      set: true,
      hint: "1234",
      encrypted: true,
    });
  });

  it("trims the key on write", () => {
    setDeepSeekKey("  sk-spaced  ");
    expect(readDeepSeekKeyPlain()).toBe("sk-spaced");
  });

  it("reports no key before anything is stored", () => {
    expect(readDeepSeekKeyPlain()).toBeNull();
    expect(getDeepSeekKeyStatus()).toEqual({
      set: false,
      hint: null,
      encrypted: false,
    });
  });

  it("clear removes the key", () => {
    setDeepSeekKey("sk-tobecleared");
    clearDeepSeekKey();
    expect(readDeepSeekKeyPlain()).toBeNull();
    expect(getDeepSeekKeyStatus().set).toBe(false);
  });

  it("setting an empty key clears the store", () => {
    setDeepSeekKey("sk-first");
    const r = setDeepSeekKey("   ");
    expect(r.encrypted).toBe(false);
    expect(readDeepSeekKeyPlain()).toBeNull();
  });

  it("falls back to plaintext when encryption is unavailable (flagged)", () => {
    state.encAvailable = false;
    const r = setDeepSeekKey("sk-plain1234");
    expect(r.encrypted).toBe(false);
    expect(readDeepSeekKeyPlain()).toBe("sk-plain1234");
    expect(getDeepSeekKeyStatus()).toEqual({
      set: true,
      hint: "1234",
      encrypted: false,
    });
  });

  it("a fresh write does not leave a stale file from the other mode", () => {
    state.encAvailable = false;
    setDeepSeekKey("sk-plainfirst");
    // Encryption becomes available; the next write must clear the .txt fallback
    // so readPlain does not see the stale plaintext.
    state.encAvailable = true;
    setDeepSeekKey("sk-enc-second99");
    expect(readDeepSeekKeyPlain()).toBe("sk-enc-second99");
    expect(getDeepSeekKeyStatus().encrypted).toBe(true);
  });

  // ── the MiniMax key (ADR 0062) ────────────────────────────────────────────

  it("the MiniMax key has its own store: setting one never touches the other", () => {
    setDeepSeekKey("sk-deepseek-1111");
    const r = setMiniMaxKey("sk-api-minimax-2222");
    expect(r.encrypted).toBe(true);
    expect(readMiniMaxKeyPlain()).toBe("sk-api-minimax-2222");
    expect(getMiniMaxKeyStatus()).toEqual({
      set: true,
      hint: "2222",
      encrypted: true,
    });
    expect(readDeepSeekKeyPlain()).toBe("sk-deepseek-1111");
    clearMiniMaxKey();
    expect(readMiniMaxKeyPlain()).toBeNull();
    expect(getMiniMaxKeyStatus().set).toBe(false);
    expect(readDeepSeekKeyPlain()).toBe("sk-deepseek-1111");
  });

  it("the MiniMax token-plan key is a third store beside the pay-as-you-go one (ADR 0062 §1.8)", () => {
    setMiniMaxKey("sk-api-minimax-2222");
    const r = setMiniMaxPlanKey("sk-cp-plan-3333");
    expect(r.encrypted).toBe(true);
    expect(readMiniMaxPlanKeyPlain()).toBe("sk-cp-plan-3333");
    expect(getMiniMaxPlanKeyStatus()).toEqual({
      set: true,
      hint: "3333",
      encrypted: true,
    });
    expect(readMiniMaxKeyPlain()).toBe("sk-api-minimax-2222");
    clearMiniMaxPlanKey();
    expect(readMiniMaxPlanKeyPlain()).toBeNull();
    expect(readMiniMaxKeyPlain()).toBe("sk-api-minimax-2222");
  });
});
