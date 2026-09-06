import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { smaa } from "three/addons/tsl/display/SMAANode.js";
import {
  cross,
  dFdx,
  dFdy,
  dot,
  emissive,
  faceDirection,
  materialRoughness,
  max,
  mix,
  mrt,
  mx_noise_float,
  normalMap,
  normalView,
  output,
  pass,
  positionView,
  positionWorld,
  smoothstep,
  texture,
  uniform,
  uv,
  vec3,
} from "three/tsl";
import * as THREE from "three/webgpu";
import type { BanzhuanDeviceState } from "../../../hooks/useDeviceState.js";
import type { ResolvedTheme } from "../../../hooks/useResolvedTheme.js";
import { advanceLift, createLiftPose } from "./lift.js";
import {
  cardHourFor,
  hourDelta,
  lightingAt,
  STATE_TARGETS,
  timeWeights,
} from "./lighting.js";

/**
 * The 3D device card's scene (ADR 0057 §2, amended §2.1b: the pale room):
 * the owner's Cycles-baked HRT-001 study (reference_UX_design/
 * banzhuan-3d-demo, main-webgpu.js + baked-material.js + device-surface.js)
 * reduced to what the app card needs, in the study's "Previous · pale
 * room" configuration with the room's surfaces taken to the card's white.
 *
 * Kept from the study: the compact mesh and its atlases, the baked ring
 * illumination and daylight bounce, the alcove (its pale-room light
 * exchange bakes), the live key / fill / rim / sky / softbox lights with
 * VSM shadows on the device and the room, the night outline spotlight and
 * exposure adaptation, the satin-mineral surface refinement, MSAA (2×, the
 * study's 4× halved for an iGPU, §2.9) + emissive bloom + SMAA, on-demand
 * rendering with an idle governor. The study's LTC softbox is a
 * directional light here (§2.9).
 *
 * Dropped: the mineral-room material noise and shaped light, weather, the
 * time slider and day playback, the compare wipe, the quality and
 * asset-profile selectors, the source-texture fallbacks (a machine that
 * cannot transcode KTX2 keeps the flat card). Time of day follows the
 * CLOCK in the light theme, folded so the card never leaves daylight, and
 * is the study's midnight in the dark theme (lighting.ts `cardHourFor`).
 *
 * Loaded lazily by DeviceScene.tsx — three.js stays out of the boot bundle.
 */

/** Design units → metres (the GLB is physical; the study's camera and light
 *  positions are in the old Blender display units). */
const UNIT = 0.05;
/** The flat card's device image is 216 × 270 CSS px with a 934/1403 visible
 *  silhouette: the 3D device is framed to the same 179.74 px height. */
const DEVICE_HEIGHT_PX = (270 * 934) / 1403;
/** The study's card-mode buffer policy: ≥1.5× at DPR 1, honour up to 2×,
 *  cap the long edge at 768 px. */
const MAX_LONG_EDGE_PX = 768;
/** Idle governor (after DeviceGlow / AuraVisual, which breathe at 30): the
 *  breath renders at 20 fps — every third vsync; its fastest cycle is
 *  1.35 s, so a frame moves the lamp under 1/255 of its range — motion at
 *  60, and the loop parks after 5 s unfocused. Every calm frame is a full
 *  scene render on the GPU, so the calm rate is the power lever (ADR 0057
 *  §2.9: 30 → 20 took a third off the idle GPU share). */
const CALM_FPS = 20;
const MOVING_FPS = 60;
/** Both shadow maps: the key's 10-unit frustum at 512² is a 0.02-unit
 *  texel, about one canvas pixel, under the VSM blur; 1024² cost four times
 *  the depth and blur passes for no visible gain (ADR 0057 §2.9). */
const SHADOW_MAP_SIZE = 512;
const PARK_UNFOCUSED_MS = 5000;
/** How often a resting loop is nudged to follow the clock. A breathing
 *  card re-reads the clock every frame anyway; this is for reduced motion,
 *  where the loop stops between events. */
const CLOCK_WAKE_MS = 60_000;

/** The room's surfaces (linear RGB, roughness), a white room: the card's
 *  frost is about 0.9 linear, the walls sit just under it so the key's
 *  shadow and the ring's spill still read on them; the left wall a step
 *  darker for separation, as in the study's pale box. */
const ROOM_SURFACES = {
  ground: { color: [0.84, 0.855, 0.86] as const, roughness: 0.88 },
  back: { color: [0.88, 0.895, 0.9] as const, roughness: 0.9 },
  left: { color: [0.8, 0.82, 0.83] as const, roughness: 0.92 },
};

export interface DeviceSceneInputs {
  readonly state: BanzhuanDeviceState;
  readonly theme: ResolvedTheme;
  readonly reducedMotion: boolean;
  readonly paused: boolean;
  /** The drag hook's lift target in CSS px (0 when released). */
  readonly liftPx: number;
}

export interface DeviceSceneOptions {
  readonly canvas: HTMLCanvasElement;
  readonly forceWebGL: boolean;
  readonly assetUrl: (file: string) => string;
  readonly initial: DeviceSceneInputs;
  /** Enable GPU timestamp queries and report `gpuMs` in the canvas dataset
   *  beside the always-on fps / submitMs / draws. Costs a little per frame;
   *  off unless a developer asks (localStorage `herta.deviceScene.profile`). */
  readonly profile?: boolean;
  /** The scene can no longer draw (device lost, context lost). The caller
   *  returns the card to its flat renders; the handle is already disposed. */
  readonly onFallback: (reason: string) => void;
}

