import { useEffect, useRef } from "react";
import { useDisconnected } from "../../hooks/useDisconnected.js";
import { useReducedMotion } from "../../hooks/useReducedMotion.js";
import {
  shallowEqualObjects,
  useSessionSelector,
} from "../../hooks/useSessionSelector.js";
import { useVoicePlaying } from "../../voice/useVoicePlaying.js";
import { morphFlightActive } from "../Workspace/morph-flight.js";
import {
  AURA_ENERGY_FLOOR,
  clamp,
  displayAuraState,
  getAuraUniformTarget,
  lerp,
  resolveAura,
} from "./aura-engine.js";
import { AURA_SHADER_SOURCE } from "./auraShader.js";
import { useSpeechEnvelope } from "./useSpeechEnvelope.js";
import { initialEnvelope, stepEnvelope } from "./wave-engine.js";
import { createProgram, QUAD_VERTEX_SOURCE } from "./webgl.js";

const AURA_COLOR = "#3c5a62"; // cool graphite glass tint (tunable)
const AURA_COLOR_SHIFT = 0.1; // fixed subtle layered-hue variation
const MAX_FRAME_DT_S = 0.05;
/* Idle frame governor (perf 2026-07-13): at rest the wave draws a 2.8s
   breathing cycle — full display rate (60–165fps) buys nothing visually
   but keeps the GPU out of idle forever. When CALM (listening, energy at
   the floor, no recent state change) frames are spaced ≥30ms (~33fps);
   speech, voice cues, or a state transition restore full rate instantly
   (the gate reads the PREVIOUS drawn frame's calmness, so the first
   energetic frame is at most one throttled interval late). */
const CALM_MIN_FRAME_MS = 30;
const CALM_HOLD_MS = 1500; // full rate for this long after any state change
const CALM_ENERGY = 0.04; // env.fast below this counts as at-rest
/* Resolution cap (perf 2026-07-13): the tide shader is the most expensive
   per-fragment pass in the app (a 30-step march × 4-iteration warp), and
   the canvas spans the composer's full width. HORIZONTAL detail varies
   slowly (the wave's wiggles), so the backing width is capped and the GPU
   upscales; vertical resolution stays at full dpr — the hairline's
   CRISPNESS lives in the y axis. ~3.5× fewer fragments at dpr-2
   fullscreen, no visible change in the band. */
const WAVE_MAX_BACKING_W = 1600;

function hexToRgb(hex: string): [number, number, number] {
  const m = hex.trim().match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return [0.24, 0.35, 0.38];
  return [m[1], m[2], m[3]].map((c) => parseInt(c ?? "0", 16) / 255) as [
    number,
    number,
    number,
  ];
}

/**
 * The voice card's aura: a WebGL fragment-shader visualizer ported from
 * reference_UX_design/speech-visual-UX, rendering the tide-wave geometry from
 * reference_UX_design/glass-wave-study (2026-07-05). State (disconnected/
 * listening/speaking) comes from the active session; energy from Herta's
 * revealed-text rhythm (useSpeechEnvelope). Reduced motion pins the calm
 * listening breath. Falls back to a static CSS aura when WebGL is unavailable.
 * Renderer-local only.
 */
