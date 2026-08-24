import type { RiskLevel } from "@herta/core";
import type { MessageKey } from "../../i18n/keys.js";

/** Maps a permission risk level to its chrome message key (localized at the
 *  display site — these are user-only approval UI, never in Herta's record). */
export const RISK_KEY: Record<RiskLevel, MessageKey> = {
  workspace_read: "approval.risk.read",
  workspace_write: "approval.risk.write",
  workspace_destructive: "approval.risk.destructive",
  network: "approval.risk.network",
};

/** True for the one risk level that warrants danger styling. */
export function isDangerRisk(risk: RiskLevel): boolean {
  return risk === "workspace_destructive";
}

/** Maps a permission ask-class code to a localized summary key (user bug
 *  2026-07-23: the raw English rule reason — "unrecognized command — review
 *  carefully" — showed verbatim in zh sessions). The reason string stays the
 *  neutral machine contract (D2); an UNRECOGNIZED or absent code falls back
 *  to that raw reason so a future ask class degrades readably, never blank. */
export const REASON_KEY: Record<string, MessageKey> = {
  command_ask_unknown: "approval.reason.commandUnknown",
  command_ask_interpreter: "approval.reason.commandInterpreter",
  command_ask_destructive: "approval.reason.commandDestructive",
  command_ask_network: "approval.reason.commandNetwork",
  command_ask_write: "approval.reason.commandWrite",
  command_ask_reader_path: "approval.reason.commandReaderPath",
  command_ask_recursive_read: "approval.reason.commandRecursiveRead",
  // Split off from `unknown` (permission lab 2026-08-17): the harness knows
  // these programs; the card should say what the line does.
  command_ask_vcs: "approval.reason.commandVcs",
  command_ask_fs: "approval.reason.commandFs",
  command_ask_delete: "approval.reason.commandDelete",
  command_ask_process: "approval.reason.commandProcess",
  command_ask_cwd_escape: "approval.reason.commandCwdEscape",
  command_ask_unresolved: "approval.reason.commandUnresolved",
  write_new_file_ask: "approval.reason.writeNewFile",
  edit_file_ask: "approval.reason.editFile",
  // The minimal contract's editor (ADR 0040) — its raw reason ("writes
  // NOTES.md (str_replace, +1/-1 lines)") showed verbatim in zh cards.
  str_replace_editor_ask: "approval.reason.strReplaceEditor",
};
