import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HertaBridgeProvider } from "../../context/HertaBridgeContext.js";
import { renderWithLocale } from "../../i18n/test-util.js";
import { createMockHertaBridge } from "../../ipc/mock-bridge.js";
import { isVoicePlaying, playVoiceClip } from "../../voice/play-voice.js";
import { Composer } from "./Composer.js";
import { WorkspaceRefsProvider } from "./WorkspaceRefs.js";

afterEach(() => {
  cleanup();
});

function renderComposer(mock = createMockHertaBridge()) {
  return {
    mock,
    ...renderWithLocale(
      <WorkspaceRefsProvider>
        <HertaBridgeProvider bridge={mock.bridge}>
          <Composer />
        </HertaBridgeProvider>
      </WorkspaceRefsProvider>,
    ),
  };
}

describe("Composer", () => {
  it("renders the input with placeholder + send button", () => {
    renderComposer();
    expect(screen.getByPlaceholderText("Message Herta…")).toBeInTheDocument();
    expect(screen.getByLabelText("Send message")).toBeInTheDocument();
  });

  it("disables the send button when input is empty or whitespace", () => {
    renderComposer();
    const send = screen.getByLabelText("Send message") as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    const input = screen.getByPlaceholderText("Message Herta…");
    fireEvent.change(input, { target: { value: "   " } });
    expect(send.disabled).toBe(true);
  });

  it("enables the send button when input has non-whitespace content", () => {
    renderComposer();
    const send = screen.getByLabelText("Send message") as HTMLButtonElement;
    const input = screen.getByPlaceholderText("Message Herta…");
    fireEvent.change(input, { target: { value: "hi" } });
    expect(send.disabled).toBe(false);
  });

  it("clears the input on submit", () => {
    renderComposer();
    const input = screen.getByPlaceholderText(
      "Message Herta…",
    ) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    expect(input.value).toBe("");
  });

  /** Activate a session in the given interaction language. */
  function activate(
    mock: ReturnType<typeof createMockHertaBridge>,
    lang: "zh" | "en",
  ): void {
    act(() =>
      mock.emitReset({
        sessionId: `s-${lang}`,
        workspaceRoot: "/mock",
        record: [],
        overlay: null,
        backendWorkspace: "/mock",
        backendWorkspaceIsDefault: true,
        lang,
      }),
    );
  }

  it("translates a typed @brick to the wire token @板砖 on submit in an EN session", () => {
    const { mock } = renderComposer();
    activate(mock, "en");
    const input = screen.getByPlaceholderText(
      "Message Herta…",
    ) as HTMLTextAreaElement;
    fireEvent.change(input, {
      target: { value: "hand @Brick the parser bug" },
    });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    // The record/dispatch gets the wire token — the alias never reaches the model.
    expect(mock.calls.submitText).toEqual(["hand @板砖 the parser bug"]);
  });

  it("does NOT translate an embedded @brick (email / scoped pkg) — no false dispatch", () => {
    // The `@` must START a mention; an embedded @brick must reach dispatch raw.
    const { mock } = renderComposer();
    activate(mock, "en");
    const input = screen.getByPlaceholderText(
      "Message Herta…",
    ) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "email me at bob@brick.io" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    expect(mock.calls.submitText).toEqual(["email me at bob@brick.io"]);
  });

  it("does NOT translate a backticked `@brick` — code spans are quotation (audit 2026-07-16)", () => {
    const { mock } = renderComposer();
    activate(mock, "en");
    const input = screen.getByPlaceholderText(
      "Message Herta…",
    ) as HTMLTextAreaElement;
    fireEvent.change(input, {
      target: { value: "how do I write `@brick` here?" },
    });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    expect(mock.calls.submitText).toEqual(["how do I write `@brick` here?"]);
  });

  it("mixed line: converts outside a code span, keeps the span verbatim", () => {
    const { mock } = renderComposer();
    activate(mock, "en");
    const input = screen.getByPlaceholderText(
      "Message Herta…",
    ) as HTMLTextAreaElement;
    fireEvent.change(input, {
      target: { value: "ask @brick about `@brick --help` please" },
    });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    expect(mock.calls.submitText).toEqual([
      "ask @板砖 about `@brick --help` please",
    ]);
  });

  it("does NOT translate @brick in a zh session (the alias is EN-only)", () => {
    const { mock } = renderComposer();
    activate(mock, "zh");
    const input = screen.getByPlaceholderText(
      "Message Herta…",
    ) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "@brick x" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    expect(mock.calls.submitText).toEqual(["@brick x"]);
  });

  it("shows the completion ghost as 'brick' in EN and '板砖' in zh", () => {
    const { mock, container } = renderComposer();
    const input = screen.getByPlaceholderText(
      "Message Herta…",
    ) as HTMLTextAreaElement;
    // A boundary '@' with the caret right after it arms the hint (via onSelect,
    // driven deterministically here rather than relying on change-caret).
    const armHint = (): void => {
      fireEvent.change(input, { target: { value: "@" } });
      input.setSelectionRange(1, 1);
      fireEvent.select(input);
    };
    activate(mock, "en");
    armHint();
    expect(container.querySelector(".composer-ghost")?.textContent).toBe(
      "brick",
    );
    activate(mock, "zh");
    armHint();
    expect(container.querySelector(".composer-ghost")?.textContent).toBe(
      "板砖",
    );
  });

  it("clears the draft when the active session changes", () => {
    const { mock } = renderComposer();
    const input = screen.getByPlaceholderText(
      "Message Herta…",
    ) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "unsent draft" } });
    expect(input.value).toBe("unsent draft");
    // The active session changes (delete the old session, connect a new one) —
    // the draft must NOT carry over into the new session's composer.
    act(() =>
      mock.emitReset({
        sessionId: "new-session",
        workspaceRoot: "/mock",
        record: [],
        overlay: null,
        backendWorkspace: "/mock",
        backendWorkspaceIsDefault: true,
      }),
    );
    expect(input.value).toBe("");
  });

  it("submit calls bridge.submitText + clears input", () => {
    const { mock } = renderComposer();
    const input = screen.getByPlaceholderText(
      "Message Herta…",
    ) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    expect(mock.calls.submitText).toContain("hello");
    expect(input.value).toBe("");
  });

  it("busy disables the textarea and swaps send for an ENABLED stop button", () => {
    const { mock } = renderComposer();
    const input = screen.getByPlaceholderText(
      "Message Herta…",
    ) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "hi" } });
    act(() => {
      mock.emitReset({
        sessionId: "s",
        workspaceRoot: "/r",
        record: [],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
      mock.emitTurn({ kind: "started", turnId: "t1" });
    });
    expect(input.disabled).toBe(true);
    // The send button is REPLACED by a stop button — the one escape hatch
    // for a hung turn, so it must stay clickable while everything else is
    // disabled.
    expect(screen.queryByLabelText("Send message")).not.toBeInTheDocument();
    const stop = screen.getByLabelText(
      "Interrupt the current turn",
    ) as HTMLButtonElement;
    expect(stop.disabled).toBe(false);
  });

  it("send and stop are the SAME element morphing (transition prerequisite)", () => {
    // The cross-fade between ↑ and ■ only works if React keeps one DOM node
    // and toggles `.is-stop` — two conditional <button>s would remount and
    // skip the CSS transition (the abrupt swap; user 2026-07-04).
    const { mock } = renderComposer();
    const send = screen.getByLabelText("Send message");
    act(() => {
      mock.emitReset({
        sessionId: "s",
        workspaceRoot: "/r",
        record: [],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
      mock.emitTurn({ kind: "started", turnId: "t1" });
    });
    const stop = screen.getByLabelText("Interrupt the current turn");
    expect(stop).toBe(send);
    expect(stop.classList.contains("is-stop")).toBe(true);
    // Both glyphs stay mounted so they can cross-fade.
    expect(stop.querySelector(".composer-send__glyph--send")).not.toBeNull();
    expect(stop.querySelector(".composer-send__glyph--stop")).not.toBeNull();
  });

  it("clicking stop calls bridge.interrupt", () => {
    const { mock } = renderComposer();
    act(() => {
      mock.emitReset({
        sessionId: "s",
        workspaceRoot: "/r",
        record: [],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
      mock.emitTurn({ kind: "started", turnId: "t1" });
    });
    fireEvent.click(screen.getByLabelText("Interrupt the current turn"));
    expect(mock.calls.interrupt).toHaveLength(1);
  });

  it("clicking stop cuts in-flight voice on the click (opening skip finishes the turn normally, so the failed-cut never fires)", () => {
    // Minimal Audio stand-in so playVoiceClip can track a live element.
    class FakeAudio {
      currentTime = 0;
      volume = 1;
      play = (): Promise<void> => Promise.resolve();
      pause = (): void => undefined;
      addEventListener = (): void => undefined;
    }
    vi.stubGlobal("Audio", FakeAudio as never);
    const { mock } = renderComposer();
    act(() => {
      mock.emitReset({
        sessionId: "s",
        workspaceRoot: "/r",
        record: [],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
      mock.emitTurn({ kind: "started", turnId: "t1" });
    });
    // The opening voice cue starts a clip mid-turn.
    playVoiceClip("openings", "015-archive-cleanup");
    expect(isVoicePlaying()).toBe(true);
    fireEvent.click(screen.getByLabelText("Interrupt the current turn"));
    expect(isVoicePlaying()).toBe(false);
    vi.unstubAllGlobals();
  });

  it("refocuses the textarea when the turn ends", () => {
    const { mock } = renderComposer();
    const input = screen.getByPlaceholderText(
      "Message Herta…",
    ) as HTMLTextAreaElement;
    act(() => {
      mock.emitReset({
        sessionId: "s",
        workspaceRoot: "/r",
        record: [],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
      mock.emitTurn({ kind: "started", turnId: "t1" });
    });
    expect(input.disabled).toBe(true); // disabling blurred it
    act(() => {
      mock.emitTurn({ kind: "finished", turnId: "t1" });
    });
    expect(document.activeElement).toBe(input);
  });

  it("rests shrunk; focus expands; blur outside re-shrinks, draft kept (owner 2026-08-20)", () => {
    renderComposer();
    const form = document.querySelector(".composer") as HTMLFormElement;
    const input = screen.getByPlaceholderText(
      "Message Herta…",
    ) as HTMLTextAreaElement;
    // The resting state is shrunk — full height belongs to active focus.
    expect(form.classList.contains("is-shrunk")).toBe(true);
    fireEvent.focus(input);
    expect(form.classList.contains("is-shrunk")).toBe(false);
    // An UNSENT draft does not hold the height: clicking away (relatedTarget
    // outside the form / null) shrinks, and the draft survives.
    fireEvent.change(input, { target: { value: "draft, not sent" } });
    fireEvent.blur(input);
    expect(form.classList.contains("is-shrunk")).toBe(true);
    expect(input.value).toBe("draft, not sent");
  });

  it("focus moving WITHIN the form (textarea → attach) does not shrink", () => {
    renderComposer();
    const form = document.querySelector(".composer") as HTMLFormElement;
    const input = screen.getByPlaceholderText(
      "Message Herta…",
    ) as HTMLTextAreaElement;
    const attach = document.querySelector(
      ".composer-attach",
    ) as HTMLButtonElement;
    fireEvent.focus(input);
    expect(form.classList.contains("is-shrunk")).toBe(false);
    // Clicking the attach button blurs the textarea with the button as
    // relatedTarget — still inside the form, so the height must hold
    // (a shrink here would move the button under the pointer mid-click).
    fireEvent.blur(input, { relatedTarget: attach });
    expect(form.classList.contains("is-shrunk")).toBe(false);
  });

  it("focus landing on the attach BUTTON from outside does not expand (owner 2026-08-20)", () => {
    renderComposer();
    const form = document.querySelector(".composer") as HTMLFormElement;
    const attach = document.querySelector(
      ".composer-attach",
    ) as HTMLButtonElement;
    expect(form.classList.contains("is-shrunk")).toBe(true);
    // Only the CARET expands; a button holding focus is not "ready to
    // type" — this was the expand half of the attach-button bounce.
    fireEvent.focus(attach);
    expect(form.classList.contains("is-shrunk")).toBe(true);
  });

  it("the file picker freezes the height; its close hands the caret to the field", async () => {
    // Hanging picker promise: resolves when the test says the dialog closed.
    let resolvePick: (p: readonly string[] | null) => void = () => {};
    const mock = createMockHertaBridge();
    mock.bridge.pickAttachments = () =>
      new Promise((resolve) => {
        resolvePick = resolve;
      });
    renderComposer(mock);
    const form = document.querySelector(".composer") as HTMLFormElement;
    const input = screen.getByPlaceholderText(
      "Message Herta…",
    ) as HTMLTextAreaElement;
    const attach = document.querySelector(
      ".composer-attach",
    ) as HTMLButtonElement;
    // From the textarea, open the picker (focus moves within — held).
    fireEvent.focus(input);
    fireEvent.blur(input, { relatedTarget: attach });
    fireEvent.click(attach);
    expect(form.classList.contains("is-shrunk")).toBe(false);
    // The native dialog steals WINDOW focus: focusout with relatedTarget
    // null. While the picker is open this must NOT shrink.
    fireEvent.blur(attach);
    expect(form.classList.contains("is-shrunk")).toBe(false);
    // Cancel: the caret lands in the field and the height stays expanded —
    // never the owner-reported "expanded with focus stuck on the button".
    await act(async () => {
      resolvePick(null);
    });
    expect(document.activeElement).toBe(input);
    expect(form.classList.contains("is-shrunk")).toBe(false);
  });

  it("the turn-end auto-refocus restores the height by itself", () => {
    const { mock } = renderComposer();
    const form = document.querySelector(".composer") as HTMLFormElement;
    const input = screen.getByPlaceholderText(
      "Message Herta…",
    ) as HTMLTextAreaElement;
    act(() => {
      mock.emitReset({
        sessionId: "s",
        workspaceRoot: "/r",
        record: [],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
    });
    act(() => {
      input.focus();
    });
    fireEvent.change(input, { target: { value: "hi" } });
    act(() => {
      fireEvent.submit(form);
      mock.emitTurn({ kind: "started", turnId: "t1" });
    });
    // The turn-start edge shrinks WITHOUT any blur event: Chrome drops focus
    // from a disabled element silently (no blur/focusout — live 2026-08-20),
    // so the busy effect clears the state itself.
    expect(form.classList.contains("is-shrunk")).toBe(true);
    // Native blur so activeElement really moves (jsdom keeps focus on
    // disable) and the turn-end refocus below is a genuine focus change.
    act(() => {
      input.blur();
    });
    act(() => {
      mock.emitTurn({ kind: "finished", turnId: "t1" });
    });
    // The refocus effect put the caret back → focus-within expands again.
    expect(document.activeElement).toBe(input);
    expect(form.classList.contains("is-shrunk")).toBe(false);
  });
});

describe("Composer Enter-to-send (IME-safe)", () => {
  it("Enter submits the trimmed draft", () => {
    const { mock } = renderComposer();
    const input = screen.getByPlaceholderText(
      "Message Herta…",
    ) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "你好，黑塔" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mock.calls.submitText).toContain("你好，黑塔");
    expect(input.value).toBe("");
  });

  it("Shift+Enter does NOT submit (newline stays manual)", () => {
    const { mock } = renderComposer();
    const input = screen.getByPlaceholderText(
      "Message Herta…",
    ) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "line one" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(mock.calls.submitText).toHaveLength(0);
    expect(input.value).toBe("line one");
  });

  it("Enter during IME composition does NOT submit (isComposing)", () => {
    // A zh user confirming a pinyin candidate presses Enter with a live
    // composition — that must select the candidate, never send the message.
    const { mock } = renderComposer();
    const input = screen.getByPlaceholderText(
      "Message Herta…",
    ) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "nihao" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(mock.calls.submitText).toHaveLength(0);
    expect(input.value).toBe("nihao");
  });

  it("Enter with keyCode 229 (IME engines post-compositionend) does NOT submit", () => {
    const { mock } = renderComposer();
    const input = screen.getByPlaceholderText(
      "Message Herta…",
    ) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "nihao" } });
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    expect(mock.calls.submitText).toHaveLength(0);
  });

  it("Enter on an empty draft is a no-op", () => {
    const { mock } = renderComposer();
    const input = screen.getByPlaceholderText(
      "Message Herta…",
    ) as HTMLTextAreaElement;
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mock.calls.submitText).toHaveLength(0);
  });
});

describe("Composer send button ref", () => {
  it("renders a send button that carries the workspace send ref", () => {
    renderComposer();
    const send = screen.getByLabelText("Send message");
    expect(send.tagName).toBe("BUTTON");
  });
});

describe("Composer send tooltip", () => {
  it("shows NO tooltip on the send button (self-evident control; user 2026-06-13)", () => {
    // Scoped to the SEND button since the attach button gained a tooltip
    // (ADR 0033, owner 2026-08-10) — the 2026-06-13 decision was about the
    // arrow being self-evident, not a composer-wide tooltip ban.
    const { container } = renderComposer();
    const send = screen.getByRole("button", { name: "Send message" });
    expect(send).not.toHaveAttribute("title");
    expect(send.closest(".tooltip-wrap")).toBeNull();
    // Exactly one tooltip in the composer, and it belongs to attach.
    const wraps = container.querySelectorAll(".tooltip-wrap");
    expect(wraps).toHaveLength(1);
    expect(wraps[0]?.querySelector(".composer-attach")).not.toBeNull();
  });
});

describe("Composer @板砖 overlay", () => {
  it("renders a composer-mention chip in the overlay for a full @板砖", () => {
    renderComposer();
    const input = screen.getByPlaceholderText(
      "Message Herta…",
    ) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "重构 @板砖" } });
    const chip = document.querySelector(".composer-mention");
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toBe("@板砖");
  });

  it("the overlay is aria-hidden (not an accessibility duplicate)", () => {
    renderComposer();
    expect(document.querySelector(".composer-highlight")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });

  it("EN session: the overlay chips a typed @brick LITERALLY (what the user actually types)", () => {
    const { mock } = renderComposer();
    act(() =>
      mock.emitReset({
        sessionId: "s-en",
        workspaceRoot: "/mock",
        record: [],
        overlay: null,
        backendWorkspace: "/mock",
        backendWorkspaceIsDefault: true,
        lang: "en",
      }),
    );
    const input = screen.getByPlaceholderText(
      "Message Herta…",
    ) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "hand @Brick this" } });
    const chip = document.querySelector(".composer-mention");
    expect(chip).not.toBeNull();
    // Literal matched text, case preserved — the overlay must stay
    // metric-identical to the textarea (never a substitution).
    expect(chip?.textContent).toBe("@Brick");
    expect(
      document.querySelector(".composer-highlight")?.textContent,
    ).toContain("hand @Brick this");
  });

  it("zh session: a typed @brick does NOT chip (the input alias is EN-only)", () => {
    const { mock } = renderComposer();
    act(() =>
      mock.emitReset({
        sessionId: "s-zh",
        workspaceRoot: "/mock",
        record: [],
        overlay: null,
        backendWorkspace: "/mock",
        backendWorkspaceIsDefault: true,
        lang: "zh",
      }),
    );
    const input = screen.getByPlaceholderText(
      "Message Herta…",
    ) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "hand @brick this" } });
    expect(document.querySelector(".composer-mention")).toBeNull();
  });
});