export interface DeviceSceneStats {
  readonly backend: "webgpu" | "webgl2";
  /** Renderer init → assets loaded, ms. */
  readonly loadMs: number;
  /** Assets loaded → first frame presented, ms (pipeline compilation). */
  readonly firstFrameMs: number;
}

export interface DeviceSceneHandle {
  readonly stats: DeviceSceneStats;
  update(inputs: DeviceSceneInputs): void;
  dispose(): void;
}

// ── Baked material ──────────────────────────────────────────────────────────

/** The TSL node shapes this file passes around. three's typings tag nodes by
 *  GLSL type; a few proxies (normalMap, texture swizzles) come back untagged
 *  at the type level and are cast at the boundary — the runtime objects all
 *  carry the same method set. */
type Vec3Node = THREE.Node<"vec3">;
type FloatNode = THREE.Node<"float">;

/**
 * Three's lightMap hook expects irradiance. Cycles' colour-excluded diffuse
 * bake is unit-albedo reflected radiance, so E = π·L (Lambertian); the live
 * PBR BRDF then applies the receiver's albedo exactly once.
 */
class BakedStandardMaterial extends THREE.MeshStandardNodeMaterial {
  bakedIrradiance: Vec3Node | null = null;

  override setupLightMap(builder: THREE.NodeBuilder): THREE.Node {
    if (this.bakedIrradiance !== null) {
      return new THREE.IrradianceNode(this.bakedIrradiance);
    }
    return super.setupLightMap(builder);
  }
}

/** Scalar PBR maps need one byte per texel: keep the source channel exactly
 *  in an R8 texture rather than uploading RGBA. */
function scalarTexture(
  source: THREE.Texture,
  channel: number,
): THREE.DataTexture {
  const image = source.image as HTMLImageElement | ImageBitmap;
  const { width, height } = image;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (context === null) throw new Error("2d context unavailable");
  context.drawImage(image, 0, 0);
  const rgba = context.getImageData(0, 0, width, height).data;
  const red = new Uint8Array(width * height);
  for (let i = 0; i < red.length; i += 1) red[i] = rgba[i * 4 + channel] ?? 0;
  const result = new THREE.DataTexture(
    red,
    width,
    height,
    THREE.RedFormat,
    THREE.UnsignedByteType,
  );
  source.dispose();
  return result;
}

/** The per-frame knobs the baked shaders read. */
function makeUniforms() {
  return {
    ringColor: uniform(new THREE.Color()),
    ringStrength: uniform(0),
    weights: uniform(new THREE.Vector4(0, 1, 0, 0)),
    bounceStrength: uniform(0),
    roomStrength: uniform(0),
    lift: uniform(0),
    /** Contact-shadow strength (0 = none) and its centre, world metres. */
    contact: uniform(0),
    contactBase: uniform(new THREE.Vector3(0, 0, 0)),
  };
}
type BakeUniforms = ReturnType<typeof makeUniforms>;

/** Σ preset_i · weight_i over the three baked daylight presets. */
function daylightBounce(
  nodes: readonly Vec3Node[],
  weights: BakeUniforms["weights"],
): Vec3Node {
  let sum: Vec3Node = vec3(0);
  const lanes = ["x", "y", "z"] as const;
  nodes.forEach((node, i) => {
    const lane = lanes[i];
    if (lane === undefined) return;
    sum = sum.add(node.mul(weights[lane]));
  });
  return sum;
}

type DeviceTextures = Record<
  | "basecolor"
  | "normal"
  | "roughness"
  | "cavity"
  | "ring-diffuse"
  | "ring-channel"
  | "lamp-device"
  | "lamp-space"
  | "device-morning"
  | "device-midday"
  | "device-evening"
  | "space-morning"
  | "space-midday"
  | "space-evening",
  THREE.Texture
>;

const DEVICE_LDR = ["basecolor", "normal"] as const;
const DEVICE_SCALAR = ["roughness", "cavity"] as const;
const DEVICE_HDR = ["ring-diffuse", "ring-channel"] as const;
const SPACE_HDR = [
  "lamp-device",
  "lamp-space",
  "device-morning",
  "device-midday",
  "device-evening",
  "space-morning",
  "space-midday",
  "space-evening",
] as const;

function configureAtlas(tex: THREE.Texture, colorSpace: string): void {
  // EXR-derived atlases were baked bottom-up; the PNG-derived ones and the
  // glTF UVs use the opposite V convention. The shaders flip V for the HDR
  // reads (uv(1).flipY()); every atlas stays unflipped on upload.
  tex.flipY = false;
  tex.channel = 1;
  tex.colorSpace = colorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  const compressed =
    (tex as { isCompressedTexture?: boolean }).isCompressedTexture === true;
  tex.generateMipmaps =
    !compressed && !(tex.mipmaps !== undefined && tex.mipmaps.length > 0);
  tex.anisotropy = 4;
  tex.needsUpdate = true;
}

/** The satin-mineral refinement (device-surface.js, always on): patches and
 *  mesoscopic grain in physical units, anchored to the device through its
 *  lift, composed onto the baked normal with the surface-gradient bump. */
