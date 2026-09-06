/**
 * Which GPU path the 3D device card can take on this machine (ADR 0057 §4).
 *
 *   "webgpu"  — navigator.gpu hands out an adapter AND a device.
 *   "webgl2"  — no WebGPU, but a hardware WebGL2 context. three's
 *               WebGPURenderer runs its WebGL2 backend (`forceWebGL`).
 *   null      — neither, or only a software rasterizer: the card keeps its
 *               flat renders. SwiftShader would draw the scene at a crawl
 *               and burn a CPU core for a decoration.
 *
 * Probed ONCE per renderer lifetime (memoised): adapters do not appear
 * mid-session, and the probe itself is not free (it asks the GPU process).
 */
export type DeviceSceneBackend = "webgpu" | "webgl2";

const SOFTWARE_RENDERER =
  /swiftshader|llvmpipe|software|microsoft basic render/i;

interface GpuLike {
  requestAdapter(): Promise<{
    requestDevice(): Promise<{ destroy(): void }>;
  } | null>;
}

interface ProbeEnv {
  readonly gpu?: GpuLike | undefined;
  readonly createCanvas: () => HTMLCanvasElement;
}

/** The uncached probe — injectable for tests. */
export async function probeDeviceSceneBackend(
  env: ProbeEnv,
): Promise<DeviceSceneBackend | null> {
  if (env.gpu !== undefined) {
    try {
      const adapter = await env.gpu.requestAdapter();
      if (adapter !== null) {
        const device = await adapter.requestDevice();
        device.destroy();
        return "webgpu";
      }
    } catch {
      // fall through to WebGL2
    }
  }
  try {
    const canvas = env.createCanvas();
    const gl = canvas.getContext("webgl2");
    if (gl === null) return null;
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = String(
      ext !== null
        ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)
        : gl.getParameter(gl.RENDERER),
    );
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return SOFTWARE_RENDERER.test(renderer) ? null : "webgl2";
  } catch {
    return null;
  }
}

let cached: Promise<DeviceSceneBackend | null> | null = null;

/** The memoised probe against the real window. */
export function detectDeviceSceneBackend(): Promise<DeviceSceneBackend | null> {
  if (cached === null) {
    cached = probeDeviceSceneBackend({
      gpu: (navigator as Navigator & { gpu?: GpuLike }).gpu,
      createCanvas: () => document.createElement("canvas"),
    });
  }
  return cached;
}

/** Test hook. */
export function resetDeviceSceneBackendForTest(): void {
  cached = null;
}