describe("Composer @板砖 ghost hint", () => {
  it("shows the ghost when the caret is right after a boundary @", () => {
    renderComposer();
    const input = screen.getByPlaceholderText(
      "Message Herta…",
    ) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "整理 @" } });
    const ghost = document.querySelector(".composer-ghost");
    expect(ghost).not.toBeNull();
    expect(ghost?.textContent).toBe("板砖");
  });

  it("shows the ghost for @ at the very start", () => {
    renderComposer();
    const input = screen.getByPlaceholderText(
      "Message Herta…",
    ) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "@" } });
    expect(document.querySelector(".composer-ghost")).not.toBeNull();
  });

  it("does NOT show the ghost for a non-boundary @ (a@)", () => {
    renderComposer();
    const input = screen.getByPlaceholderText(
      "Message Herta…",
    ) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "a@" } });
    expect(document.querySelector(".composer-ghost")).toBeNull();
  });

  it("does NOT show the ghost when @ is not right before the caret", () => {
    renderComposer();
    const input = screen.getByPlaceholderText(
      "Message Herta…",
    ) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "@ hi" } });
    expect(document.querySelector(".composer-ghost")).toBeNull();
  });
});

describe("Composer @板砖 Tab-complete + Esc", () => {
  it("Tab while the hint shows inserts 板砖 and clears the ghost", () => {
    renderComposer();
    const input = screen.getByPlaceholderText(
      "Message Herta…",
    ) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "整理 @" } });
    expect(document.querySelector(".composer-ghost")).not.toBeNull();
    fireEvent.keyDown(input, { key: "Tab" });
    expect(input.value).toBe("整理 @板砖");
    expect(document.querySelector(".composer-ghost")).toBeNull();
    expect(document.querySelector(".composer-mention")?.textContent).toBe(
      "@板砖",
    );
  });

  it("Tab with no hint active does not insert 板砖", () => {
    renderComposer();
    const input = screen.getByPlaceholderText(
      "Message Herta…",
    ) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.keyDown(input, { key: "Tab" });
    expect(input.value).toBe("hello");
  });

  it("Esc dismisses the ghost without inserting", () => {
    renderComposer();
    const input = screen.getByPlaceholderText(
      "Message Herta…",
    ) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "hi @" } });
    expect(document.querySelector(".composer-ghost")).not.toBeNull();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(document.querySelector(".composer-ghost")).toBeNull();
    expect(input.value).toBe("hi @");
  });

  it("the ghost is never part of the sent value", () => {
    const { mock } = renderComposer();
    const input = screen.getByPlaceholderText(
      "Message Herta…",
    ) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "hi @" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    expect(mock.calls.submitText).toContain("hi @");
    expect(mock.calls.submitText).not.toContain("hi @板砖");
  });
});