function refineDeviceSurface(
  mat: BakedStandardMaterial,
  baseRoughness: FloatNode,
  normalTexture: THREE.Texture,
  colorTexture: THREE.Texture,
  lift: BakeUniforms["lift"],
): void {
  const p = positionWorld.sub(vec3(0, lift, 0));
  const dx = dFdx(p);
  const dy = dFdy(p);
  const footprint2 = max(dot(dx, dx), dot(dy, dy));
  const broad = mx_noise_float(p.mul(68).add(vec3(1.4, 2.1, 4.7)));
  const meso = mx_noise_float(p.mul(210).add(vec3(3.2, 7.8, 1.6))).div(
    footprint2.mul(210 ** 2 * 4).add(1),
  );
  const polish = smoothstep(-0.38, 0.34, broad);
  const grain = smoothstep(-0.28, 0.34, meso);

  const albedo = texture(colorTexture, uv(1)).rgb;
  const tint = vec3(0.925, 0.932, 0.936)
    .add(polish.mul(0.05))
    .mul(meso.mul(0.06).add(1));
  mat.colorNode = albedo.mul(tint);
  mat.metalness = 0; // mineral ceramic is a dielectric

  const mapped = normalMap(
    texture(normalTexture, uv(1)),
  ) as unknown as Vec3Node;
  const height = meso.mul(0.00013).mul(polish.mul(-0.55).add(1));
  const dpdx = dFdx(positionView);
  const dpdy = dFdy(positionView);
  const r1 = cross(dpdy, mapped);
  const r2 = cross(mapped, dpdx);
  const det = dot(dpdx, r1).mul(faceDirection);
  const grad = r1
    .mul(dFdx(height))
    .add(r2.mul(dFdy(height)))
    .mul(det.sign());
  const perturbed = mapped.mul(det.abs().max(1e-12)).sub(grad).normalize();
  mat.normalNode = perturbed;

  const satin = mix(baseRoughness, 0.39, polish.mul(0.84));
  const refined = satin.add(grain.mul(-0.075).add(0.075)).clamp(0.38, 0.82);
  const ndx = dFdx(perturbed);
  const ndy = dFdy(perturbed);
  const variance = max(dot(ndx, ndx), dot(ndy, ndy));
  mat.roughnessNode = refined
    .mul(refined)
    .add(variance.mul(0.18).min(0.028))
    .min(1)
    .sqrt();
}

function copyMaterialBasics(
  from: THREE.MeshStandardMaterial,
  to: BakedStandardMaterial,
): void {
  to.name = from.name;
  to.color.copy(from.color);
  to.map = from.map;
  to.metalness = from.metalness;
  to.metalnessMap = from.metalnessMap;
  to.roughness = from.roughness;
  to.roughnessMap = from.roughnessMap;
  to.normalMap = from.normalMap;
  to.normalScale.copy(from.normalScale);
  to.aoMap = from.aoMap;
  to.aoMapIntensity = from.aoMapIntensity;
  to.emissive.copy(from.emissive);
  to.emissiveIntensity = from.emissiveIntensity;
  to.emissiveMap = from.emissiveMap;
  to.opacity = from.opacity;
  to.transparent = from.transparent;
  to.side = from.side;
  to.depthWrite = from.depthWrite;
  to.envMapIntensity = from.envMapIntensity;
}

function makeDeviceMaterial(
  source: THREE.MeshStandardMaterial,
  lampChannel: boolean,
  tex: DeviceTextures,
  u: BakeUniforms,
  dayNodes: readonly Vec3Node[],
): BakedStandardMaterial {
  const mat = new BakedStandardMaterial();
  copyMaterialBasics(source, mat);
  const isRing = source.name.startsWith("Indicator");
  if (isRing) return mat;
  const ceramic = source.name.startsWith("Ceramic");
  if (ceramic) {
    mat.map = tex.basecolor;
    mat.color.setRGB(1, 1, 1);
    mat.roughnessMap = null;
    mat.roughness = 1;
    mat.normalMap = tex.normal;
    mat.normalScale.set(1, 1);
    mat.metalness = 0.025;
  }
  // Cavity is deliberately weak; the baked GI already carries self-occlusion.
  mat.aoMap = tex.cavity;
  mat.aoMapIntensity = 0.28;
  const st = uv(1).flipY();
  // Daylight bounce: the three baked presets mixed by the hour weights.
  const bounce = daylightBounce(dayNodes, u.weights);
  const localRing = texture(
    tex[lampChannel ? "ring-channel" : "ring-diffuse"],
    lampChannel ? uv(2).flipY() : st,
  ).rgb;
  // The annulus keeps its seamless channel bake; larger surfaces interpolate
  // toward the room-inclusive lamp transport rather than adding it twice.
  const lamp = lampChannel
    ? localRing
    : mix(localRing, texture(tex["lamp-device"], st).rgb, u.roomStrength);
  const ring = lamp.mul(u.ringColor).mul(u.ringStrength);
  mat.bakedIrradiance = bounce.mul(u.bounceStrength).add(ring).mul(Math.PI);
  // Derivative-based roughness filtering softens unresolved normal highlights.
  const dx = dFdx(normalView);
  const dy = dFdy(normalView);
  const variance = max(dot(dx, dx), dot(dy, dy));
  const roughness: FloatNode = ceramic
    ? (texture(tex.roughness, uv(1)).r as unknown as FloatNode)
    : (materialRoughness as unknown as FloatNode);
  const filtered = roughness
    .mul(roughness)
    .add(variance.mul(0.14).min(0.035))
    .min(1)
    .sqrt();
  mat.roughnessNode = filtered;
  if (ceramic) {
    refineDeviceSurface(mat, filtered, tex.normal, tex.basecolor, u.lift);
  }
  return mat;
}

