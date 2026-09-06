import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { RectAreaLightTexturesLib } from "three/addons/lights/RectAreaLightTexturesLib.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
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
  vec4,
} from "three/tsl";
import * as THREE from "three/webgpu";
import type { BanzhuanDeviceState } from "../../../hooks/useDeviceState.js";
import type { ResolvedTheme } from "../../../hooks/useResolvedTheme.js";
import { advanceLift, createLiftPose } from "./lift.js";
import { lightingFor, STATE_TARGETS, THEME_DAYLIGHT } from "./lighting.js";

/**
 * The 3D device card's scene (ADR 0057 §2, amended 2026-09-06: no room):
 * the owner's Cycles-baked HRT-001 study (reference_UX_design/
 * banzhuan-3d-demo, main-webgpu.js + baked-material.js + device-surface.js)
 * reduced to what the app card needs — the device alone, on the card.
 *
 * Kept from the study: the compact mesh and its atlases, the baked ring
 * illumination, the "PNG match" white-studio lights (key / fill / rim /
 * sky / softbox with VSM shadows) and its lights-off night with the weak
 * outline spotlight and exposure adaptation, the soft contact shadow the
 * flat render has under the device, the satin-mineral surface refinement,
 * 4× MSAA + emissive bloom, on-demand rendering with an idle governor.
 *
 * Dropped: the alcove and its light-exchange bakes (the card's own frost is
 * the background — the canvas is transparent), the floor plane (this camera
 * sees it edge-on), SMAA (its blend discards alpha), weather, the time
 * slider, the compare wipe, the quality and asset-profile selectors, the
 * source-texture fallbacks (a machine that cannot transcode KTX2 keeps the
 * flat card). Light follows the THEME (lighting.ts).
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
/** Idle governor (mirrors DeviceGlow / AuraVisual): the breath renders at
 *  30 fps, motion at 60, and the loop parks after 5 s unfocused. */
const CALM_FPS = 30;
const MOVING_FPS = 60;
const PARK_UNFOCUSED_MS = 5000;

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
    lift: uniform(0),
  };
}
type BakeUniforms = ReturnType<typeof makeUniforms>;

type DeviceTextures = Record<
  | "basecolor"
  | "normal"
  | "roughness"
  | "cavity"
  | "ring-diffuse"
  | "ring-channel",
  THREE.Texture
>;

const DEVICE_LDR = ["basecolor", "normal"] as const;
const DEVICE_SCALAR = ["roughness", "cavity"] as const;
const DEVICE_HDR = ["ring-diffuse", "ring-channel"] as const;

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
  // Cavity is deliberately weak; the ring bake already carries the local
  // self-occlusion around the channel.
  mat.aoMap = tex.cavity;
  mat.aoMapIntensity = 0.28;
  // The ring's baked illumination on the device itself: the annulus keeps
  // its seamless channel bake, every other surface the diffuse one. This is
  // the study's studio mode — no room, no daylight bounce, the live lights
  // and the environment supply the rest.
  const localRing = texture(
    tex[lampChannel ? "ring-channel" : "ring-diffuse"],
    lampChannel ? uv(2).flipY() : uv(1).flipY(),
  ).rgb;
  mat.bakedIrradiance = localRing
    .mul(u.ringColor)
    .mul(u.ringStrength)
    .mul(Math.PI);
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

// ── Scene ───────────────────────────────────────────────────────────────────

function renderPixelRatio(width: number, height: number, dpr: number): number {
  const desired = Math.max(1.5, dpr);
  return Math.max(
    1,
    Math.min(2, desired, MAX_LONG_EDGE_PX / Math.max(width, height, 1)),
  );
}

/** The soft elliptical contact shadow the flat render carries under the
 *  device, as a radial-gradient texture on a ground plane. */
function makeContactTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 256;
  const ctx = c.getContext("2d");
  if (ctx === null) throw new Error("2d context unavailable");
  const gradient = ctx.createRadialGradient(128, 128, 8, 128, 128, 128);
  gradient.addColorStop(0, "rgba(0,0,0,.72)");
  gradient.addColorStop(0.4, "rgba(0,0,0,.42)");
  gradient.addColorStop(0.75, "rgba(0,0,0,.11)");
  gradient.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(c);
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

  const renderer = new THREE.WebGPURenderer({
    canvas,
    antialias: true,
    // Transparent: the card's own frost is the background, as under the
    // flat renders.
    alpha: true,
    // A decoration must never wake a laptop's discrete GPU.
    powerPreference: "low-power",
    forceWebGL: opts.forceWebGL,
  });
  await renderer.init();
  const backend: DeviceSceneStats["backend"] =
    (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend === true
      ? "webgpu"
      : "webgl2";
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.setClearColor(0x000000, 0);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.VSMShadowMap;

  const scene = new THREE.Scene();
  scene.scale.setScalar(UNIT);
  scene.background = null;
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
  scene.environmentIntensity = 0.65;

  // The shadow is the flat render's: a soft elliptical blob under the
  // device, facing the camera. No ground plane — this camera looks almost
  // along the floor (a 2° pitch), so a real floor shadow would be a sliver,
  // and an orthographic view of an infinite plane covers the whole card.
  // Sized and placed once the device's bounds are known.
  const contactShadow = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicNodeMaterial({
      map: makeContactTexture(),
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  scene.add(contactShadow);

  const key = new THREE.DirectionalLight("#ffffff", 3.1);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  Object.assign(key.shadow.camera, {
    left: -3.5 * UNIT,
    right: 3.5 * UNIT,
    top: 4.5 * UNIT,
    bottom: -3.5 * UNIT,
    near: 0.1 * UNIT,
    far: 22 * UNIT,
  });
  key.shadow.bias = -0.00008;
  key.shadow.normalBias = 0.00012;
  key.shadow.autoUpdate = false;
  key.shadow.needsUpdate = true;
  key.shadow.radius = 12;
  key.shadow.blurSamples = 12;
  key.target.position.set(0, 1.8, 0);
  scene.add(key, key.target);
  const fill = new THREE.DirectionalLight("#ffffff", 0.18);
  fill.position.set(4, 3, 4);
  scene.add(fill);
  const rim = new THREE.DirectionalLight("#ffffff", 0.24);
  rim.position.set(2, 5, -4);
  scene.add(rim);
  const sky = new THREE.HemisphereLight("#ffffff", "#aaaaaa", 0.22);
  scene.add(sky);
  THREE.RectAreaLightNode.setLTC(RectAreaLightTexturesLib.init());
  const softbox = new THREE.RectAreaLight("#ffffff", 1.0, 5 * UNIT, 5 * UNIT);
  softbox.position.set(-3.5, 5.5, 6);
  softbox.lookAt(0, 1.9, 0);
  scene.add(softbox);
  // The weak night outline: grazes the upper-right edge, casting live
  // shadows; fades out with daylight.
  const contour = new THREE.SpotLight("#b6cced", 0, 0.9, 0.65, 1, 2);
  contour.position.set(4.8, 5.4, 2.4);
  contour.target.position.set(0, 1.9, 0);
  contour.castShadow = true;
  contour.shadow.mapSize.set(1024, 1024);
  contour.shadow.camera.near = 0.01;
  contour.shadow.camera.far = 0.9;
  contour.shadow.bias = -0.001;
  contour.shadow.normalBias = 0.0005;
  contour.shadow.radius = 4;
  contour.shadow.blurSamples = 8;
  contour.shadow.autoUpdate = false;
  contour.shadow.needsUpdate = true;
  scene.add(contour, contour.target);

  // Post: 4× MSAA scene pass with an emissive MRT lane → bloom on the lamp
  // only. The scene's alpha is carried through explicitly (bloom's own alpha
  // would make the clear opaque). The study's final SMAA pass is NOT here:
  // its blend pass discards alpha, which turned the transparent card opaque
  // (bisected live, 2026-09-06); MSAA carries the edges on its own.
  const scenePass = pass(scene, camera, { samples: 4 });
  scenePass.setMRT(mrt({ output, emissive }));
  const graph = new THREE.RenderPipeline(renderer);
  const sceneColor = scenePass.getTextureNode("output");
  const bloomNode = bloom(
    scenePass.getTextureNode("emissive"),
    0.055,
    0.32,
    1.6,
  );
  graph.outputNode = vec4(sceneColor.rgb.add(bloomNode.rgb), sceneColor.a);

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
  ]);
  ktx.dispose();

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
      makeDeviceMaterial(m, lampChannel, tex, u),
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
  // The blob: the flat shadow layer's proportions against the device — a
  // little wider than the body, a tenth of its height — centred on the
  // base and pushed a step away from the camera so the feet sit on it.
  const shadowWidth = (bounds.x / UNIT) * 1.35;
  const shadowHeight = (bounds.y / UNIT) * 0.12;
  const viewDirection = new THREE.Vector3(0, 1.9, 0)
    .sub(new THREE.Vector3(58.5, 6.3, 110))
    .normalize();
  const shadowBase = new THREE.Vector3(0, 0.05, 0).add(
    viewDirection.multiplyScalar(1.2),
  );
  contactShadow.position.copy(shadowBase);
  contactShadow.quaternion.copy(camera.quaternion);
  contactShadow.scale.set(shadowWidth, shadowHeight, 1);
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
  let liveDaylight = THEME_DAYLIGHT[inputs.theme];
  let targetDaylight = liveDaylight;
  let liveIntensity = STATE_TARGETS[inputs.state].intensity;
  const liveColor = new THREE.Color(STATE_TARGETS[inputs.state].color);
  const targetColor = new THREE.Color(STATE_TARGETS[inputs.state].color);
  const pose = createLiftPose();
  let shadowStamp: number[] = [];
  const shadowDirty = { key: true, contour: true };

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

    const daylightDiff = targetDaylight - liveDaylight;
    liveDaylight += daylightDiff * ease;
    const light = lightingFor(liveDaylight);
    key.color.set(light.keyColor);
    key.intensity = light.key;
    key.position.fromArray(light.position as unknown as number[]);
    if (key.shadow.radius !== light.shadowRadius) {
      key.shadow.radius = light.shadowRadius;
      shadowDirty.key = true;
    }
    fill.intensity = light.fill;
    rim.intensity = light.rim;
    sky.intensity = light.sky;
    softbox.intensity = light.softbox;
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
    (bloomNode.strength as { value: number }).value = light.bloom;

    const held = inputs.liftPx > 0;
    const liftMoving = advanceLift(pose, dt, held);
    // Lift is measured in CSS px like the flat card, independent of DPR.
    const lift =
      (pose.liftPx * (camera.top - camera.bottom)) /
      (Math.max(1, stageHeight) * UNIT);
    assembly.position.y = lift;
    // The blob stays grounded and only shrinks and fades as the device
    // rises — the flat card's shadow rule (scale 1 − 0.01·px, opacity
    // 0.85 − 0.02·px).
    const contactMaterial = contactShadow.material as THREE.Material;
    contactMaterial.opacity = 0.85 - 0.02 * pose.liftPx;
    const settle = 1 - 0.01 * pose.liftPx;
    contactShadow.scale.set(shadowWidth * settle, shadowHeight * settle, 1);

    // Pulsing the indicator does not move the silhouette: shadow maps are
    // reused until the key or the device moves.
    const nextStamp = [
      key.position.x,
      key.position.y,
      key.position.z,
      assembly.position.y,
    ];
    const changed = nextStamp.map(
      (v, i) =>
        Math.abs(v - (shadowStamp[i] ?? Number.POSITIVE_INFINITY)) > 1e-5,
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

    u.lift.value = lift * UNIT;
    u.ringColor.value.copy(liveColor);
    u.ringStrength.value = ringIntensity;

    const renderStart = performance.now();
    graph.render();
    const renderMs = performance.now() - renderStart;

    const moving = held || liftMoving || now < activeUntil;
    if (motion || moving || Math.abs(daylightDiff) > 0.002) {
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

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    stopLoop();
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
      if (next.theme !== prev.theme) {
        targetDaylight = THEME_DAYLIGHT[next.theme];
        wake(1100);
      }
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
