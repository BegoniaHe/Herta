import { useRef } from "react";
import agentDevice from "../../assets/agent_device.png";
import agentDeviceNight from "../../assets/agent_device_night.png";
import agentShadow from "../../assets/agent_shadow.png";
import { useHertaBridge } from "../../context/HertaBridgeContext.js";
import {
  type BanzhuanDeviceState,
  useDeviceState,
} from "../../hooks/useDeviceState.js";
import { useDisconnected } from "../../hooks/useDisconnected.js";
import { useSessionScoped } from "../../hooks/useSessionScoped.js";
import {
  shallowEqualObjects,
  useSessionSelector,
} from "../../hooks/useSessionSelector.js";
import type { MessageKey } from "../../i18n/keys.js";
import { useT } from "../../i18n/LocaleProvider.js";
import { useRailParked } from "../FileViewer/file-viewer-context.js";
import { CardMenu } from "./CardMenu.js";
import { DeviceGlow } from "./DeviceGlow.js";
import { useDragToLift } from "./useDragToLift.js";

const STATE_KEY: Record<BanzhuanDeviceState, MessageKey> = {
  idle: "device.state.idle",
  delegated: "device.state.working",
  // Slice 5: the fine working states get their own labels; visually they
  // share the delegated blue halo (reference-ux.css groups the selectors) —
  // the split is in the label, not a new palette.
  reading: "device.state.reading",
  writing: "device.state.writing",
  runningCommand: "device.state.runningCommand",
  waitingApproval: "device.state.awaitingApproval",
  verifying: "device.state.verifying",
  succeeded: "device.state.done",
  failed: "device.state.error",
};

export function DeviceCard(): JSX.Element {
  const t = useT();
  const state = useDeviceState();
  // Select only the three snapshot fields this card reads, shallow-compared, so
  // streaming deltas (which don't touch these) don't re-render the device card.
  const snap = useSessionSelector(
    (s) => ({
      sessionId: s.sessionId,
      backendWorkspace: s.backendWorkspace,
      backendWorkspaceIsDefault: s.backendWorkspaceIsDefault,
    }),
    shallowEqualObjects,
  );
  const { bridge } = useHertaBridge();
  // While disconnected the rail is off-screen but mounted — same gate the
  // aura uses to keep its shader loop from rendering over the connect screen.
  // The docked file viewer parks the rail the same way (ADR 0050 §4), so
  // the glow loop stops for as long as the panel stays open.
  const disconnected = useDisconnected();
  const railParked = useRailParked();
  // Easter egg: a successful upward lift may play a voice clip. The active
  // session owns the 50% roll + per-session hourly throttle (fire-and-forget).
  const { onMouseDown, transform, shadowStyle } = useDragToLift({
    onSuccessfulLift: () => void bridge.maybePlayEasterEgg(),
  });
  // A workspace error belongs to the session it happened in — don't resurface
  // a stale one in the next session's menu. (This hand-written reset is what
  // `useSessionScoped` generalizes; migrated 2026-07-24.)
  const [wsError, setWsError] = useSessionScoped<string | null>(null);
  // In-flight guard: rapid re-clicks queued a second OS folder dialog.
  const picking = useRef(false);
  const handleSet = async () => {
    if (snap.sessionId === null) return; // no session → nothing to set; don't open the dialog
    if (picking.current) return;
    picking.current = true;
    try {
      const picked = await bridge.pickWorkspace();
      if (picked !== null) {
        const res = await bridge.setWorkspace(snap.sessionId, picked);
        if (!res.ok) setWsError(res.message ?? t("card.workspaceSetError"));
        else setWsError(null);
      }
    } finally {
      picking.current = false;
    }
  };
  // Project command allow rules (ADR 0030). The DATA lives here — CardMenu is
  // presentational (its own tests render it with no bridge provider) — and is
  // refreshed on every menu OPEN so a rule granted mid-commission appears
  // without a remount. `null` means "this bridge has no rule surface" (fakes /
  // the website demo): the menu then omits the section entirely.
  const rulesSupported = bridge.listCommandRules !== undefined;
  const [rules, setRules] = useSessionScoped<readonly string[]>([]);
  const refreshRules = (): void => {
    if (!rulesSupported) return;
    void bridge.listCommandRules?.().then(
      (r) => setRules(r),
      () => {
        /* keep the last list — best-effort chrome */
      },
    );
  };
  const handleRemoveRule = (display: string): void => {
    void bridge.removeCommandRule?.(display).then(
      (ok) => {
        if (ok) setRules((prev) => prev.filter((r) => r !== display));
      },
      () => {
        /* row stays — nothing was deleted */
      },
    );
  };
  const handleReset = async () => {
    if (snap.sessionId === null) return;
    // Surface the refusal like its sibling above (audit 2026-07-24, M6):
    // main returns { ok:false, message:"a turn is in progress" } for exactly
    // this case, and discarding it meant 恢复默认 silently no-opped mid-turn —
    // the menu closed, nothing changed, and the user believed they had
    // reverted while 板砖 kept writing to the custom folder.
    const res = await bridge.resetWorkspace(snap.sessionId);
    if (!res.ok) setWsError(res.message ?? t("card.workspaceSetError"));
    else setWsError(null);
  };
  return (
    <section
      className="device-card"
      data-state={state}
      aria-label={t("device.ariaLabel", { state: t(STATE_KEY[state]) })}
    >
      <CardMenu
        cardKind="device"
        activeWorkspace={snap.backendWorkspace ?? undefined}
        isDefault={snap.backendWorkspaceIsDefault}
        onSetWorkspace={() => void handleSet()}
        onResetWorkspace={handleReset}
        errorText={wsError ?? undefined}
        rules={rulesSupported ? rules : undefined}
        onRemoveRule={handleRemoveRule}
        onOpen={refreshRules}
      />
      <button
        type="button"
        className="agent-preview"
        onMouseDown={onMouseDown}
        tabIndex={-1}
        aria-label={t("device.dragHint")}
      >
        {/* Shadow stays grounded — it does NOT lift. It only shrinks +
            fades (shadowStyle) as the device rises, anchored to the
            ground via transform-origin in CSS. */}
        <img
          className="agent-layer agent-shadow"
          src={agentShadow}
          alt=""
          style={shadowStyle}
        />
        {/* Lift group: the device body + its spill + ring rise together
            as one unit so the glow stays attached to the device. The
            spill/ring keep their own translate(-50%,…) centering and
            breathing animations; this parent transform composes on top. */}
        <div
          className="agent-lift-group"
          style={transform !== null ? { transform } : undefined}
        >
          {/* Day + night renders stacked; CSS shows one per data-theme (both
              stay loaded so a theme flip swaps without a decode flash). The
              night render's ring is UNLIT — the DeviceGlow shader is its
              only light source. */}
          <img
            className="agent-layer agent-device-img agent-device-img--day"
            src={agentDevice}
            alt={t("device.aria")}
          />
          <img
            className="agent-layer agent-device-img agent-device-img--night"
            src={agentDeviceNight}
            alt=""
            aria-hidden="true"
          />
          <DeviceGlow state={state} paused={disconnected || railParked} />
        </div>
      </button>
    </section>
  );
}