// Additive coverage carried from the Task 4 code review (onSelect path + a
// whitespace-boundary other than space):
describe("Composer @板砖 hint — extra coverage", () => {
  it("hides the ghost when the caret moves away from the @ (onSelect)", () => {
    renderComposer();
    const input = screen.getByPlaceholderText(
      "Message Herta…",
    ) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "整理 @" } });
    expect(document.querySelector(".composer-ghost")).not.toBeNull();
    input.setSelectionRange(2, 2);
    fireEvent.select(input);
    expect(document.querySelector(".composer-ghost")).toBeNull();
  });

  it("shows the ghost after a newline boundary", () => {
    renderComposer();
    const input = screen.getByPlaceholderText(
      "Message Herta…",
    ) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "x\n@" } });
    expect(document.querySelector(".composer-ghost")).not.toBeNull();
  });
});

describe("Composer — attachments (ADR 0033)", () => {
  /** A drop event carrying files. jsdom's DataTransfer is not constructible
   *  with files, so hand fireEvent the shape the handler actually reads. */
  function fileDrop(files: Array<{ name: string }>): Record<string, unknown> {
    return {
      dataTransfer: { types: ["Files"], files },
    };
  }

  /** Attaching is session-scoped — the main handler matches the id against the
   *  active session — so the composer no-ops without one. Seed a session the
   *  way the app does, or every assertion below passes vacuously. */
  function renderAttached(mock = createMockHertaBridge()) {
    const r = renderComposer(mock);
    act(() => {
      mock.emitReset({
        sessionId: "s-1",
        workspaceRoot: "/r",
        record: [],
        overlay: null,
        title: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
    });
    return r;
  }

  it("opens the picker and forwards the chosen paths", async () => {
    const mock = createMockHertaBridge({
      pickAttachmentsResult: ["/docs/spec.md", "/docs/notes.txt"],
    });
    renderAttached(mock);
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Add documents"));
    });
    expect(mock.calls.pickAttachments).toBe(1);
    expect(mock.calls.attachFiles).toHaveLength(1);
    expect(mock.calls.attachFiles[0]?.[1]).toEqual([
      "/docs/spec.md",
      "/docs/notes.txt",
    ]);
  });

  it("the attach hint is the styled tooltip with the formats subline", () => {
    // The first cut used the native `title`, which renders as the OS's own
    // beige box beside an app full of styled pills (owner 2026-08-10).
    const { container } = renderComposer();
    const wrap = [...container.querySelectorAll(".tooltip-wrap")].find(
      (w) => w.querySelector(".composer-attach") !== null,
    );
    expect(wrap).toBeTruthy();
    expect(wrap?.classList.contains("tooltip-top")).toBe(true);
    expect(wrap?.querySelector(".tooltip")?.textContent).toContain(
      "Add documents",
    );
    // Extensions, not category prose (owner 2026-08-10) — with a trailing
    // "and other text" so the list reads as representative, not exhaustive.
    const sub = wrap?.querySelector(".tooltip-sub")?.textContent ?? "";
    expect(sub).toContain(".md");
    expect(sub).toContain(".csv");
    expect(sub).toContain("other text");
    expect(
      container.querySelector(".composer-attach")?.getAttribute("title"),
    ).toBeNull();
  });

  it("a cancelled picker attaches nothing", async () => {
    const mock = createMockHertaBridge({ pickAttachmentsResult: null });
    renderAttached(mock);
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Add documents"));
    });
    expect(mock.calls.attachFiles).toHaveLength(0);
  });

  it("resolves dropped files through the preload rather than File.path", async () => {
    // Electron 43 removed File.path. If this ever regresses to reading the
    // property directly it yields undefined and the drop silently no-ops.
    const mock = createMockHertaBridge();
    const { container } = renderAttached(mock);
    const form = container.querySelector(".composer") as HTMLElement;
    await act(async () => {
      fireEvent.drop(form, fileDrop([{ name: "a.md" }, { name: "b.csv" }]));
    });
    expect(mock.calls.pathForFile).toBe(2);
    expect(mock.calls.attachFiles[0]?.[1]).toEqual(["a.md", "b.csv"]);
  });

  it("highlights on drag enter and clears on leave", () => {
    const { container } = renderComposer();
    const form = container.querySelector(".composer") as HTMLElement;
    fireEvent.dragEnter(form, { dataTransfer: { types: ["Files"] } });
    expect(form.className).toContain("is-dragover");
    fireEvent.dragLeave(form, { dataTransfer: { types: ["Files"] } });
    expect(form.className).not.toContain("is-dragover");
  });

  it("ignores a drag that carries no files", () => {
    // Dragging selected text across the composer must not arm the drop UI.
    const { container } = renderComposer();
    const form = container.querySelector(".composer") as HTMLElement;
    fireEvent.dragEnter(form, { dataTransfer: { types: ["text/plain"] } });
    expect(form.className).not.toContain("is-dragover");
  });

  it("surfaces a refusal instead of no-opping silently", async () => {
    // The M6 lesson applied to a new surface: a drop that quietly does nothing
    // reads as a broken drop target.
    const mock = createMockHertaBridge({
      attachFilesResult: { ok: false, message: "a turn is in progress" },
    });
    const { container } = renderAttached(mock);
    const form = container.querySelector(".composer") as HTMLElement;
    await act(async () => {
      fireEvent.drop(form, fileDrop([{ name: "a.md" }]));
    });
    expect(
      screen.getByText(/wait for her, then drop the file/i),
    ).toBeInTheDocument();
  });

  it("names the too-many refusal specifically", async () => {
    const mock = createMockHertaBridge({
      attachFilesResult: { ok: false, message: "too many files at once" },
    });
    const { container } = renderAttached(mock);
    const form = container.querySelector(".composer") as HTMLElement;
    await act(async () => {
      fireEvent.drop(form, fileDrop([{ name: "a.md" }]));
    });
    expect(screen.getByText(/Ten files at a time/i)).toBeInTheDocument();
  });

  // ── Staged images (ADR 0048 §4) ─────────────────────────────────────────

  it("a dropped PICTURE stages instead of entering the record", async () => {
    const mock = createMockHertaBridge();
    const { container } = renderAttached(mock);
    const form = container.querySelector(".composer") as HTMLElement;
    await act(async () => {
      fireEvent.drop(form, fileDrop([{ name: "shot.png" }]));
    });
    expect(mock.calls.stageImages).toHaveLength(1);
    // The document lane is NOT used: nothing was appended to the record.
    expect(mock.calls.attachFiles).toHaveLength(0);
    expect(container.querySelectorAll(".composer-staged__item")).toHaveLength(
      1,
    );
  });

  it("a mixed drop splits by kind: pictures stage, documents ingest", async () => {
    const mock = createMockHertaBridge();
    const { container } = renderAttached(mock);
    const form = container.querySelector(".composer") as HTMLElement;
    await act(async () => {
      fireEvent.drop(
        form,
        fileDrop([{ name: "shot.png" }, { name: "spec.md" }]),
      );
    });
    expect(container.querySelectorAll(".composer-staged__item")).toHaveLength(
      1,
    );
    // Documents keep their immediate-ingest UX (extraction takes seconds, and
    // the early row is what says the file is ready to ask about).
    expect(mock.calls.attachFiles).toHaveLength(1);
    expect(mock.calls.attachFiles[0]?.[1]).toEqual(["spec.md"]);
  });

  it("sends the staged ids WITH the message, then empties the strip", async () => {
    const mock = createMockHertaBridge();
    const { container } = renderAttached(mock);
    const form = container.querySelector(".composer") as HTMLElement;
    await act(async () => {
      fireEvent.drop(form, fileDrop([{ name: "shot.png" }]));
    });
    const input = screen.getByPlaceholderText(
      "Message Herta…",
    ) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "看看这个" } });
    await act(async () => {
      fireEvent.submit(form);
    });
    expect(mock.calls.submitText).toEqual(["看看这个"]);
    expect(mock.calls.submitTextStaged[0]).toEqual(["staged-0"]);
    // The strip empties on the same frame the text does.
    expect(container.querySelectorAll(".composer-staged__item")).toHaveLength(
      0,
    );
  });

  it("a picture alone does NOT send — pictures ride words (owner 2026-08-27)", async () => {
    // Reverses the first cut: an empty user block is a degenerate moment in
    // the record (（用户 说） with nothing said, which the narrative actor
    // then completes against). The refusal is SHOWN, not silent, and the
    // strip keeps the picture for the message it still awaits.
    const mock = createMockHertaBridge();
    const { container } = renderAttached(mock);
    const form = container.querySelector(".composer") as HTMLElement;
    await act(async () => {
      fireEvent.drop(form, fileDrop([{ name: "shot.png" }]));
    });
    await act(async () => {
      fireEvent.submit(form);
    });
    expect(mock.calls.submitText).toHaveLength(0);
    expect(
      screen.getByText(/Pictures ride a message — say something first/i),
    ).toBeInTheDocument();
    expect(container.querySelectorAll(".composer-staged__item")).toHaveLength(
      1,
    );
  });

  it("plain empty Enter stays a QUIET no-op — the notice is only for stranded pictures", async () => {
    const mock = createMockHertaBridge();
    const { container } = renderAttached(mock);
    const form = container.querySelector(".composer") as HTMLElement;
    await act(async () => {
      fireEvent.submit(form);
    });
    expect(mock.calls.submitText).toHaveLength(0);
    expect(
      screen.queryByText(/Pictures ride a message/i),
    ).not.toBeInTheDocument();
  });

  it("staged pictures hold the composer expanded (has-staged; never is-shrunk)", async () => {
    // The strip is the only sign the pictures are pending — resting shrunk
    // would clip it, and the fixed 78px box painted it OVER the input
    // (owner screenshots 2026-08-27).
    const mock = createMockHertaBridge();
    const { container } = renderAttached(mock);
    const form = container.querySelector(".composer") as HTMLElement;
    expect(form.className).toContain("is-shrunk"); // rests shrunk
    await act(async () => {
      fireEvent.drop(form, fileDrop([{ name: "shot.png" }]));
    });
    expect(form.className).toContain("has-staged");
    // Even after focus LEAVES the form (which alone would re-shrink it),
    // the pending pictures keep it open.
    fireEvent.blur(form, { relatedTarget: null });
    expect(form.className).not.toContain("is-shrunk");
    // Removing the last picture lets it rest again.
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Remove shot.png"));
    });
    expect(form.className).not.toContain("has-staged");
    expect(form.className).toContain("is-shrunk");
  });

  it("the × removes a staged picture and tells main to delete the copy", async () => {
    const mock = createMockHertaBridge();
    const { container } = renderAttached(mock);
    const form = container.querySelector(".composer") as HTMLElement;
    await act(async () => {
      fireEvent.drop(form, fileDrop([{ name: "shot.png" }]));
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Remove shot.png"));
    });
    expect(container.querySelectorAll(".composer-staged__item")).toHaveLength(
      0,
    );
    expect(mock.calls.unstageImage).toEqual([["s-1", "staged-0"]]);
    // …and it can no longer ride a message.
    await act(async () => {
      fireEvent.submit(form);
    });
    expect(mock.calls.submitText).toHaveLength(0); // nothing to send at all
  });

  it("a pasted screenshot stages by BYTES — the clipboard has no path", async () => {
    const mock = createMockHertaBridge();
    const { container } = renderAttached(mock);
    const form = container.querySelector(".composer") as HTMLElement;
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const file = {
      name: "",
      type: "image/png",
      arrayBuffer: async () => bytes.buffer,
    };
    await act(async () => {
      fireEvent.paste(form, { clipboardData: { files: [file] } });
    });
    expect(mock.calls.stageImages).toHaveLength(1);
    const [, inputs] = mock.calls.stageImages[0] as [
      string,
      readonly { name?: string; bytes?: Uint8Array }[],
    ];
    // A pasted File carries no name; the fallback keeps the record readable.
    expect(inputs[0]?.name).toBe("pasted-image.png");
    expect(inputs[0]?.bytes).toBeInstanceOf(Uint8Array);
  });

  it("an ordinary text paste is left completely alone", async () => {
    const mock = createMockHertaBridge();
    const { container } = renderAttached(mock);
    const form = container.querySelector(".composer") as HTMLElement;
    await act(async () => {
      fireEvent.paste(form, { clipboardData: { files: [] } });
    });
    expect(mock.calls.stageImages).toHaveLength(0);
  });

  it("staged pictures do not survive a session switch", async () => {
    // Transient per-session state (the 2026-07-19 "pill survived session
    // delete" class): the ids belong to the session that made them and would
    // not resolve anywhere else.
    const mock = createMockHertaBridge();
    const { container } = renderAttached(mock);
    const form = container.querySelector(".composer") as HTMLElement;
    await act(async () => {
      fireEvent.drop(form, fileDrop([{ name: "shot.png" }]));
    });
    expect(container.querySelectorAll(".composer-staged__item")).toHaveLength(
      1,
    );
    act(() => {
      mock.emitReset({
        sessionId: "s-2",
        workspaceRoot: "/r",
        record: [],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
    });
    expect(container.querySelectorAll(".composer-staged__item")).toHaveLength(
      0,
    );
  });

  it("surfaces a staging refusal instead of failing silently", async () => {
    const mock = createMockHertaBridge({
      stageImagesResult: { ok: false, message: "a turn is in progress" },
    });
    const { container } = renderAttached(mock);
    const form = container.querySelector(".composer") as HTMLElement;
    await act(async () => {
      fireEvent.drop(form, fileDrop([{ name: "shot.png" }]));
    });
    expect(screen.getByText(/This turn isn't finished/i)).toBeInTheDocument();
    expect(container.querySelectorAll(".composer-staged__item")).toHaveLength(
      0,
    );
  });

  it("a message carries at most five pictures — the refusal names the cap (owner 2026-08-27)", async () => {
    const mock = createMockHertaBridge();
    const { container } = renderAttached(mock);
    const form = container.querySelector(".composer") as HTMLElement;
    await act(async () => {
      fireEvent.drop(
        form,
        fileDrop(Array.from({ length: 6 }, (_, i) => ({ name: `p${i}.png` }))),
      );
    });
    // Whole-batch refusal, like the attachFiles cap: nothing staged, and the
    // notice says the RULE rather than silently staging a prefix.
    expect(
      screen.getByText(/Five pictures per message, at most/i),
    ).toBeInTheDocument();
    expect(container.querySelectorAll(".composer-staged__item")).toHaveLength(
      0,
    );
  });
});