export function AuraVisual(): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Select only what displayAuraState reads (DeviceCard precedent): the
  // full-snapshot subscription re-rendered this component on every
  // streaming delta, which the shader loop never needed — energy arrives
  // through the kicks refs, not through renders.
  const snapshot = useSessionSelector(
    (s) => ({ sessionId: s.sessionId, status: s.status }),
    shallowEqualObjects,
  );
  const reduced = useReducedMotion();
  const kicks = useSpeechEnvelope();
  // A playing voice clip forces the speaking state so audio-only cues (the
  // easter egg) animate the aura even though they stream no text.
  const voicePlaying = useVoicePlaying();
  // While disconnected the utility rail is off-screen (translated past the
  // right edge, opacity 0) yet still mounted — the shader was rendering full-rate WebGL
  // forever over the connect screen. Gate the loop like document.hidden.
  const disconnected = useDisconnected();

  // Latest state for the loop to read (avoids re-running the GL setup effect).
  const live = useRef({
    auraState: displayAuraState(snapshot, voicePlaying),
    reduced,
    hidden: disconnected,
  });
  live.current = {
    auraState: displayAuraState(snapshot, voicePlaying),
    reduced,
    hidden: disconnected,
  };
  // The GL effect exposes its start/stop here so the gating effect below can
  // drive them without re-running the (expensive) GL setup.
  const loopControls = useRef<{
    start: () => void;
    stop: () => void;
  } | null>(null);
  useEffect(() => {
    const c = loopControls.current;
    if (c === null) return;
    if (disconnected) c.stop();
    else c.start();
  }, [disconnected]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const gl = canvas.getContext("webgl", {
      alpha: true,
      antialias: true,
      premultipliedAlpha: false,
    });
    if (gl === null) {
      canvas.dataset.fallback = "true";
      return;
    }
    // GL objects live in rebuildable closure state (audit 2026-07-13 T2.1):
    // a context loss (Windows TDR, driver update, sleep-wake) invalidates
    // every program/buffer/location, so setup must be re-runnable on
    // webglcontextrestored — not once-per-mount.
    const makeLocs = (p: WebGLProgram) => ({
      position: gl.getAttribLocation(p, "aPosition"),
      resolution: gl.getUniformLocation(p, "iResolution"),
      time: gl.getUniformLocation(p, "iTime"),
      speed: gl.getUniformLocation(p, "uSpeed"),
      blur: gl.getUniformLocation(p, "uBlur"),
      scale: gl.getUniformLocation(p, "uScale"),
      shape: gl.getUniformLocation(p, "uShape"),
      frequency: gl.getUniformLocation(p, "uFrequency"),
      amplitude: gl.getUniformLocation(p, "uAmplitude"),
      bloom: gl.getUniformLocation(p, "uBloom"),
      mix: gl.getUniformLocation(p, "uMix"),
      spacing: gl.getUniformLocation(p, "uSpacing"),
      colorShift: gl.getUniformLocation(p, "uColorShift"),
      variance: gl.getUniformLocation(p, "uVariance"),
      smoothing: gl.getUniformLocation(p, "uSmoothing"),
      mode: gl.getUniformLocation(p, "uMode"),
      color: gl.getUniformLocation(p, "uColor"),
      base: gl.getUniformLocation(p, "uBase"),
    });
    let program: WebGLProgram | null = null;
    let buf: WebGLBuffer | null = null;
    let loc: ReturnType<typeof makeLocs> | null = null;
    const buildGl = (): boolean => {
      try {
        program = createProgram(gl, QUAD_VERTEX_SOURCE, AURA_SHADER_SOURCE);
      } catch (e) {
        console.error("Aura shader error:", e);
        canvas.dataset.fallback = "true";
        return false;
      }
      buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
        gl.STATIC_DRAW,
      );
      loc = makeLocs(program);
      // biome-ignore lint/correctness/useHookAtTopLevel: gl.useProgram is a WebGL API method, not a React hook
      gl.useProgram(program);
      gl.enableVertexAttribArray(loc.position);
      gl.vertexAttribPointer(loc.position, 2, gl.FLOAT, false, 0, 0);
      gl.disable(gl.BLEND);
      return true;
    };
    if (!buildGl()) return;

    const env = initialEnvelope();
    // Theme-aware wave (night-mode slice 2 + visibility fix 2026-07-13):
    // the tint AND the glass-sheet base value live in CSS (--aura-color /
    // --aura-base; dark overrides both — light sheets on the dark glass),
    // re-read when the theme controller re-stamps <html data-theme>.
    // Fallbacks mirror the original light constants (jsdom, missing vars).
    let rgb = hexToRgb(AURA_COLOR);
    let base = 0.16;
    const readThemeVars = (): void => {
      const cs = getComputedStyle(canvas);
      rgb = hexToRgb(cs.getPropertyValue("--aura-color").trim() || AURA_COLOR);
      const parsed = Number.parseFloat(cs.getPropertyValue("--aura-base"));
      base = Number.isFinite(parsed) ? parsed : 0.16;
    };
    readThemeVars();
    const mo =
      typeof MutationObserver !== "undefined"
        ? new MutationObserver(readThemeVars)
        : null;
    mo?.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    // Canvas size cached via ResizeObserver: the render loop used to call
    // getBoundingClientRect every frame, which forces synchronous layout in
    // any frame where the DOM is dirty (i.e. every streaming frame).
    let rectW = 0;
    let rectH = 0;
    const measure = (): void => {
      const r = canvas.getBoundingClientRect();
      rectW = r.width;
      rectH = r.height;
    };
    measure();
    const ro =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(measure)
        : null;
    ro?.observe(canvas);
    // Seed the interpolated uniforms from the MOUNT-time state so that if the
    // first animated frame doesn't run until later (e.g. the window/splash was
    // still settling at launch), it lerps FROM the resting state instead of
    // snapping to whatever state is current then. At launch the app opens
    // disconnected, so a later connect animates the aura disconnected→listening
    // rather than jumping straight to listening (user 2026-06-20).
    const seed = resolveAura(
      live.current.auraState,
      live.current.reduced,
      AURA_ENERGY_FLOOR,
    );
    const anim: {
      speed: number;
      scale: number;
      amplitude: number;
      frequency: number;
      brightness: number;
    } = { ...getAuraUniformTarget(seed.state, seed.energy, 0) };
    let shaderTime = 0;
    let phaseTime = 0;
    let last = performance.now();
    let raf: number | null = null;
    let idleTimer: number | null = null;
    // Governor state: `calm` is judged at the END of each drawn frame (the
    // gate below reads the previous frame's verdict); stateChangedTs keeps
    // full rate through transitions so the ~0.5s uniform lerps stay smooth.
    let calm = false;
    let prevResolvedState: string | null = null;
    let stateChangedTs = performance.now();

    const render = (now: number): void => {
      raf = null;
      // Idle frame governor: at rest, space frames to ~33fps. `last` only
      // advances on DRAWN frames, so dt spans the skipped gap naturally
      // (clamped by MAX_FRAME_DT_S). The wait rides a TIMER, not rAF
      // (audit T3.7): re-arming rAF here woke the CPU at the full display
      // rate — up to 165×/s on a fast panel — only to skip; the timer
      // sleeps out the remainder, then rejoins the rAF clock to draw.
      // A morph in flight takes the same spacing as being at rest — for the
      // opposite of the obvious reason (2026-07-30, see morph-flight.ts). A
      // send changes the aura state, so the loop asks for full rate exactly
      // when the main thread is committing a turn, and gets 12–17fps of
      // stutter for it. Riding the timer instead measured 28–32fps steady:
      // requesting less actually delivers more here, because a timer keeps its
      // slot where a rAF request has to win one.
      // Read LIVE, not from the previous frame's `calm` verdict, so the first
      // frame of a flight is already spaced.
      if ((calm || morphFlightActive()) && now - last < CALM_MIN_FRAME_MS) {
        idleTimer = window.setTimeout(
          () => {
            idleTimer = null;
            if (raf === null) raf = requestAnimationFrame(render);
          },
          CALM_MIN_FRAME_MS - (now - last),
        );
        return;
      }
      const l = loc;
      if (l === null) return; // context lost mid-frame — the loop is dead
      const dt = Math.min(MAX_FRAME_DT_S, (now - last) / 1000);
      last = now;

      stepEnvelope(env, dt * 1000, kicks.drainKicks());
      const { auraState, reduced: red } = live.current;
      const resolved = resolveAura(auraState, red, clamp(env.fast, 0, 1));
      if (resolved.state !== prevResolvedState) {
        prevResolvedState = resolved.state;
        stateChangedTs = now;
      }

      shaderTime += dt;
      const target = getAuraUniformTarget(
        resolved.state,
        resolved.energy,
        shaderTime,
      );
      const ease = 1 - Math.exp(-dt / 0.46);
      anim.speed = lerp(anim.speed, target.speed, ease);
      anim.scale = lerp(anim.scale, target.scale, ease);
      const ampEase =
        1 - Math.exp(-dt / (target.amplitude > anim.amplitude ? 0.05 : 0.18));
      anim.amplitude = lerp(anim.amplitude, target.amplitude, ampEase);
      anim.frequency = lerp(anim.frequency, target.frequency, ease);
      anim.brightness = lerp(anim.brightness, target.brightness, ease);
      phaseTime += dt * (0.3 + anim.speed * 0.03);

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      // Backing width capped (see WAVE_MAX_BACKING_W); height keeps full dpr.
      const w = Math.max(
        1,
        Math.floor(Math.min((rectW || 860) * dpr, WAVE_MAX_BACKING_W)), // jsdom reports 0 → the composer reference size (≈860×78)
      );
      const h = Math.max(1, Math.floor((rectH || 78) * dpr)); // jsdom reports 0 → the composer reference size (≈860×78)
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        gl.viewport(0, 0, w, h);
      }

      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform2f(l.resolution, w, h);
      gl.uniform1f(l.time, phaseTime);
      gl.uniform1f(l.speed, anim.speed);
      gl.uniform1f(l.blur, 0.24);
      gl.uniform1f(l.scale, anim.scale);
      // 3.0 = tide wave (glass-wave direction, 2026-07-05); 1.0 circle and
      // 2.0 capsule remain in the shader for quick A/B.
      gl.uniform1f(l.shape, 3.0);
      gl.uniform1f(l.frequency, anim.frequency);
      gl.uniform1f(l.amplitude, anim.amplitude);
      gl.uniform1f(l.bloom, 0.0);
      gl.uniform1f(l.mix, anim.brightness);
      gl.uniform1f(l.spacing, 0.5);
      gl.uniform1f(l.colorShift, AURA_COLOR_SHIFT);
      gl.uniform1f(l.variance, 0.1);
      gl.uniform1f(l.smoothing, 1.0);
      gl.uniform1f(l.mode, 1.0);
      gl.uniform3fv(l.color, rgb);
      gl.uniform1f(l.base, base);
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      // Judge NEXT frame's throttle from this one: at rest (listening, floor
      // energy, transitions settled) the governor spaces frames out.
      calm =
        resolved.state === "listening" &&
        env.fast < CALM_ENERGY &&
        now - stateChangedTs > CALM_HOLD_MS;
      // Diagnostics handle (a plain JS property — never a DOM attribute, so
      // no style/layout impact): lets probes count real draws per second to
      // verify the governor. Harmless in production.
      (canvas as HTMLCanvasElement & { __draws?: number }).__draws =
        ((canvas as HTMLCanvasElement & { __draws?: number }).__draws ?? 0) + 1;

      raf = requestAnimationFrame(render);
    };
    let contextLost = false;
    const start = (): void => {
      // All gates: a lost GL context, a hidden document, and an off-screen
      // rail each keep the loop off. `idleTimer` counts as running — the
      // calm governor is mid-sleep, not stopped.
      if (
        raf === null &&
        idleTimer === null &&
        !contextLost &&
        !document.hidden &&
        !live.current.hidden
      ) {
        last = performance.now();
        raf = requestAnimationFrame(render);
      }
    };
    const stop = (): void => {
      if (raf !== null) {
        cancelAnimationFrame(raf);
        raf = null;
      }
      if (idleTimer !== null) {
        window.clearTimeout(idleTimer);
        idleTimer = null;
      }
    };
    const onVisibility = (): void => {
      if (document.hidden) stop();
      else start();
    };
    // Context loss/restore (audit 2026-07-13 T2.1): without these, a GPU
    // reset left every GL call a no-op with the rAF loop running dead — an
    // invisible wave until app restart. preventDefault signals the browser
    // we handle restoration (webglcontextrestored never fires otherwise);
    // the CSS fallback shows while the context is gone.
    const onContextLost = (e: Event): void => {
      e.preventDefault();
      contextLost = true;
      stop();
      canvas.dataset.fallback = "true";
    };
    const onContextRestored = (): void => {
      contextLost = false;
      if (!buildGl()) return; // rebuild failed — the fallback stays
      delete canvas.dataset.fallback;
      start();
    };
    canvas.addEventListener("webglcontextlost", onContextLost);
    canvas.addEventListener("webglcontextrestored", onContextRestored);
    document.addEventListener("visibilitychange", onVisibility);
    loopControls.current = { start, stop };
    start();
    return () => {
      stop();
      loopControls.current = null;
      document.removeEventListener("visibilitychange", onVisibility);
      canvas.removeEventListener("webglcontextlost", onContextLost);
      canvas.removeEventListener("webglcontextrestored", onContextRestored);
      ro?.disconnect();
      mo?.disconnect();
      gl.deleteBuffer(buf);
      gl.deleteProgram(program);
    };
  }, [kicks]);

  return (
    <div className="aura-frame">
      <canvas
        ref={canvasRef}
        className="aura-canvas"
        aria-hidden="true"
        tabIndex={-1}
      />
      <div className="aura-fallback" />
    </div>
  );
}