function makeSpaceMaterial(
  source: THREE.MeshStandardMaterial,
  objectName: string,
  tex: DeviceTextures,
  u: BakeUniforms,
): BakedStandardMaterial {
  const mat = new BakedStandardMaterial();
  mat.name = source.name;
  const surface =
    ROOM_SURFACES[
      objectName.includes("ground")
        ? "ground"
        : objectName.includes("back")
          ? "back"
          : "left"
    ];
  const [cr, cg, cb] = surface.color;
  mat.color.setRGB(cr, cg, cb);
  mat.roughness = surface.roughness;
  mat.metalness = 0;
  // The contact shadow, in the room's own albedo: an ellipsoid of
  // occlusion around the device's base darkens the floor under it and the
  // wall behind it, and fades as the device lifts. In the material rather
  // than as an overlay — the transparent overlays tried first came
  // through this MSAA + MRT pass either near-invisible (canvas alpha) or
  // as a light rectangle (multiply blending), bisected live 2026-09-06.
  const q = positionWorld
    .sub(u.contactBase)
    .div(vec3(CONTACT_REACH.x, CONTACT_REACH.y, CONTACT_REACH.z));
  const occlusion = u.contact.mul(smoothstep(0, 1, dot(q, q)).oneMinus());
  mat.colorNode = vec3(cr, cg, cb).mul(occlusion.oneMinus());
  const st = uv(1).flipY();
  // The ring's light on the room, and the room's own daylight bounce —
  // both colour-excluded bakes, so the white surfaces above receive them
  // like any albedo would.
  const ring = texture(tex["lamp-space"], st)
    .rgb.mul(u.ringColor)
    .mul(u.ringStrength)
    .mul(u.roomStrength);
  const bounce = daylightBounce(
    (["space-morning", "space-midday", "space-evening"] as const).map(
      (name) => texture(tex[name], st).rgb as unknown as Vec3Node,
    ),
    u.weights,
  );
  mat.bakedIrradiance = bounce.mul(u.bounceStrength).add(ring).mul(Math.PI);
  return mat;
}

// ── Scene ───────────────────────────────────────────────────────────────────

function renderPixelRatio(width: number, height: number, dpr: number): number {
  const desired = Math.max(1.5, dpr);
  return Math.max(
    1,
    Math.min(2, desired, MAX_LONG_EDGE_PX / Math.max(width, height, 1)),
  );
}

/** The contact shadow's strength at rest: how dark the floor and the wall
 *  get right at the device's base (the flat card's shadow layer peaks at
 *  0.72 × 0.85). Fades as the device lifts. */
const CONTACT_STRENGTH = 0.45;
/** Its reach from the base, metres: a little past the footprint sideways,
 *  a few centimetres up the wall behind, and a long way FORWARD along the
 *  floor — this camera looks along the floor at 2°, so a centimetre of
 *  floor in front of the device is a third of a pixel; 40 cm of reach
 *  reads as a soft band about a dozen pixels tall under the base
 *  (measured: a 1 m reach at full strength darkened the floor down to
 *  ~30 px below the base line, 2026-09-06). */
const CONTACT_REACH = new THREE.Vector3(0.11, 0.05, 0.4);
/** How far (design units) the key or the device moves before the shadow
 *  maps are re-rendered: about one texel of the key's 10-unit frustum at
 *  512², under a canvas pixel — the VSM edge is 6 texels soft. */
const SHADOW_MOVE_UNITS = 0.02;

/** The last resolved frame's render passes in submission order, ms each
 *  (profiling only). three keys each pass's query by `r:<call>:<ctx>:f<n>`. */
function gpuPassBreakdown(renderer: THREE.WebGPURenderer): number[] {
  const pool = (
    renderer.backend as {
      timestampQueryPool?: {
        render?: { timestamps: Map<string, number>; frames: number[] };
      };
    }
  ).timestampQueryPool?.render;
  if (pool === undefined) return [];
  const last = pool.frames[pool.frames.length - 1];
  if (last === undefined) return [];
  const passes: Array<[number, number]> = [];
  for (const [uid, ms] of pool.timestamps) {
    const m = /^r:(\d+):\d+:f(\d+)$/.exec(uid);
    if (m !== null && Number(m[2]) === last) {
      passes.push([Number(m[1]), Math.round(ms * 100) / 100]);
    }
  }
  return passes.sort((a, b) => a[0] - b[0]).map((p) => p[1]);
}

function disposeMaterial(mat: THREE.Material): void {
  for (const value of Object.values(mat)) {
    if ((value as { isTexture?: boolean } | null)?.isTexture === true) {
      (value as THREE.Texture).dispose();
    }
  }
  mat.dispose();
}

export async function createDeviceScene(
  opts: DeviceSceneOptions,
): Promise<DeviceSceneHandle> {
  const { canvas, assetUrl } = opts;
  const t0 = performance.now();

  const profile = opts.profile === true;
  const renderer = new THREE.WebGPURenderer({
    canvas,
    antialias: true,
    alpha: false,
    // A decoration must never wake a laptop's discrete GPU.
    powerPreference: "low-power",
    forceWebGL: opts.forceWebGL,
    trackTimestamp: profile,
  });
  await renderer.init();
  const backend: DeviceSceneStats["backend"] =
    (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend === true
      ? "webgpu"
      : "webgl2";
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.VSMShadowMap;

  const scene = new THREE.Scene();
  scene.scale.setScalar(UNIT);
  const background = new THREE.Color("#ffffff");
  scene.background = background;
  // Real-card framing has a 35 cm vertical span; the camera sits back along
  // its ray so the near plane clears the floor. Orthographic distance changes
  // neither the device scale nor its perspective.
  const camera = new THREE.OrthographicCamera(
    -4 * UNIT,
    4 * UNIT,
    3 * UNIT,
    -3 * UNIT,
    0.1 * UNIT,
    480 * UNIT,
  );
  camera.position.set(58.5, 6.3, 110).multiplyScalar(UNIT);
  camera.lookAt(0, 1.9 * UNIT, 0);
  const assembly = new THREE.Group();
  scene.add(assembly);

  // A clean photographic light tent, prefiltered for roughness-dependent
  // reflections; its panels exist only for this capture.
  const pmrem = new THREE.PMREMGenerator(renderer);
  const studio = new THREE.Scene();
  studio.background = new THREE.Color(0.32, 0.32, 0.32);
  const panel = (
    position: [number, number, number],
    w: number,
    h: number,
    power: number,
  ): void => {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicNodeMaterial({
        color: new THREE.Color(power, power, power),
        side: THREE.DoubleSide,
      }),
    );
    mesh.position.fromArray(position);
    mesh.lookAt(0, 1.9, 0);
    studio.add(mesh);
  };
  panel([-4, 5.5, 6], 6, 5, 4.5);
  panel([1, 7, -1], 4, 3, 1.6);
  panel([6, 2, 1], 3, 5, 0.12);
  const environment = pmrem.fromScene(studio, 0.04, 0.1, 100);
  studio.traverse((obj) => {
    const m = obj as THREE.Mesh;
    m.geometry?.dispose();
    (m.material as THREE.Material | undefined)?.dispose();
  });
  scene.environment = environment.texture;
  scene.environmentIntensity = 0.8;

  const key = new THREE.DirectionalLight("#ffe4bd", 2.8);
  key.castShadow = true;
  key.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
  // The shadow camera is placed in WORLD space from the light's position,
  // so these extents are metres (UNIT × design units) around the target —
  // wide enough for the device's shadow on the back wall and the floor
  // behind it, from a front-left key.
  Object.assign(key.shadow.camera, {
    left: -5 * UNIT,
    right: 5 * UNIT,
    top: 6 * UNIT,
    bottom: -4 * UNIT,
    near: 0.1 * UNIT,
    far: 30 * UNIT,
  });
  key.shadow.bias = -0.00008;
  key.shadow.normalBias = 0.00012;
  key.shadow.autoUpdate = false;
  key.shadow.needsUpdate = true;
  key.shadow.radius = 6;
  key.shadow.blurSamples = 12;
  key.target.position.set(0, 1.8, 0);
  scene.add(key, key.target);
  const fill = new THREE.DirectionalLight("#c3e6ff", 0.9);
  fill.position.set(4, 3, 4);
  scene.add(fill);
  const rim = new THREE.DirectionalLight("#d9efff", 1.8);
  rim.position.set(2, 5, -4);
  scene.add(rim);
  const sky = new THREE.HemisphereLight("#d9edf7", "#7f8b91", 0.9);
  scene.add(sky);
  // The study's softbox was a 5×5 RectAreaLight (LTC). As a directional
  // light from the same place it reads the same on these satin surfaces,
  // and the scene pass lost a third of its cost on an iGPU (ADR 0057 §2.9).
  // Its strength rides lighting.ts's SOFTBOX_PER_KEY.
  const softbox = new THREE.DirectionalLight("#ffffff", 0);
  softbox.position.set(-3.5, 5.5, 6);
  softbox.target.position.set(0, 1.9, 0);
  scene.add(softbox, softbox.target);
  // The weak night outline: grazes the upper-right edge through the open
  // side, casting live shadows; fades out with daylight.
  const contour = new THREE.SpotLight("#b6cced", 0, 0.9, 0.65, 1, 2);
  contour.position.set(4.8, 5.4, 2.4);
  contour.target.position.set(0, 1.9, 0);
  contour.castShadow = true;
  contour.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
  contour.shadow.camera.near = 0.01;
  contour.shadow.camera.far = 0.9;
  contour.shadow.bias = -0.001;
  contour.shadow.normalBias = 0.0005;
  contour.shadow.radius = 4;
  contour.shadow.blurSamples = 8;
  contour.shadow.autoUpdate = false;
  contour.shadow.needsUpdate = true;
  scene.add(contour, contour.target);

  // Post: 2× MSAA scene pass with an emissive MRT lane → bloom on the lamp
  // only → SMAA over the composed picture (an opaque canvas: the room is
  // the card's content, so SMAA's alpha handling is moot here). The study
  // ran 4×; on an Intel iGPU that pass cost 9 ms a frame against 5.7 at 2×
  // with no difference SMAA did not cover (ADR 0057 §2.9). The emissive
  // lane is free: measured within noise of a single attachment.
  const scenePass = pass(scene, camera, { samples: 2 });
  scenePass.setMRT(mrt({ output, emissive }));
  const graph = new THREE.RenderPipeline(renderer);
  const sceneColor = scenePass.getTextureNode("output");
  const bloomNode = bloom(
    scenePass.getTextureNode("emissive"),
    0.075,
    0.32,
    1.6,
  );
  const smaaNode = smaa(sceneColor.add(bloomNode));
  graph.outputNode = smaaNode;

  // ── assets ──
  const u = makeUniforms();
  const ktx = new KTX2Loader()
    .setTranscoderPath(assetUrl("basis/"))
    .setWorkerLimit(2)
    .detectSupport(renderer);
  const png = new THREE.TextureLoader();
  const loadKtx = async (
    file: string,
    colorSpace: string,
  ): Promise<THREE.Texture> => {
    const tex = await ktx.loadAsync(assetUrl(file));
    configureAtlas(tex, colorSpace);
    return tex;
  };
  const loadScalar = async (
    file: string,
    channel: number,
  ): Promise<THREE.Texture> => {
    const tex = scalarTexture(await png.loadAsync(assetUrl(file)), channel);
    configureAtlas(tex, THREE.NoColorSpace);
    return tex;
  };
  const tex = {} as DeviceTextures;
  await Promise.all([
    ...DEVICE_LDR.map(async (name) => {
      tex[name] = await loadKtx(
        `baked-v1-${name}.ktx2`,
        name === "basecolor" ? THREE.SRGBColorSpace : THREE.NoColorSpace,
      );
    }),
    ...DEVICE_SCALAR.map(async (name) => {
      // Roughness lives in the source's green channel, cavity in red.
      tex[name] = await loadScalar(
        `baked-v1-${name}.png`,
        name === "roughness" ? 1 : 0,
      );
    }),
    ...DEVICE_HDR.map(async (name) => {
      tex[name] = await loadKtx(
        `baked-v1-${name}.ktx2`,
        THREE.LinearSRGBColorSpace,
      );
    }),
    ...SPACE_HDR.map(async (name) => {
      tex[name] = await loadKtx(
        `space-v1-${name}.ktx2`,
        THREE.LinearSRGBColorSpace,
      );
    }),
  ]);
  ktx.dispose();
  const dayNodes: Vec3Node[] = (
    ["device-morning", "device-midday", "device-evening"] as const
  ).map((name) => texture(tex[name], uv(1).flipY()).rgb as unknown as Vec3Node);

  const gltfLoader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const device = await gltfLoader.loadAsync(assetUrl("device.glb"));
  const ringMaterials: BakedStandardMaterial[] = [];
  device.scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    if (mesh.geometry.attributes.uv1 === undefined) {
      throw new Error(`missing bake UV on ${mesh.name}`);
    }
    // The source tangents describe the material UV; the baked normals use
    // the bake UV, so the frame is rebuilt from that channel instead.
    mesh.geometry.deleteAttribute("tangent");
    const lampChannel = mesh.geometry.attributes.uv2 !== undefined;
    const sources = (
      Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    ) as THREE.MeshStandardMaterial[];
    const materials = sources.map((m) =>
      makeDeviceMaterial(m, lampChannel, tex, u, dayNodes),
    );
    mesh.material = Array.isArray(mesh.material)
      ? materials
      : (materials[0] as THREE.Material);
    for (const m of materials) {
      if (m.name.startsWith("Indicator")) ringMaterials.push(m);
    }
  });
  device.scene.scale.setScalar(1 / UNIT);
  assembly.add(device.scene);

  const space = await gltfLoader.loadAsync(assetUrl("alcove.glb"));
  const alcove = space.scene;
  alcove.scale.setScalar(1 / UNIT);
  alcove.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (mesh.geometry.attributes.uv1 === undefined) {
      throw new Error("missing alcove bake UV");
    }
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.material = makeSpaceMaterial(
      mesh.material as THREE.MeshStandardMaterial,
      mesh.name,
      tex,
      u,
    );
  });
  scene.add(alcove);
  scene.updateMatrixWorld(true);
  const bounds = new THREE.Box3()
    .setFromObject(device.scene)
    .getSize(new THREE.Vector3());
  camera.updateMatrixWorld();
  const basis = camera.matrixWorldInverse.elements;
  const projectedDeviceHeight =
    bounds.x * Math.abs(basis[1] ?? 0) +
    bounds.y * Math.abs(basis[5] ?? 0) +
    bounds.z * Math.abs(basis[9] ?? 0);
  const loadMs = performance.now() - t0;

  // ── live state ──
  let inputs = opts.initial;
  let disposed = false;
  let ready = false;
  let raf: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastTime = 0;
  let activeUntil = 0;
  let focused = document.hasFocus();
  let unfocusedSince = 0;
  let stateEntered = performance.now();
  let stageWidth = 0;
  let stageHeight = 0;
  let liveHour = cardHourFor(inputs.theme, new Date());
  let liveIntensity = STATE_TARGETS[inputs.state].intensity;
  const liveColor = new THREE.Color(STATE_TARGETS[inputs.state].color);
  const targetColor = new THREE.Color(STATE_TARGETS[inputs.state].color);
  const pose = createLiftPose();
  let shadowStamp: number[] = [];
  const shadowDirty = { key: true, contour: true };
  // Once-a-second diagnostics on the canvas dataset (a DOM write per
  // second, never per frame): fps, mean CPU submit ms, draw calls, and with
  // `profile` the GPU time of the last resolved frame.
  let statFrames = 0;
  let statSubmit = 0;
  let statSince = performance.now();
  let gpuPending = false;
  let gpuUnresolved = 0;
  const report = (now: number, renderMs: number): void => {
    statFrames += 1;
    statSubmit += renderMs;
    gpuUnresolved += 1;
    const elapsed = now - statSince;
    const tick = elapsed >= 1000;
    if (tick) {
      canvas.dataset.fps = ((statFrames * 1000) / elapsed).toFixed(1);
      canvas.dataset.submitMs = (statSubmit / statFrames).toFixed(2);
      canvas.dataset.draws = String(renderer.info.render.drawCalls);
      canvas.dataset.tris = String(renderer.info.render.triangles);
      statFrames = 0;
      statSubmit = 0;
      statSince = now;
    }
    // The query pool holds ~50 frames of passes: resolve well before that.
    if (profile && !gpuPending && (tick || gpuUnresolved >= 16)) {
      gpuPending = true;
      gpuUnresolved = 0;
      renderer
        .resolveTimestampsAsync(THREE.TimestampQuery.RENDER)
        .then((ms) => {
          if (!tick) return;
          if (ms !== undefined && ms > 0) canvas.dataset.gpuMs = ms.toFixed(2);
          canvas.dataset.gpuPasses = JSON.stringify(gpuPassBreakdown(renderer));
        })
        .catch(() => undefined)
        .finally(() => {
          gpuPending = false;
        });
    }
  };

  const stopLoop = (): void => {
    if (raf !== null) cancelAnimationFrame(raf);
    if (timer !== null) clearTimeout(timer);
    raf = null;
    timer = null;
  };
  const mayRun = (): boolean =>
    !disposed && ready && !inputs.paused && !document.hidden;
  const schedule = (delay = 0): void => {
    if (raf !== null || timer !== null || !mayRun()) return;
    if (delay > 1) {
      timer = setTimeout(() => {
        timer = null;
        raf = requestAnimationFrame(frame);
      }, delay);
    } else {
      raf = requestAnimationFrame(frame);
    }
  };
  const wake = (duration = 0): void => {
    activeUntil = Math.max(activeUntil, performance.now() + duration);
    if (raf === null && timer === null) {
      lastTime = performance.now() - 16;
      schedule();
    }
  };

  const resize = (): void => {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width === 0 || height === 0) return;
    stageWidth = width;
    stageHeight = height;
    // Frame the device to the flat card's visible silhouette height, not the
    // whole card.
    const span = (projectedDeviceHeight * stageHeight) / DEVICE_HEIGHT_PX;
    camera.left = (-span * stageWidth) / stageHeight / 2;
    camera.right = (span * stageWidth) / stageHeight / 2;
    camera.top = span / 2;
    camera.bottom = -span / 2;
    camera.updateProjectionMatrix();
    const ratio = renderPixelRatio(
      stageWidth,
      stageHeight,
      window.devicePixelRatio || 1,
    );
    if (renderer.getPixelRatio() !== ratio) renderer.setPixelRatio(ratio);
    renderer.setSize(stageWidth, stageHeight, false);
    wake(500);
  };

  const frame = (now: number): void => {
    raf = null;
    if (!mayRun()) return;
    if (
      !focused &&
      now - unfocusedSince > PARK_UNFOCUSED_MS &&
      now > activeUntil
    ) {
      return;
    }
    const dt = Math.min((now - (lastTime || now)) / 1000, 0.05);
    lastTime = now;
    const ease = 1 - Math.exp(-dt * 5.5);

    // The clock, folded per theme; eased so a theme flip passes through
    // dusk and a minute's drift is invisible.
    const hourDiff = hourDelta(liveHour, cardHourFor(inputs.theme, new Date()));
    liveHour = (((liveHour + hourDiff * ease) % 24) + 24) % 24;
    const light = lightingAt(liveHour);
    background.set(light.background).multiplyScalar(light.external);
    key.color.set(light.keyColor);
    key.intensity = light.key;
    key.position.fromArray(light.position as unknown as number[]);
    fill.intensity = light.fill;
    rim.intensity = light.rim;
    sky.intensity = light.sky;
    softbox.intensity = light.softbox;
    softbox.color.copy(key.color);
    contour.intensity = light.contour;
    scene.environmentIntensity = light.environment;
    renderer.toneMappingExposure = light.exposure;
    scene.environmentRotation.y = light.rotation;

    const target = STATE_TARGETS[inputs.state];
    liveColor.lerp(targetColor, ease);
    liveIntensity = THREE.MathUtils.lerp(liveIntensity, target.intensity, ease);
    const motion = !inputs.reducedMotion;
    const seconds = (now - stateEntered) / 1000;
    const breath = motion
      ? 1 + Math.sin((now / 1000) * target.hz * Math.PI * 2) * target.depth
      : 1;
    let flash = 0;
    if (motion && inputs.state === "succeeded") {
      flash =
        Math.max(0, 1 - seconds / 1.5) * Math.min(seconds / 0.15, 1) * 1.5;
    }
    if (motion && inputs.state === "failed") {
      flash =
        Math.max(
          0,
          1 - Math.abs(seconds - 0.12) / 0.12,
          1 - Math.abs(seconds - 0.45) / 0.12,
        ) * 1.3;
    }
    const ringIntensity = liveIntensity * breath + flash;
    for (const mat of ringMaterials) {
      mat.emissive.copy(liveColor);
      mat.emissiveIntensity = ringIntensity;
      mat.color.copy(liveColor);
    }
    (bloomNode.strength as { value: number }).value =
      (0.065 + light.night * 0.1) / Math.sqrt(light.adaptation);

    const held = inputs.liftPx > 0;
    const liftMoving = advanceLift(pose, dt, held);
    // Lift is measured in CSS px like the flat card, independent of DPR.
    const lift =
      (pose.liftPx * (camera.top - camera.bottom)) /
      (Math.max(1, stageHeight) * UNIT);
    assembly.position.y = lift;
    // The contact shadow stays on the floor and fades as the device rises
    // (gone by the 12 px ceiling), and goes with the daylight at night.
    u.contact.value =
      CONTACT_STRENGTH * Math.max(0, 1 - pose.liftPx / 12) * light.external;

    // Pulsing the indicator does not move the silhouette: shadow maps are
    // reused until the key or the device has moved by about a shadow texel.
    // (The clock drifts the key every frame; a finer threshold re-rendered
    // the shadow — three passes at 1024² — on most frames of the day.)
    const nextStamp = [
      key.position.x,
      key.position.y,
      key.position.z,
      assembly.position.y,
    ];
    const changed = nextStamp.map(
      (v, i) =>
        Math.abs(v - (shadowStamp[i] ?? Number.POSITIVE_INFINITY)) >
        SHADOW_MOVE_UNITS,
    );
    if (changed.some(Boolean)) {
      shadowDirty.key = true;
      if (changed[3] === true) shadowDirty.contour = true;
      shadowStamp = nextStamp;
    }
    for (const [name, l] of [
      ["key", key],
      ["contour", contour],
    ] as const) {
      const explicit = l.shadow.needsUpdate;
      if (explicit) shadowDirty[name] = true;
      l.shadow.needsUpdate = shadowDirty[name] && (l.intensity > 0 || explicit);
      if (l.shadow.needsUpdate) shadowDirty[name] = false;
    }

    // Bake weights: daylight bounce by hour, faded as the device leaves its
    // baked pose; ring transport scaled by the live indicator.
    u.lift.value = lift * UNIT;
    u.weights.value.fromArray(timeWeights(liveHour));
    const poseValidity = Math.exp(-10 * Math.max(lift, 0));
    u.bounceStrength.value = poseValidity * light.external;
    u.roomStrength.value = poseValidity;
    u.ringColor.value.copy(liveColor);
    u.ringStrength.value = ringIntensity;

    const renderStart = performance.now();
    graph.render();
    const renderMs = performance.now() - renderStart;
    report(now, renderMs);

    const moving = held || liftMoving || now < activeUntil;
    if (motion || moving || Math.abs(hourDiff) > 0.005) {
      const fps = moving ? MOVING_FPS : CALM_FPS;
      schedule(Math.max(0, 1000 / fps - renderMs - 2));
    }
  };

  // ── wiring ──
  const onFocus = (): void => {
    focused = true;
    wake(500);
  };
  const onBlur = (): void => {
    focused = false;
    unfocusedSince = performance.now();
  };
  const onVisibility = (): void => {
    if (document.hidden) stopLoop();
    else wake(500);
  };
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  window.addEventListener("focus", onFocus);
  window.addEventListener("blur", onBlur);
  document.addEventListener("visibilitychange", onVisibility);
  const clockTimer = setInterval(() => {
    if (inputs.theme === "light") wake(1100);
  }, CLOCK_WAKE_MS);

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    stopLoop();
    clearInterval(clockTimer);
    observer.disconnect();
    window.removeEventListener("focus", onFocus);
    window.removeEventListener("blur", onBlur);
    document.removeEventListener("visibilitychange", onVisibility);
    canvas.removeEventListener("webglcontextlost", onContextLost);
    scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      mesh.geometry?.dispose();
      const mats = mesh.material;
      if (mats !== undefined) {
        for (const m of Array.isArray(mats) ? mats : [mats]) disposeMaterial(m);
      }
    });
    for (const t of Object.values(tex)) t.dispose();
    scenePass.dispose();
    bloomNode.dispose();
    smaaNode.dispose();
    environment.dispose();
    pmrem.dispose();
    graph.dispose();
    renderer.dispose();
  };
  const fallback = (reason: string): void => {
    if (disposed) return;
    dispose();
    opts.onFallback(reason);
  };
  const onContextLost = (event: Event): void => {
    event.preventDefault();
    fallback("context lost");
  };
  canvas.addEventListener("webglcontextlost", onContextLost);
  renderer.onDeviceLost = (info) => {
    fallback(`device lost: ${info.reason ?? "unknown"}`);
  };

  // First frame before the card swaps its flat renders for the canvas, so
  // pipeline compilation never shows as a black card.
  // (PassNode.compileAsync was tried here and rejected: it took 2 s of
  // yielding node builds and the sync first frame still cost 0.4 s — the
  // post and shadow materials are the bulk, and the pass's own render
  // context is a different one anyway. ADR 0057 §2.9.)
  resize();
  const t1 = performance.now();
  graph.render();
  const firstFrameMs = performance.now() - t1;
  ready = true;
  wake(1400);

  return {
    stats: { backend, loadMs, firstFrameMs },
    update(next) {
      const prev = inputs;
      inputs = next;
      if (next.state !== prev.state) {
        stateEntered = performance.now();
        targetColor.set(STATE_TARGETS[next.state].color);
        wake(1800);
      }
      if (next.theme !== prev.theme) wake(1100);
      if (next.liftPx !== prev.liftPx) {
        pose.targetLiftPx = next.liftPx;
        wake(400);
      }
      if (next.reducedMotion !== prev.reducedMotion) wake(700);
      if (next.paused !== prev.paused) {
        if (next.paused) stopLoop();
        else wake(500);
      }
    },
    dispose,
  };
}
