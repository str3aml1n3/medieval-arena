// Medieval Arena — an original third-person arena duel.
// All geometry, textures and sounds are generated procedurally at runtime.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { BUILD } from './version.js';

// The world is the same on every visit: while it's being built (the ground, the clutter, the town, its houses' types,
// roofs, plaster and sizes, the mountains), Math.random is a seeded generator. Combat randomness is restored once the
// town stands (see preload). TOWN_SEED picks the town; ?seed=N in the URL tries another one.
const TOWN_SEED = +(new URLSearchParams(location.search).get('seed') || 7);
const realRandom = Math.random;
Math.random = (() => { let a = TOWN_SEED >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; })(); // mulberry32
const V3 = THREE.Vector3;
// Specular occlusion (approximate). The sky reflection (the environment map) reaches every surface, even where sun and
// torches don't, and that is what makes dull things look lacquered and lit up: shadowed stone, the hero's leather,
// feathers. Here a non-metal's sky reflection fades with how much direct light actually reaches the point (its direct
// diffuse light divided by its albedo), down to a third in full shadow. Metals keep more of theirs.
THREE.ShaderChunk.lights_fragment_end += `
#if defined( STANDARD ) && defined( RE_IndirectSpecular )
{
  float soDirect = dot( reflectedLight.directDiffuse, vec3( 0.299, 0.587, 0.114 ) );
  float soAlbedo = max( dot( material.diffuseColor, vec3( 0.299, 0.587, 0.114 ) ), 0.02 );
  float so = mix( 0.33, 1.0, clamp( soDirect / soAlbedo / 1.8, 0.0, 1.0 ) );
  reflectedLight.indirectSpecular *= mix( so, 1.0, clamp( metalnessFactor, 0.0, 1.0 ) * 0.55 );
}
#endif
`;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a, b) => a + Math.random() * (b - a);
const angWrap = a => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
const damp = (a, b, k, dt) => lerp(a, b, 1 - Math.exp(-k * dt));
const dampAng = (a, b, k, dt) => a + angWrap(b - a) * (1 - Math.exp(-k * dt));
const ease = t => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
const yawTo = (from, to) => Math.atan2(to.x - from.x, to.z - from.z);
const ARENA_R = 17.2;
const STAND_TIERS = [[20.3, 5.0], [21.7, 6.2]];

// ============================================================ renderer / scene
// phones and tablets: touch controls, and a lighter start (lower resolution, smaller shadow map); the resolution then
// adapts to the frame rate on every device (see `adaptResolution`)
const TOUCH = matchMedia('(pointer: coarse)').matches && navigator.maxTouchPoints > 0;
const renderer = new THREE.WebGLRenderer({ antialias: !TOUCH, powerPreference: 'high-performance' }); // on dual-GPU laptops, ask for the fast one
const MAX_PR = Math.min(devicePixelRatio, 1.5); // 2× screens would shade 78 % more pixels for little visible gain
let pixelRatio = MAX_PR;
renderer.setPixelRatio(pixelRatio);
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.9;
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x8e9296, 0.0058);
const camera = new THREE.PerspectiveCamera(58, innerWidth / innerHeight, 0.1, 400);
camera.position.set(0, 4, 14);

// three.js keeps the vertical field of view fixed, so a tall, narrow (portrait) screen would see only a sliver of the
// arena: widen the vertical view until the horizontal one is at least ~64°
function fitFov() {
  const a = innerWidth / innerHeight;
  camera.fov = a >= 1 ? 58 : Math.min(88, 2 * Math.atan(Math.tan(32 * Math.PI / 180) / a) * 180 / Math.PI);
}
fitFov(); camera.updateProjectionMatrix();
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; fitFov(); camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  for (const p of particleSystems) p.mat.uniforms.scale.value = pointScale();
});

function std(color, rough = 0.85, metal = 0, extra = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, ...extra });
}
// physical material — clearcoat / sheen give the cold specular glint under the daylight env map
function phys(color, rough = 0.5, metal = 0, extra = {}) {
  return new THREE.MeshPhysicalMaterial({ color, roughness: rough, metalness: metal, ...extra });
}
function mesh(geo, mat, parent, pos = [0, 0, 0], rot = [0, 0, 0], scl = null) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(...pos); m.rotation.set(...rot);
  if (scl) m.scale.set(...scl);
  m.castShadow = true; m.receiveShadow = true;
  parent.add(m); return m;
}
const UP = new V3(0, 1, 0);
function orient(m, dir) { m.quaternion.setFromUnitVectors(UP, dir.clone().normalize()); return m; }
const sphere = (r, w = 14, h = 10) => new THREE.SphereGeometry(r, w, h);
const cone = (r, h, s = 7) => new THREE.ConeGeometry(r, h, s);
const capsule = (r, l) => new THREE.CapsuleGeometry(r, l, 4, 10);

function canvasTex(size, draw, rep = 1) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d'); draw(g, size);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(rep, rep);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}

// ============================================================ sky + lights
// Value noise as a texture. Sampling it at texel centres with a smoothstep-warped fraction gives exactly the classic
// value noise, in one fetch instead of four sin() hashes. R holds G shifted by (37,17), so a single fetch also yields
// the next Z layer for 3D noise.
const noiseTex = (() => {
  const N = 256, g = new Uint8Array(N * N), d = new Uint8Array(N * N * 4);
  for (let i = 0; i < g.length; i++) g[i] = Math.random() * 256;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = (y * N + x) * 4;
    d[i] = g[((y + 17) % N) * N + ((x + 37) % N)]; d[i + 1] = g[y * N + x]; d[i + 2] = 0; d[i + 3] = 255;
  }
  const t = new THREE.DataTexture(d, N, N, THREE.RGBAFormat); t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = t.minFilter = THREE.LinearFilter; t.generateMipmaps = false; t.needsUpdate = true; return t;
})();
const SUN_DIR = new V3(0.38, 0.8, 0.46).normalize();
// A brooding, hazy sky: warped, drifting cumulus lit from the sun side with dark bellies, thin cirrus above,
// a soft sun halo burning through the haze, and lightning that flickers inside the clouds.
const sky = new THREE.Mesh(new THREE.SphereGeometry(300, 48, 24), new THREE.ShaderMaterial({
  side: THREE.BackSide, depthWrite: false, fog: false,
  uniforms: { sunDir: { value: SUN_DIR }, time: { value: 0 }, flash: { value: 0 }, flashDir: { value: new V3(0, 1, 0) }, noiseTex: { value: noiseTex }, overcast: { value: 0 },
    dayK: { value: 1 }, duskK: { value: 0 }, moonDir: { value: new V3(0, 1, 0) } },
  vertexShader: `varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `varying vec3 vD; uniform vec3 sunDir; uniform float time; uniform float flash; uniform vec3 flashDir; uniform float overcast;
    uniform float dayK; uniform float duskK; uniform vec3 moonDir;
    uniform sampler2D noiseTex;
    float hash3(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
    float noise(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.0-2.0*f);
      return texture2D(noiseTex, (i + u + 0.5) / 256.0).g; }
    float fbm(vec2 p){ float v = 0.0, a = 0.5; mat2 r = mat2(0.8,-0.6,0.6,0.8); for (int i = 0; i < 5; i++){ v += a*noise(p); p = r*p*2.03; a *= 0.5; } return v; } // 5 octaves: the 6th was finer than a pixel at the sky's distance
    void main(){
      vec3 d = normalize(vD); float h = d.y;
      // overcast (weather): the sky greys over, the sun is buried, the clouds close up into a low, dark lid
      float oc = overcast;
      vec3 zen = mix(vec3(0.09,0.14,0.24), vec3(0.22,0.24,0.26), oc), mid = mix(vec3(0.30,0.36,0.44), vec3(0.33,0.35,0.37), oc), hor = mix(vec3(0.60,0.58,0.54), vec3(0.44,0.46,0.47), oc);
      vec3 c = mix(hor, mid, smoothstep(0.0, 0.22, h));
      c = mix(c, zen, smoothstep(0.18, 0.95, h));
      c = mix(c, vec3(0.30,0.31,0.28), smoothstep(0.0, -0.15, h));
      float s = max(dot(d, sunDir), 0.0) * smoothstep(-0.06, 0.04, sunDir.y); // no sun glow once it has set
      vec3 sunCol = mix(vec3(1.0,0.86,0.66), vec3(1.0,0.55,0.28), duskK);   // reddens low on the horizon
      c += sunCol * (pow(s, 5.0) * 0.18 + pow(s, 48.0) * 0.35) * (1.0 - oc * 0.85);
      float cov = 0.0;
      if (h > -0.03) {
        vec2 uv = d.xz / (h + 0.13) * 1.15;
        vec2 w = vec2(time * 0.006, time * 0.0025);
        vec2 q = uv + w + 0.55 * vec2(fbm(uv * 0.7 - w), fbm(uv * 0.7 + 3.1 + w)); // domain warp → billowing shapes
        float n = fbm(q);
        cov = smoothstep(0.40 - 0.3 * oc, 0.74 - 0.22 * oc, n) * smoothstep(-0.03, 0.18, h);
        float n2 = fbm(q + normalize(sunDir.xz + 1e-4) * 0.09);                   // one step toward the sun
        float lit = clamp((n - n2) * 4.0 + 0.45, 0.0, 1.0);
        vec3 belly = mix(vec3(0.16,0.17,0.20), vec3(0.12,0.13,0.14), oc), top = mix(vec3(0.86,0.83,0.78), vec3(0.42,0.44,0.46), oc);
        vec3 cc = mix(belly, top, lit * 0.75 + smoothstep(0.75, 0.4, n) * 0.25);
        cc += sunCol * pow(s, 10.0) * (1.0 - smoothstep(0.5, 0.8, n)) * 0.9 * (1.0 - oc); // silver lining near the sun
        cc = mix(cc, hor, smoothstep(0.25, 0.0, h) * 0.55);                      // distant clouds melt into the haze
        c = mix(c, cc, cov * 0.94);
        float ci = fbm(vec2(uv.x * 0.6, uv.y * 2.4) + w * 2.0);                  // high cirrus streaks
        c = mix(c, vec3(0.80,0.80,0.80), smoothstep(0.55, 0.9, ci) * 0.18 * (1.0 - cov) * smoothstep(0.05, 0.4, h));
        // dusk and dawn: cloud undersides catch the low sun
        c += vec3(0.55,0.22,0.06) * duskK * cov * (0.3 + lit * 0.7) * (1.0 - oc * 0.7) * smoothstep(-0.2, 0.6, dot(normalize(d.xz + 1e-4), normalize(sunDir.xz + 1e-4)));
      }
      c = mix(c, hor * 1.04, exp(-max(h, 0.0) * 10.0) * 0.55);                    // thick haze on the horizon
      c += sunCol * pow(s, 1400.0) * 5.0 * (1.0 - cov * 0.9) * (1.0 - oc);
      // golden hour: the horizon toward the sun burns orange
      float toSun = pow(max(dot(normalize(vec3(d.x, 0.0, d.z) + 1e-4), normalize(vec3(sunDir.x, 0.0, sunDir.z) + 1e-4)), 0.0), 3.0);
      c = mix(c, c * vec3(1.45, 0.82, 0.55) + vec3(0.16, 0.05, 0.0) * toSun, duskK * exp(-max(h, 0.0) * 4.0) * (0.5 + 0.5 * toSun) * (1.0 - oc * 0.6));
      // night: the whole sky goes dark blue, then stars and the moon come out where the clouds part
      c *= mix(vec3(0.05, 0.065, 0.11), vec3(1.0), dayK);
      float clear = (1.0 - cov) * (1.0 - oc) * (1.0 - dayK) * smoothstep(0.04, 0.3, h);
      vec3 sd = d * 420.0; float st = hash3(floor(sd));
      c += vec3(0.85, 0.9, 1.0) * step(0.9965, st) * (0.5 + 0.5 * sin(time * (2.0 + st * 7.0) + st * 60.0)) * clear * 1.2;
      float m = max(dot(d, moonDir), 0.0);
      c += vec3(0.9, 0.93, 1.0) * (smoothstep(0.99975, 0.99985, m) * 1.4 + pow(m, 60.0) * 0.08) * (1.0 - dayK) * (1.0 - cov * 0.85);
      // lightning lights the clouds from inside (after the night darkening: a flash is just as bright at night)
      if (h > -0.03) c += vec3(0.55,0.65,1.0) * flash * pow(max(dot(d, flashDir), 0.0), 10.0) * (0.25 + cov * 1.4);
      gl_FragColor = vec4(c, 1.0);
    }`
}));
scene.add(sky);

// ---- the barrier: a vast dome of force over the town, mostly invisible — a living, veined membrane that streams
// and breathes, glows where it meets the land, and crackles with arcs of lightning that send ripples across it
const barrier = (() => {
  const R = 150, HITS = 6;
  const geo = new THREE.SphereGeometry(R, 96, 40);
  const hits = Array.from({ length: HITS }, () => new THREE.Vector4(0, 1, 0, 99));
  // A living membrane rather than a grid: warped, drifting noise grows branching veins and soft cells,
  // light pulses stream along the veins, the whole skin slowly breathes, and it only shows in drifting patches.
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
    uniforms: { time: { value: 0 }, hits: { value: hits }, noiseTex: { value: noiseTex }, agit: { value: 0 } },
    vertexShader: `varying vec3 vN; void main(){ vN = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `varying vec3 vN; uniform float time; uniform float agit; uniform vec4 hits[${HITS}];
      float hash(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
      vec3 hash3(vec3 p){ return vec3(hash(p), hash(p + 31.7), hash(p + 71.3)); }
      uniform sampler2D noiseTex;
      float noise(vec3 x){ vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
        vec2 rg = texture2D(noiseTex, (i.xy + vec2(37.0, 17.0) * i.z + f.xy + 0.5) / 256.0).yx;
        return mix(rg.x, rg.y, f.z); }
      float fbm(vec3 p){ float v = 0.0, a = 0.5; for (int i = 0; i < 4; i++){ v += a * noise(p); p = p * 2.03 + vec3(1.7, 9.2, 3.1); a *= 0.5; } return v; }
      float fbm2(vec3 p){ return (noise(p) * 0.5 + noise(p * 2.03 + vec3(1.7, 9.2, 3.1)) * 0.25) / 0.75; } // for the slow, broad warp
      // soft cell walls: distance to the nearest two jittered seeds (smooth, like a membrane of cells)
      // (searching the 2×2×2 cells on the near side of the point, not all 27: the far ones almost never hold a nearest seed)
      float cells(vec3 p, float t){ vec3 i = floor(p), f = fract(p), s = step(0.5, f) - 1.0; float d1 = 8.0, d2 = 8.0;
        for (int x = 0; x <= 1; x++) for (int y = 0; y <= 1; y++) for (int z = 0; z <= 1; z++) {
          vec3 g = vec3(x, y, z) + s, o = hash3(i + g); o = 0.5 + 0.4 * sin(t * 0.4 + 6.2831 * o);
          float d = length(g + o - f); if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d; }
        return d2 - d1; }
      void main(){
        vec3 n = normalize(vN); float t = time;
        if (n.y < -0.03) discard;
        vec3 p = n * 4.0;
        // the skin only surfaces in a few drifting patches; they swell, fade and wander so it is never visible everywhere
        float pn = fbm(p * 0.38 + vec3(t * 0.02, -t * 0.03, t * 0.015)) + 0.12 * sin(t * 0.21 + n.x * 3.0);
        // agit (0 clear sky .. 1 storm): calm, faint and patchy under a clear sky; in rain it surfaces widely and seethes
        float veil = smoothstep(0.6 - 0.14 * agit, 0.76 - 0.12 * agit, pn);
        float base = exp(-max(n.y, 0.0) * 8.0) * smoothstep(0.45, 0.7, pn + 0.08); // thickest where it sinks into the land, also in patches
        float vis = veil * 0.45 + base * 0.55;
        // most of the dome is invisible most of the time: skip all the expensive vein work there unless a strike is near
        float struck = 0.0;
        for (int i = 0; i < ${HITS}; i++) { float age = hits[i].w; if (age < 2.2 && dot(n, hits[i].xyz) > cos(age * 0.3 + 0.3)) struck = 1.0; } // the ring and glow are spent beyond this
        if (vis < 0.003 && struck < 0.5) discard;
        // domain warp that slowly evolves → everything streams and curls
        vec3 w = vec3(fbm2(p * 0.7 + vec3(0.0, t * 0.035, 0.0)), fbm2(p * 0.7 + vec3(5.2, 1.3, t * 0.03)), fbm2(p * 0.7 + vec3(t * 0.03, 7.7, 2.1)));
        vec3 q = p + (w - 0.5) * 3.2;
        // branching veins: ridges of two noise octaves, thin and bright where they cross
        float v1 = 1.0 - abs(noise(q * 1.6) * 2.0 - 1.0);
        float v2 = 1.0 - abs(noise(q * 3.4 + 4.0) * 2.0 - 1.0);
        float veins = pow(v1, 14.0) + pow(v2, 22.0) * 0.55 * smoothstep(0.6, 1.0, v1 + 0.4);
        // light pulsing along the veins, like blood or sap moving through them
        float flow = 0.35 + 0.65 * pow(0.5 + 0.5 * sin(dot(q, vec3(1.3, 2.1, 0.7)) * 2.2 - t * 1.6), 3.0);
        float memb = 0.0;                                                     // faint walls of the cells (a 27-cell search,
        if (vis > 0.03 || struck > 0.5) memb = smoothstep(0.16, 0.0, cells(q * 1.1, t)) * 0.35; // so only where they can show)
        float breathe = 0.75 + 0.25 * sin(t * 0.55 + w.x * 4.0);
        float I = ((veins * flow + memb) * vis * breathe + (veil * 0.02 + base * 0.045) * breathe) * (0.55 + 0.9 * agit);
        for (int i = 0; i < ${HITS}; i++) {
          float age = hits[i].w; if (age > 2.2) continue;
          float d = acos(clamp(dot(n, hits[i].xyz), -1.0, 1.0)) + (w.y - 0.5) * 0.04; // wobbly, not a perfect circle
          float ring = exp(-pow((d - age * 0.3) * 22.0, 2.0)) * exp(-age * 1.5);
          float lit = exp(-d * 9.0) * exp(-age * 1.2);                                 // veins near the strike light up
          float core = exp(-d * 28.0) * exp(-age * 5.0);
          I += ring * (0.12 + veins * 1.8 + memb * 1.5) + lit * (veins * 2.2 + memb) + core * 0.8;
        }
        I *= smoothstep(-0.03, 0.02, n.y);
        vec3 col = mix(vec3(0.35, 0.62, 1.0), vec3(0.62, 0.42, 1.0), smoothstep(0.35, 0.65, w.z)); // drifts between cyan and violet
        gl_FragColor = vec4(col * I + vec3(0.85, 0.9, 1.0) * I * I * 0.35, 1.0);
      }`,
  });
  const dome = new THREE.Mesh(geo, mat); dome.frustumCulled = false; dome.renderOrder = -1; scene.add(dome);

  // lightning arcs: jagged random walks along the dome surface, drawn as a bright core with two offset glows
  const MAXP = 90, arcs = [];
  const arcMat = (op) => new THREE.LineBasicMaterial({ color: 0xcfe2ff, transparent: true, opacity: op, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
  for (let i = 0; i < 5; i++) {
    const layers = [1, 0.35, 0.35].map((op, k) => {
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAXP * 2 * 3), 3));
      const l = new THREE.LineSegments(g, arcMat(op)); l.frustumCulled = false; l.visible = false; scene.add(l); return l;
    });
    arcs.push({ layers, life: 0, max: 0, seed: 0 });
  }
  let nextArc = 1.5, hitIdx = 0, ownT = 0;
  const tmp = new V3(), t1 = new V3(), t2 = new V3();
  function walk(out, start, dir, steps, jag) {
    const p = start.clone(); let d = dir.clone();
    for (let i = 0; i < steps && out.length < MAXP; i++) {
      t1.crossVectors(p, d).normalize();
      d.addScaledVector(t1, rand(-jag, jag)).addScaledVector(p, -d.dot(p)).normalize(); // stay tangent to the sphere
      const q = p.clone().addScaledVector(d, rand(0.012, 0.03)).normalize();
      if (q.y < 0.02) break;
      out.push([p.clone(), q.clone()]); p.copy(q);
      if (Math.random() < 0.08 && steps - i > 4) walk(out, p, d.clone().addScaledVector(t1, rand(-1.2, 1.2)).normalize(), (steps - i) * 0.5 | 0, jag);
    }
  }
  function spawn() {
    const a = arcs.find(x => x.life <= 0); if (!a) return;
    // most strikes land where the player is looking (as medieval-sim does), so they aren't wasted behind the camera
    let theta = rand(0, Math.PI * 2), y = Math.random() < 0.4 ? rand(0.03, 0.2) : rand(0.2, 0.9);
    if (Math.random() < 0.75) {
      camera.getWorldDirection(t2);
      theta = Math.atan2(t2.z, t2.x) + rand(-0.6, 0.6); y = clamp(Math.max(t2.y, 0) + rand(0.02, 0.4), 0.03, 0.9);
    }
    const start = new V3(Math.cos(theta) * Math.sqrt(1 - y * y), y, Math.sin(theta) * Math.sqrt(1 - y * y));
    const dir = tmp.set(rand(-1, 1), rand(-1, 1), rand(-1, 1)).addScaledVector(start, -tmp.dot(start)).normalize().clone();
    const segs = []; walk(segs, start, dir, rand(22, 50) | 0, 0.55); // curling, root-like tendrils of lightning
    t1.crossVectors(start, dir).normalize(); t2.copy(dir);
    a.layers.forEach((l, k) => {
      const off = k === 0 ? 0 : (k === 1 ? 0.35 : -0.35), arr = l.geometry.attributes.position.array;
      segs.forEach(([p, q], i) => {
        for (const [j, v] of [[0, p], [1, q]]) { const o = (i * 2 + j) * 3; arr[o] = v.x * R + t1.x * off; arr[o + 1] = v.y * R + t1.y * off + (k ? off * 0.5 : 0); arr[o + 2] = v.z * R + t1.z * off; }
      });
      l.geometry.setDrawRange(0, segs.length * 2); l.geometry.attributes.position.needsUpdate = true; l.visible = true;
    });
    a.max = a.life = rand(0.18, 0.55); a.seed = rand(0, 100);
    hits[hitIdx].set(start.x, start.y, start.z, 0); hitIdx = (hitIdx + 1) % HITS;
    sky.material.uniforms.flash.value = Math.max(sky.material.uniforms.flash.value, rand(0.4, 1));
    sky.material.uniforms.flashDir.value.copy(start);
    // the crackle comes from the strike's side: pan it by where it is relative to the camera
    camera.getWorldDirection(t2); const camRight = tmp.set(-t2.z, 0, t2.x).normalize();
    SFX.zap(Math.min(1, 0.6 + y), clamp(start.x * camRight.x + start.z * camRight.z, -1, 1) * 0.8);
  }
  return {
    spawn,
    update(dt, time) {
      // its own clock runs faster as the weather worsens, so the veins stream and breathe faster without jumping
      const ag = Weather.agitation; mat.uniforms.agit.value = ag; ownT += dt * (0.6 + 2.2 * ag); mat.uniforms.time.value = ownT;
      for (const h of hits) h.w += dt;
      nextArc -= dt;
      if (nextArc <= 0) { // rare under a clear sky, frequent (often in bursts) in a storm
        spawn(); if (Math.random() < 0.15 + 0.45 * ag) spawn();
        nextArc = lerp(rand(4, 11), rand(0.4, 1.8), ag);
      }
      for (const a of arcs) {
        if (a.life <= 0) continue;
        a.life -= dt;
        const f = a.life > 0 ? (0.4 + 0.6 * Math.abs(Math.sin(time * 70 + a.seed))) * Math.min(1, a.life / a.max * 3) : 0;
        a.layers.forEach((l, k) => { l.material.opacity = f * (k ? 0.35 : 1); l.visible = a.life > 0; });
      }
      const fl = sky.material.uniforms.flash;
      fl.value = Math.max(0, fl.value - dt * 5) * (0.7 + 0.3 * Math.random());
    },
  };
})();
let rebakeEnv = () => {};
// bake the sky into an environment map so every glossy surface picks up cold sky reflections
{
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene(); envScene.add(new THREE.Mesh(sky.geometry, sky.material));
  let envRT = pmrem.fromScene(envScene, 0, 0.1, 1000);
  scene.environment = envRT.texture;
  // the reflections are a picture of the sky: when it clouds over, take a new one (a few times per change of weather),
  // or wet ground in the rain would still mirror a blue sky
  rebakeEnv = () => {
    const fl = sky.material.uniforms.flash.value; sky.material.uniforms.flash.value = 0;
    const rt = pmrem.fromScene(envScene, 0, 0.1, 1000); sky.material.uniforms.flash.value = fl;
    scene.environment = rt.texture; envRT.dispose(); envRT = rt;
  };
}

const hemi = new THREE.HemisphereLight(0xcfe0ff, 0x6a5a40, 0.55);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffeccc, 2.75);
sun.position.copy(SUN_DIR).multiplyScalar(60);
sun.castShadow = true;
sun.shadow.mapSize.set(TOUCH ? 1024 : 2048, TOUCH ? 1024 : 2048);
Object.assign(sun.shadow.camera, { left: -26, right: 26, top: 26, bottom: -26, near: 1, far: 140 });
sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.03;
scene.add(sun);
const coldFill = new THREE.DirectionalLight(0x9cc0ff, 1.1); // cold back light → steely rim glints
coldFill.position.set(-35, 20, -40);
scene.add(coldFill);

// ============================================================ arena
// ---- terrain: one height function shared by rendering and gameplay (feet, blood, pebbles follow it)
// Value noise (smooth, irregular) for the ground. Sums of sines made regular ridges and stripes, read as waves.
const NOISE_P = new Uint8Array(512);
{ const p = [...Array(256).keys()]; for (let i = 255; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [p[i], p[j]] = [p[j], p[i]]; } for (let i = 0; i < 512; i++) NOISE_P[i] = p[i & 255]; }
function noise2(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi, X = xi & 255, Y = yi & 255;
  const v = (a, b) => NOISE_P[NOISE_P[a] + b] / 255;
  const u = xf * xf * (3 - 2 * xf), w = yf * yf * (3 - 2 * yf);
  return lerp(lerp(v(X, Y), v(X + 1, Y), u), lerp(v(X, Y + 1), v(X + 1, Y + 1), u), w);
}
function fbm2(x, y, oct = 3) { let s = 0, a = 0.5, n = 0; for (let i = 0; i < oct; i++) { s += a * noise2(x, y); n += a; x = x * 2.03 + 17.1; y = y * 2.03 - 9.7; a *= 0.5; } return s / n; }
function groundH(x, z) {
  const r = Math.hypot(x, z);
  const h = (fbm2(x * 0.32 + 50, z * 0.32 + 50, 3) - 0.5) * 0.16; // gentle, uneven bumps and hollows
  if (r < 19.5) return h + Math.max(0, r - 15.5) ** 2 * 0.03; // earth banked up against the stockade
  const far = clamp((r - 58) / 40, 0, 1); // the town stays gentle, hills roll beyond the city wall
  return h * 3 + (fbm2(x * 0.06 + 3, z * 0.06 - 8, 2) - 0.5) * 0.5
    + far * (2.0 * Math.sin(x * 0.031 + 0.7) * Math.cos(z * 0.027 - 1.1) + 1.3 * Math.sin(x * 0.067 - z * 0.052) + 2.2);
}
// generated albedo + normal map pair from one tileable height field
function groundMaps(size, o) {
  const hc = document.createElement('canvas'); hc.width = hc.height = size;
  const g = hc.getContext('2d');
  g.fillStyle = '#808080'; g.fillRect(0, 0, size, size);
  const k = size / 512;
  const wrap = fn => { for (const ox of [-size, 0, size]) for (const oy of [-size, 0, size]) fn(ox, oy); };
  for (let i = 0; i < o.blobs; i++) {
    const x = rand(0, size), y = rand(0, size), r = rand(o.blobR[0], o.blobR[1]) * k, v = Math.random() < 0.5 ? 255 : 0, a = rand(0.08, 0.22);
    wrap((ox, oy) => {
      const gr = g.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
      gr.addColorStop(0, `rgba(${v},${v},${v},${a})`); gr.addColorStop(1, `rgba(${v},${v},${v},0)`);
      g.fillStyle = gr; g.fillRect(x + ox - r, y + oy - r, r * 2, r * 2);
    });
  }
  for (let i = 0; i < (o.ripples || 0); i++) { // shallow ripples in the sand
    const y0 = rand(0, size), ph = rand(0, 6);
    g.strokeStyle = `rgba(255,255,255,${rand(0.04, 0.1)})`; g.lineWidth = rand(2, 5) * k;
    g.beginPath(); for (let x = 0; x <= size; x += 8) g.lineTo(x, y0 + Math.sin((x / size) * Math.PI * 2 * 3 + ph) * 14 * k); g.stroke();
  }
  for (let i = 0; i < o.stones; i++) {
    const x = rand(0, size), y = rand(0, size), rx = rand(1.5, 5) * k, ry = rx * rand(0.5, 1), rot = rand(0, 3), a = rand(0.5, 0.8);
    wrap((ox, oy) => {
      g.fillStyle = 'rgba(0,0,0,.35)'; g.beginPath(); g.ellipse(x + ox + 1, y + oy + 1, rx * 1.25, ry * 1.25, rot, 0, 7); g.fill();
      g.fillStyle = `rgba(255,255,255,${a})`; g.beginPath(); g.ellipse(x + ox, y + oy, rx, ry, rot, 0, 7); g.fill();
    });
  }
  const grains = o.grains * (size * size) / 262144;
  for (let i = 0; i < grains; i++) {
    const v = Math.random() < 0.5 ? 255 : 0;
    g.fillStyle = `rgba(${v},${v},${v},${rand(0.1, 0.35)})`;
    if (o.blades) g.fillRect(rand(0, size), rand(0, size), 1, rand(2, 6) * k); else g.fillRect(rand(0, size), rand(0, size), rand(1, 2), rand(1, 2));
  }
  const H = g.getImageData(0, 0, size, size).data;
  const cc = document.createElement('canvas'), nc = document.createElement('canvas');
  cc.width = cc.height = nc.width = nc.height = size;
  const cimg = cc.getContext('2d').createImageData(size, size), nimg = nc.getContext('2d').createImageData(size, size);
  const h = (x, y) => H[((((y % size) + size) % size) * size + (((x % size) + size) % size)) * 4] / 255;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4, t = clamp((h(x, y) - 0.5) * o.contrast + 0.5, 0, 1), n = Math.random() * 0.06 - 0.03;
    for (let c = 0; c < 3; c++) cimg.data[i + c] = clamp(lerp(o.dark[c], o.light[c], t) * (1 + n), 0, 255);
    cimg.data[i + 3] = 255;
    let nx = -(h(x + 1, y) - h(x - 1, y)) * o.strength, ny = (h(x, y + 1) - h(x, y - 1)) * o.strength, nz = 1;
    const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
    nimg.data[i] = (nx * 0.5 + 0.5) * 255; nimg.data[i + 1] = (ny * 0.5 + 0.5) * 255; nimg.data[i + 2] = (nz * 0.5 + 0.5) * 255; nimg.data[i + 3] = 255;
  }
  cc.getContext('2d').putImageData(cimg, 0, 0); nc.getContext('2d').putImageData(nimg, 0, 0);
  const mk = (c, srgb) => {
    const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(o.repeat, o.repeat); t.anisotropy = 8;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace; return t;
  };
  return { map: mk(cc, true), normalMap: mk(nc, false) };
}
// displace a flat ring onto the terrain and bake large-scale colour variation into vertex colours
function terrainMesh(geo, maps, tint) {
  geo.rotateX(-Math.PI / 2);
  const p = geo.attributes.position, col = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i);
    p.setY(i, groundH(x, z));
    const c = tint(x, z);
    col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2];
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.computeVertexNormals();
  const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: maps.map, normalMap: maps.normalMap, normalScale: new THREE.Vector2(1.2, 1.2), vertexColors: true, roughness: 0.95 }));
  m.receiveShadow = true; scene.add(m); return m;
}
// large-scale variation across the ground (irregular patches, no stripes): roughly 0..1
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const macro = (x, z, s) => clamp((fbm2(x * 0.2 * s + 7.3, z * 0.2 * s - 3.1, 3) - 0.5) * 2.1 + 0.5, 0, 1);
// The arena floor: grey-brown packed earth, not yellow sand. Over it lie patches of grey gravel, worn tracks (a ring
// trodden round the middle by fighters circling each other, and a path in from the gate), and soggy, mossy green patches
// where grass still clings on, mostly out of the way near the stockade. One function, so the grass tufts can find them.
function arenaPatches(x, z) {
  const r = Math.hypot(x, z), a = Math.atan2(x, z);
  const gravel = clamp((macro(x * 0.9 + 31, z * 0.9 - 7, 1.1) - 0.6) * 3.2, 0, 1);
  const green = clamp((macro(x * 0.55 - 19, z * 0.55 + 23, 0.9) - 0.6) * 3.4, 0, 1) * clamp((r - 6) / 6, 0, 1);
  const ring = Math.exp(-((r - 10.5 + 0.7 * Math.sin(a * 3 + 1) + 0.4 * Math.sin(a * 7)) ** 2) / 1.6);
  const path = z < 0 ? Math.exp(-((x + 0.9 * Math.sin(z * 0.35)) ** 2) / 1.2) * clamp((-z - 2) / 4, 0, 1) : 0;
  return { gravel, green: green * (1 - Math.max(ring, path)), track: Math.max(ring, path) };
}
const sandMaps = groundMaps(1024, { blobs: 260, blobR: [6, 46], ripples: 0, stones: 160, grains: 9000, strength: 3.2, contrast: 1.45, dark: [64, 59, 52], light: [134, 126, 114], repeat: 7 });
const sandFloor = terrainMesh(new THREE.RingGeometry(0.001, 19.4, 150, 56), sandMaps, (x, z) => {
  const m = macro(x, z, 1), r = Math.hypot(x, z), P0 = arenaPatches(x, z);
  const mud = clamp((macro(x * 1.7 + 11, z * 1.7 - 4, 1.3) - 0.58) * 3.2, 0, 1) * 0.45;  // churned, darker mud
  const grime = clamp((r - 12.5) / 4, 0, 1) * 0.2 + smoothstep(16.6, 18.3, r) * 0.22;      // trodden filth and mud along the wall (the same dirt that creeps up it)
  const v = (0.76 + m * 0.26) * (1 - mud - grime) * (1 - P0.track * 0.22);               // tracks: packed down, darker
  let c = [v * 0.98, v * 0.95, v * 0.9];                                                 // grey-brown earth
  const gr = P0.gravel * 0.75; c = c.map((k, i) => lerp(k, v * [0.92, 0.92, 0.93][i] * 1.08, gr)); // grey gravel
  const gn = P0.green * 0.85; c = c.map((k, i) => lerp(k, v * [0.46, 0.54, 0.32][i], gn));       // muddy green
  return c;
});
sandFloor.material.envMapIntensity = 0.45; // dull earth: the cold sky shouldn't sheen across it
// Wet ground (rain): wetness isn't even. Two octaves of world-space noise make a wetness mask; as the ground soaks, the
// hollows go first (dark and glossy, almost like standing water) while bumps stay damp and matte, and the wet area
// grows the longer it rains. `uWet` is the weather's soak level (0 dry .. 1 soaked).
const groundWet = { value: 0 };
function wetGround(mat, scale = 1, persist = 0) {
  mat.onBeforeCompile = sh => {
    sh.uniforms.uWet = groundWet; sh.uniforms.uNoiseW = { value: noiseTex };
    sh.vertexShader = 'varying vec3 vWetPos;\n' + sh.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\n  vWetPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = 'uniform float uWet; uniform sampler2D uNoiseW; varying vec3 vWetPos;\n' + sh.fragmentShader
      .replace('#include <color_fragment>', `#include <color_fragment>
        float wn = texture2D(uNoiseW, vWetPos.xz * ${(0.0016 * scale).toFixed(5)}).g * 0.62 + texture2D(uNoiseW, vWetPos.xz * ${(0.0062 * scale).toFixed(5)} + 0.37).g * 0.38;
        float wetM = smoothstep(0.74 - 0.36 * uWet, 0.86 - 0.34 * uWet, wn) * smoothstep(0.02, 0.25, uWet);
        wetM = max(wetM, smoothstep(0.8, 0.88, wn) * ${persist.toFixed(2)});  // the deepest hollows never quite dry out
        diffuseColor.rgb *= 1.0 - 0.14 * uWet - 0.3 * wetM;`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor * (1.0 - 0.12 * uWet), 0.14, wetM);`);
  };
}
wetGround(sandFloor.material, 1, 0.8);
const grassMaps = groundMaps(512, { blobs: 220, blobR: [6, 50], stones: 30, grains: 22000, blades: true, strength: 2.4, contrast: 1.4, dark: [36, 46, 22], light: [92, 104, 56], repeat: 70 });
const grassFloor = terrainMesh(new THREE.RingGeometry(19.0, 260, 120, 60), grassMaps, (x, z) => {
  const m = macro(x, z, 0.35), d = macro(x + 40, z - 17, 0.9), r = Math.hypot(x, z);
  const worn = Math.exp(-((r - 22) ** 2) / 8) * 0.5 + (Math.abs(x) < 4 && z < -18 ? 0.5 : 0); // trampled ring + road edge
  const dry = clamp(d * 0.6 + worn, 0, 1), b = 0.85 + m * 0.3;
  return [lerp(0.8, 1.25, dry) * b, lerp(1, 0.92, dry) * b, 0.83 * b];
});
wetGround(grassFloor.material, 0.6);
// loose pebbles on the sand
{
  const n = TOUCH ? 90 : 170, peb = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(1, 0), std(0xffffff, 0.75, 0, { envMapIntensity: 0.5 }), n);
  const d = new THREE.Object3D(), c = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const a = rand(0, 6.28), r = Math.sqrt(Math.random()) * 17.8, x = Math.sin(a) * r, z = Math.cos(a) * r, s = rand(0.03, 0.085);
    d.position.set(x, groundH(x, z) + s * 0.1, z); d.rotation.set(rand(0, 3), rand(0, 3), rand(0, 3)); d.scale.set(s, s * rand(0.4, 0.7), s * rand(0.7, 1.1));
    d.updateMatrix(); peb.setMatrixAt(i, d.matrix);
    const v = rand(0.28, 0.5); peb.setColorAt(i, c.setRGB(v * 0.95, v * 0.85, v * 0.7));
  }
  peb.receiveShadow = true; scene.add(peb); // too small to need a shadow of their own
}
// grass tufts around the outside of the stockade: each tuft is a clump of thin, curved, tapering blades (dark at the
// root, sun-bleached at the tip) that sway in the wind. The sway is done in the vertex shader, so it costs nothing on
// the CPU; the tufts skip the depth pre-pass, since the pre-pass would draw them unswayed.
const grassWind = { value: 0 };
{
  const BLADES = 7, SEG = 2, pos = [], col = [], nor = [], idx = [];
  for (let b = 0; b < BLADES; b++) {
    const th = rand(0, 6.28), lean = rand(0.25, 0.9), h = rand(0.22, 0.58), w = rand(0.018, 0.03);
    const r0 = rand(0, 0.07), ox = Math.cos(th) * r0, oz = Math.sin(th) * r0;
    const dx = Math.cos(th), dz = Math.sin(th), px = -dz, pz = dx; // lean direction, and across the blade
    const tipTone = rand(0.85, 1.15), dry = Math.random() < 0.25;
    const base = pos.length / 3;
    for (let s = 0; s <= SEG; s++) {
      const t = s / SEG, y = h * t * (1 - 0.18 * t * lean), out = lean * h * t * t * 0.8, ww = w * (1 - t) + 0.002;
      for (const side of [-1, 1]) {
        pos.push(ox + dx * out + px * ww * side, y, oz + dz * out + pz * ww * side);
        const k = (0.35 + 0.65 * t) * tipTone; // dark at the root, light at the tip
        col.push(k * (dry ? 1.25 : 1), k * (dry ? 1.1 : 1), k * (dry ? 0.7 : 1));
        const n = new V3(dx * 0.35, 1, dz * 0.35).normalize(); // lit like the ground it grows from, not like a card
        nor.push(n.x, n.y, n.z);
      }
      if (s < SEG) { const a = base + s * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setIndex(idx);
  const mat = std(0xffffff, 0.88, 0, { vertexColors: true, side: THREE.DoubleSide, envMapIntensity: 0.35 });
  mat.userData.noPrepass = true;
  mat.onBeforeCompile = sh => {
    sh.uniforms.uWind = grassWind;
    sh.vertexShader = 'uniform float uWind;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      vec4 gw = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
      float gust = 0.6 + 0.4 * sin(uWind * 0.37 + gw.x * 0.05 + gw.z * 0.04);
      float sway = (sin(uWind * 1.9 + gw.x * 0.45 + gw.z * 0.31) * 0.6 + sin(uWind * 3.7 + gw.z * 0.8) * 0.25) * gust;
      float bend = transformed.y * transformed.y * 0.9;
      transformed.x += sway * bend; transformed.z += sway * bend * 0.5; transformed.y -= abs(sway) * bend * 0.15;`);
  };
  const n = TOUCH ? 450 : 900, tuft = new THREE.InstancedMesh(geo, mat, n);
  const d = new THREE.Object3D(), c = new THREE.Color();
  for (let i = 0; i < n; i++) {
    // thicker against the stockade, thinning out into the town
    const a = rand(0, 6.28), r = 19.6 + Math.pow(Math.random(), 1.8) * 24, x = Math.sin(a) * r, z = Math.cos(a) * r, s = rand(0.7, 1.5);
    d.position.set(x, groundH(x, z) - 0.01, z); d.rotation.set(rand(-0.08, 0.08), rand(0, 6.28), rand(-0.08, 0.08)); d.scale.set(s, s * rand(0.8, 1.2), s);
    d.updateMatrix(); tuft.setMatrixAt(i, d.matrix); tuft.setColorAt(i, c.setHSL(rand(0.16, 0.24), rand(0.3, 0.5), rand(0.2, 0.32)));
  }
  tuft.receiveShadow = true; scene.add(tuft);
  // sparse, short, darker tufts in the muddy green patches on the arena floor
  const spots = [];
  for (let i = 0; i < 6000 && spots.length < (TOUCH ? 90 : 170); i++) {
    const a = rand(0, 6.28), r = Math.sqrt(Math.random()) * 17.6, x = Math.sin(a) * r, z = Math.cos(a) * r;
    if (Math.random() < arenaPatches(x, z).green * 0.9) spots.push([x, z]);
  }
  const inner = new THREE.InstancedMesh(geo, mat, spots.length);
  spots.forEach(([x, z], i) => {
    const s = rand(0.35, 0.75);
    d.position.set(x, groundH(x, z) - 0.005, z); d.rotation.set(0, rand(0, 6.28), 0); d.scale.set(s, s * rand(0.6, 1), s);
    d.updateMatrix(); inner.setMatrixAt(i, d.matrix); inner.setColorAt(i, c.setHSL(rand(0.17, 0.23), rand(0.25, 0.4), rand(0.14, 0.22)));
  });
  inner.receiveShadow = true; scene.add(inner);
}

// ---- weathering: soot streaks from the top, damp creeping up from the bottom, blotches and grit
function weather(g, s, o = {}) {
  const tint = o.tint || '22,16,10';
  for (let i = 0; i < (o.streaks ?? 30); i++) {
    const x = rand(0, s), w = rand(2, 9), l = rand(s * 0.1, s * (o.streakLen ?? 0.6));
    const gr = g.createLinearGradient(0, 0, 0, l);
    gr.addColorStop(0, `rgba(${tint},${rand(0.06, o.streakA ?? 0.22)})`); gr.addColorStop(1, `rgba(${tint},0)`);
    g.fillStyle = gr; g.fillRect(x, 0, w, l);
  }
  if (o.damp !== 0) {
    const b = g.createLinearGradient(0, s * (1 - (o.damp ?? 0.3)), 0, s);
    b.addColorStop(0, `rgba(${tint},0)`); b.addColorStop(1, `rgba(${tint},${o.dampA ?? 0.4})`);
    g.fillStyle = b; g.fillRect(0, 0, s, s);
  }
  for (let i = 0; i < (o.blotches ?? 20); i++) {
    const x = rand(0, s), y = rand(0, s), r = rand(6, 30) * s / 256;
    const c = Math.random() < (o.moss ?? 0) ? '48,58,24' : Math.random() < 0.5 ? tint : '70,52,30';
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, `rgba(${c},${rand(0.1, 0.3)})`); gr.addColorStop(1, `rgba(${c},0)`);
    g.fillStyle = gr; g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  for (let i = 0; i < (o.grit ?? 2500) * s * s / 65536; i++) {
    g.fillStyle = `rgba(${Math.random() < 0.6 ? '0,0,0' : '255,240,220'},${rand(0.03, 0.12)})`;
    g.fillRect(rand(0, s), rand(0, s), rand(1, 2.5), rand(1, 2.5));
  }
}
// a canvas colour map that doubles as its own bump map — dark seams and cracks read as recessed
// the faint, cold specular tint that stone, slate and wet surfaces glint with in the sun
const COLD_SPEC = new THREE.Color(0xbcd2ff);
const STONE_SPEC = new THREE.Color(0xdfe5ec); // only a hint of cold in dry stone's sheen; a blue cast reads as plastic
function surfMat(tex, rough = 0.92, bump = 2, metal = 0, extra = {}) {
  return std(0xffffff, rough, metal, { map: tex, bumpMap: tex, bumpScale: bump, ...extra });
}

const woodTex = canvasTex(256, (g, s) => {
  g.fillStyle = '#3a2a1c'; g.fillRect(0, 0, s, s);
  for (let i = 0; i < 420; i++) {
    const x = Math.random() * s;
    g.strokeStyle = Math.random() < 0.6 ? `rgba(12,7,3,${rand(.1, .35)})` : `rgba(120,112,98,${rand(.04, .16)})`; // dark grain, sun-silvered grain
    g.lineWidth = rand(0.5, 3);
    g.beginPath(); g.moveTo(x, 0); g.bezierCurveTo(x + rand(-6, 6), s * 0.33, x + rand(-6, 6), s * 0.66, x + rand(-4, 4), s); g.stroke();
  }
  for (let i = 0; i < 10; i++) { // knots
    const x = Math.random() * s, y = Math.random() * s;
    g.fillStyle = 'rgba(14,8,3,.6)'; g.beginPath(); g.ellipse(x, y, rand(3, 6), rand(6, 12), 0, 0, 7); g.fill();
  }
  for (let i = 0; i < 14; i++) { const x = rand(0, s), y = rand(0, s); g.fillStyle = 'rgba(5,3,1,.7)'; g.fillRect(x, y, 1.5, rand(15, 60)); } // splits
  weather(g, s, { streaks: 14, damp: 0.35, dampA: 0.5, blotches: 14, moss: 0.3, grit: 1500 });
});
const logMat = surfMat(woodTex, 0.95, 2.5);
// Where a wall meets the ground (the palisade, stone, plank walls): environmental blending instead of a hard seam. In
// the material's own shader, the arena's earth creeps up the bottom of the wall with a ragged, noisy edge (mud
// splashed and trodden against it), the surface turns matte there, and the normals bend toward the ground's normal, so
// the base of the wall takes the light like the floor does and the lighting break between them disappears. Real-time,
// so it works with the moving sun and costs a couple of texture reads.
function groundBlend(mat, base = 0.12, height = 0.85) {
  mat.onBeforeCompile = sh => {
    sh.uniforms.uGbNoise = { value: noiseTex };
    sh.vertexShader = 'varying vec3 vGbPos;\n' + sh.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
      #ifdef USE_INSTANCING
        vGbPos = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
      #else
        vGbPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
      #endif`);
    sh.fragmentShader = 'uniform sampler2D uGbNoise; varying vec3 vGbPos;\n' + sh.fragmentShader
      .replace('#include <color_fragment>', `#include <color_fragment>
        float gbJ = texture2D(uGbNoise, vGbPos.xz * 0.9 + vGbPos.y * 0.15).g * 0.6 + texture2D(uGbNoise, vGbPos.xz * 3.1).g * 0.4;
        float gb = 1.0 - smoothstep(0.0, 1.0, (vGbPos.y - ${base.toFixed(2)}) / ${height.toFixed(2)} + (gbJ - 0.5) * 0.7);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.075, 0.06, 0.045) * (0.75 + 0.5 * gbJ), gb * 0.85); // dark, wet mud`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 1.0, gb);`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        normal = normalize(mix(normal, normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz), gb * 0.22));`);
  };
  mat.customProgramCacheKey = () => 'gb' + base + height;
  return mat;
}
groundBlend(logMat);
const darkWood = surfMat(woodTex, 0.93, 2.5, 0, { color: 0x8a7a6a });

// rough, pitted rust for every bit of old iron
const rustTex = canvasTex(128, (g, s) => {
  g.fillStyle = '#3a2216'; g.fillRect(0, 0, s, s);
  const cols = ['122,58,26', '92,44,20', '140,80,36', '38,26,20', '90,70,56', '60,30,16'];
  for (let i = 0; i < 500; i++) {
    const x = rand(0, s), y = rand(0, s), r = rand(1, 9);
    const gr = g.createRadialGradient(x, y, 0, x, y, r), c = cols[(Math.random() * cols.length) | 0];
    gr.addColorStop(0, `rgba(${c},${rand(0.3, 0.8)})`); gr.addColorStop(1, `rgba(${c},0)`);
    g.fillStyle = gr; g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  for (let i = 0; i < 900; i++) { g.fillStyle = `rgba(10,6,4,${rand(.2, .6)})`; g.fillRect(rand(0, s), rand(0, s), rand(0.8, 2), rand(0.8, 2)); } // pits
});
const rustM = surfMat(rustTex, 0.88, 3, 0.3);

// ---- texture-set helpers: a height field becomes a normal map; a grey canvas becomes a roughness map
function heightToNormal(H, size, strength) {
  const nc = document.createElement('canvas'); nc.width = nc.height = size;
  const img = nc.getContext('2d').createImageData(size, size), d = img.data;
  const h = (x, y) => H[((((y % size) + size) % size) * size + (((x % size) + size) % size)) * 4] / 255;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let nx = -(h(x + 1, y) - h(x - 1, y)) * strength, ny = (h(x, y + 1) - h(x, y - 1)) * strength, nz = 1;
    const l = Math.hypot(nx, ny, nz), i = (y * size + x) * 4;
    d[i] = (nx / l * 0.5 + 0.5) * 255; d[i + 1] = (ny / l * 0.5 + 0.5) * 255; d[i + 2] = (nz / l * 0.5 + 0.5) * 255; d[i + 3] = 255;
  }
  nc.getContext('2d').putImageData(img, 0, 0); return nc;
}
function dataTex(canvas, like) {
  const t = new THREE.CanvasTexture(canvas); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8;
  if (like) t.repeat.copy(like.repeat); return t;
}
// For a tiled colour texture (roof tiles): luminance stands in for height, dark gaps are matte,
// the faces of the tiles get a varied, slightly glossy finish.
function deriveMaps(tex, faceRough, strength = 6) {
  const src = tex.image, size = src.width, C = src.getContext('2d').getImageData(0, 0, size, size).data;
  const hc = document.createElement('canvas'), rc = document.createElement('canvas'); hc.width = hc.height = rc.width = rc.height = size;
  const hi = hc.getContext('2d').createImageData(size, size), ri = rc.getContext('2d').createImageData(size, size);
  for (let i = 0; i < C.length; i += 4) {
    const lum = (C[i] * 0.3 + C[i + 1] * 0.59 + C[i + 2] * 0.11) / 255;
    hi.data[i] = hi.data[i + 1] = hi.data[i + 2] = Math.min(255, lum * 600); hi.data[i + 3] = 255;
    const r = lum < 0.07 ? 0.97 : clamp(faceRough + (0.2 - lum) * 0.9 + (Math.random() - 0.5) * 0.1 + (C[i + 1] > C[i] + 4 ? 0.25 : 0), 0.15, 1);
    ri.data[i] = ri.data[i + 1] = ri.data[i + 2] = r * 255; ri.data[i + 3] = 255;
  }
  hc.getContext('2d').putImageData(hi, 0, 0); rc.getContext('2d').putImageData(ri, 0, 0);
  const g = hc.getContext('2d'); g.filter = 'blur(1px)'; g.drawImage(hc, 0, 0); g.filter = 'none';
  return { normalMap: dataTex(heightToNormal(g.getImageData(0, 0, size, size).data, size, strength), tex), roughnessMap: dataTex(rc, tex) };
}

// dark, mossy, soot-streaked masonry — shared by the arena wall and the town.
// Built as a matched set: colour, a height field (→ normal map: sunken mortar, bevelled block edges, chips)
// and a roughness map (dead-matte mortar, each block its own sheen, slick wet streaks, matte moss).
const stoneMaps = (() => {
  const s = 512, rows = 8, rh = s / rows;
  const mk = () => { const c = document.createElement('canvas'); c.width = c.height = s; return [c, c.getContext('2d')]; };
  const [cc, g] = mk(), [hc, hg] = mk(), [rc, rg] = mk();
  g.fillStyle = '#24211d'; g.fillRect(0, 0, s, s);
  hg.fillStyle = 'rgb(30,30,30)'; hg.fillRect(0, 0, s, s);
  rg.fillStyle = 'rgb(248,248,248)'; rg.fillRect(0, 0, s, s);
  for (let r = 0; r < rows; r++) {
    const ws = []; let tot = 0; while (tot < s - 40) { const w = rand(48, 92); ws.push(w); tot += w; }
    const k = s / tot, off = rand(0, s); let x = 0;
    for (const w0 of ws) {
      const w = w0 * k, y = r * rh;
      const v = rand(50, 82) | 0, warm = rand(0, 10) | 0, hv = rand(160, 215) | 0, rv = rand(0.42, 0.78);
      for (const ox of [0, -s]) {
        const X = ((x + off) % s) + ox;
        g.fillStyle = `rgb(${v + warm + 4},${v},${v - 10 - warm})`; g.fillRect(X + 3, y + 3, w - 5, rh - 5);
        const gr = g.createLinearGradient(0, y, 0, y + rh); gr.addColorStop(0, 'rgba(255,245,230,.08)'); gr.addColorStop(1, 'rgba(0,0,0,.28)');
        g.fillStyle = gr; g.fillRect(X + 3, y + 3, w - 5, rh - 5);
        // height: a raised face with softened, bevelled arrises
        hg.fillStyle = `rgb(${hv * 0.7 | 0},${hv * 0.7 | 0},${hv * 0.7 | 0})`; hg.fillRect(X + 3, y + 3, w - 5, rh - 5);
        hg.fillStyle = `rgb(${hv},${hv},${hv})`; hg.fillRect(X + 7, y + 7, w - 13, rh - 13);
        rg.fillStyle = `rgb(${rv * 255 | 0},${rv * 255 | 0},${rv * 255 | 0})`; rg.fillRect(X + 3, y + 3, w - 5, rh - 5);
        for (let c = 0; c < 4; c++) { // chipped edges: dark in colour, sunken in height, rough
          const cx = X + rand(6, w - 6), cy = y + (Math.random() < 0.5 ? rand(3, 8) : rh - rand(3, 8)), cr = rand(2, 6);
          g.fillStyle = 'rgba(20,18,15,.45)'; g.beginPath(); g.arc(cx, cy, cr, 0, 7); g.fill();
          hg.fillStyle = 'rgba(40,40,40,.85)'; hg.beginPath(); hg.arc(cx, cy, cr, 0, 7); hg.fill();
          rg.fillStyle = 'rgba(240,240,240,.9)'; rg.beginPath(); rg.arc(cx, cy, cr, 0, 7); rg.fill();
        }
        for (let c = 0; c < 18; c++) { // pitting and tool marks on the faces
          const px = X + rand(6, w - 6), py = y + rand(6, rh - 6), pr = rand(0.8, 2.5), dv = rand(-35, 25);
          hg.fillStyle = `rgba(${dv < 0 ? '0,0,0' : '255,255,255'},${Math.abs(dv) / 100})`; hg.beginPath(); hg.arc(px, py, pr, 0, 7); hg.fill();
        }
      }
      x += w;
    }
  }
  weather(g, s, { streaks: 34, streakA: 0.3, damp: 0.4, dampA: 0.45, blotches: 46, moss: 0.55, grit: 3000 });
  hg.filter = 'blur(1.2px)'; hg.drawImage(hc, 0, 0); hg.filter = 'none';
  // roughness follows the weathering: dark, wet streaks are slick, moss and grime are matte
  const C = g.getImageData(0, 0, s, s).data, R = rg.getImageData(0, 0, s, s), Hd = hg.getImageData(0, 0, s, s).data;
  for (let i = 0; i < C.length; i += 4) {
    if (Hd[i] < 60) continue; // mortar stays dead matte
    const lum = (C[i] * 0.3 + C[i + 1] * 0.59 + C[i + 2] * 0.11) / 255, moss = C[i + 1] > C[i] + 3 ? 0.3 : 0;
    const r = clamp(R.data[i] / 255 - (0.26 - lum) * 1.4 + moss + (Math.random() - 0.5) * 0.08, 0.34, 1) * 255; // damp, not glassy
    R.data[i] = R.data[i + 1] = R.data[i + 2] = r;
  }
  rg.putImageData(R, 0, 0);
  const map = dataTex(cc); map.colorSpace = THREE.SRGBColorSpace;
  return { map, normalMap: dataTex(heightToNormal(Hd, s, 7)), roughnessMap: dataTex(rc) };
})();
// (MeshStandard, not Physical: stone and roofs cover much of the screen, and the physical shader's specular tint was
// barely visible after the reflection pass; dimmer reflections stand in for the lower specular intensity)
const stoneM = std(0xffffff, 1, 0, { ...stoneMaps, normalScale: new THREE.Vector2(1.3, 1.3), envMapIntensity: 0.32 });
stoneM.userData.world = 3.5;
groundBlend(stoneM, 0.1, 0.7);

// worn steel: brushed grain, fine bright scratches, dull smudges and pits — a roughness texture so reflections
// on the hero's armour break up across the surface instead of sliding over it like a mirror
const metalRough = (() => {
  const s = 256, c = document.createElement('canvas'); c.width = c.height = s; const g = c.getContext('2d');
  g.fillStyle = 'rgb(115,115,115)'; g.fillRect(0, 0, s, s);
  for (let i = 0; i < 260; i++) { const y = rand(0, s), v = Math.random() < 0.5 ? '0,0,0' : '255,255,255'; g.fillStyle = `rgba(${v},${rand(0.03, 0.09)})`; g.fillRect(0, y, s, rand(0.5, 1.5)); } // brushing
  for (let i = 0; i < 40; i++) { // smudges and handling marks: rougher
    const x = rand(0, s), y = rand(0, s), r = rand(8, 34), gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, `rgba(255,255,255,${rand(0.1, 0.3)})`); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  for (let i = 0; i < 90; i++) { // scratches: burnished, so smoother
    g.strokeStyle = `rgba(0,0,0,${rand(0.25, 0.6)})`; g.lineWidth = rand(0.5, 1.2);
    const x = rand(0, s), y = rand(0, s), a = rand(0, Math.PI), l = rand(10, 60);
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke();
  }
  for (let i = 0; i < 500; i++) { g.fillStyle = `rgba(255,255,255,${rand(0.2, 0.5)})`; g.fillRect(rand(0, s), rand(0, s), rand(1, 2.2), rand(1, 2.2)); } // pits
  return dataTex(c);
})();

// ---- a used arena floor: puddles in the hollows, old stains, arrows stuck in the sand and the palisade, straw
{
  const blot = (col, n, soft) => { // irregular, soft-edged splotch with alpha
    const s = 256, c = document.createElement('canvas'); c.width = c.height = s; const g = c.getContext('2d');
    for (let i = 0; i < n; i++) {
      const a = rand(0, 6.28), d = Math.pow(Math.random(), 0.7) * s * 0.3, x = s / 2 + Math.cos(a) * d, y = s / 2 + Math.sin(a) * d, r = rand(10, 46) * (1 - d / (s * 0.5));
      const gr = g.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, `rgba(${col},${rand(0.25, 0.55)})`); gr.addColorStop(soft, `rgba(${col},${rand(0.1, 0.3)})`); gr.addColorStop(1, `rgba(${col},0)`);
      g.fillStyle = gr; g.fillRect(x - r, y - r, r * 2, r * 2);
    }
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  };
  const drape = (x, z, R, lift) => { // a ground-hugging disc
    const geo = new THREE.RingGeometry(0, R, 40, 8); geo.rotateX(-Math.PI / 2);
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) p.setY(i, groundH(x + p.getX(i), z + p.getZ(i)) + lift);
    geo.computeVertexNormals(); return geo;
  };
  const layers = new Map(); // stains sharing a texture are merged into a single mesh
  const decal = (geo, tex, rough, x, z, order) => {
    const uv = geo.attributes.uv, q = rand(0, 6.28), cs = Math.cos(q), sn = Math.sin(q); // spin the stain, not the draped disc
    for (let i = 0; i < uv.count; i++) { const u = uv.getX(i) - 0.5, v = uv.getY(i) - 0.5; uv.setXY(i, 0.5 + u * cs - v * sn, 0.5 + u * sn + v * cs); }
    geo.translate(x, 0, z);
    if (!layers.has(tex)) layers.set(tex, { rough, order, geos: [] });
    layers.get(tex).geos.push(geo);
  };
  const flushDecals = () => {
    for (const [tex, { rough, order, geos }] of layers) {
      const m = new THREE.Mesh(mergeGeometries(geos), std(0xffffff, rough, 0, { map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 - order, polygonOffsetUnits: -1 }));
      m.receiveShadow = true; m.renderOrder = order; scene.add(m);
    }
  };
  // (the old fixed puddles are gone: standing water now comes from the same patchy wetness as the rain, see wetGround,
  // with a few deep hollows that never quite dry out)
  const mudTex = blot('38,30,20', 30, 0.5), oldBlood = blot('48,12,8', 26, 0.35);
  for (let i = 0; i < 9; i++) { const a = rand(0, 6.28), r = rand(2, 15), x = Math.sin(a) * r, z = Math.cos(a) * r; decal(drape(x, z, rand(1.2, 2.6), 0.005), mudTex, 0.85, x, z, 0); }
  for (let i = 0; i < 10; i++) { const a = rand(0, 6.28), r = rand(1, 14), x = Math.sin(a) * r, z = Math.cos(a) * r; decal(drape(x, z, rand(0.4, 1.0), 0.007), oldBlood, 0.6, x, z, 2); }
  flushDecals();

  // arrows from earlier bouts: stuck in the sand, lying broken, and buried in the palisade logs
  const arrows = new THREE.Group();
  const shaftM = surfMat(woodTex, 0.85, 1, 0, { color: 0xc0a888 }), fletchM = std(0x9a9284, 0.95, 0, { side: THREE.DoubleSide });
  const shaftG = new THREE.CylinderGeometry(0.0055, 0.0055, 1, 5), headG = new THREE.ConeGeometry(0.011, 0.055, 4), vaneG = new THREE.PlaneGeometry(0.022, 0.12);
  function arrow(tip, dir, len = 0.72, fletched = true, head = true) {
    const g = new THREE.Group(); g.position.copy(tip); g.quaternion.setFromUnitVectors(UP, dir.clone().normalize()); arrows.add(g);
    mesh(shaftG, shaftM, g, [0, -len / 2 - 0.045, 0], [0, 0, 0], [1, len - 0.09, 1]);
    if (head) mesh(headG, rustM, g, [0, -0.0275, 0]);
    if (fletched) for (let k = 0; k < 3; k++) { const q = k * 2.094; mesh(vaneG, fletchM, g, [Math.sin(q) * 0.012, -len + 0.09, Math.cos(q) * 0.012], [0, q, 0]); }
  }
  const STONE = [[0.85, 1.8], [-1.8, -0.85]];
  for (let i = 0; i < 16; i++) { // stuck in the sand, tails up
    const a = rand(0, 6.28), r = Math.sqrt(Math.random()) * 16, x = Math.sin(a) * r, z = Math.cos(a) * r;
    const dir = new V3(rand(-0.7, 0.7), -1, rand(-0.7, 0.7)).normalize(), depth = rand(0.1, 0.25);
    arrow(new V3(x, groundH(x, z), z).addScaledVector(dir, depth), dir, rand(0.6, 0.75), Math.random() < 0.8);
  }
  for (let i = 0; i < 10; i++) { // lying flat, some snapped
    const a = rand(0, 6.28), r = Math.sqrt(Math.random()) * 16.5, x = Math.sin(a) * r, z = Math.cos(a) * r, q = rand(0, 6.28);
    const broken = Math.random() < 0.45, dir = new V3(Math.cos(q), 0.03, Math.sin(q));
    arrow(new V3(x, groundH(x, z) + 0.008, z), dir, broken ? rand(0.25, 0.45) : 0.72, !broken);
    if (broken) arrow(new V3(x - Math.cos(q) * rand(0.5, 1), groundH(x, z) + 0.008, z - Math.sin(q) * rand(0.5, 1)), new V3(Math.cos(q + rand(-1, 1)), 0.03, Math.sin(q + rand(-1, 1))), rand(0.25, 0.4), true, false);
  }
  for (let i = 0; i < 12; i++) { // buried in the palisade
    const a = rand(0, 6.28);
    if (Math.abs(angWrap(a - Math.PI)) < 0.3 || STONE.some(([lo, hi]) => angWrap(a) >= lo - 0.05 && angWrap(a) <= hi + 0.05)) continue;
    const dir = new V3(Math.sin(a) + rand(-0.25, 0.25), rand(-0.25, 0.15), Math.cos(a) + rand(-0.25, 0.25)).normalize();
    arrow(new V3(Math.sin(a) * 18.42, rand(1.0, 4.0), Math.cos(a) * 18.42), dir, 0.72, true);
  }
  bakeStatic(arrows);

  // loose straw trodden into the sand, thicker near the walls and the gate
  const n = TOUCH ? 220 : 420, straw = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.012, 0.2), std(0xffffff, 0.95, 0, { side: THREE.DoubleSide }), n);
  const d = new THREE.Object3D(), c = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const a = rand(0, 6.28), r = Math.random() < 0.6 ? rand(13, 17.6) : Math.sqrt(Math.random()) * 17, x = Math.sin(a) * r, z = Math.cos(a) * r;
    d.position.set(x, groundH(x, z) + 0.006, z); d.rotation.set(-Math.PI / 2 + rand(-0.15, 0.15), 0, rand(0, 6.28)); d.scale.set(1, rand(0.6, 1.4), 1);
    d.updateMatrix(); straw.setMatrixAt(i, d.matrix); straw.setColorAt(i, c.setHSL(rand(0.09, 0.13), rand(0.3, 0.5), rand(0.25, 0.45)));
  }
  straw.receiveShadow = true; scene.add(straw);
}

(function buildWall() {
  const R = 18.6, N = 124, GATE = 0.13;
  // two arcs of the old palisade have been rebuilt in stone, and the gate is now a stone gatehouse
  const STONE_ARCS = [[0.85, 1.8], [-1.8, -0.85]];
  const inStone = a => STONE_ARCS.some(([lo, hi]) => a >= lo && a <= hi);
  const pts = [];
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    if (Math.abs(angWrap(a - Math.PI)) < GATE + 0.1 || inStone(angWrap(a))) continue;
    pts.push({ a, h: rand(4.2, 5.2) });
  }
  const masonry = new THREE.Group();
  const sbox = (w, h, d, a, r, y) => mesh(new THREE.BoxGeometry(w, h, d), stoneM, masonry, [Math.sin(a) * r, y, Math.cos(a) * r], [0, a, 0]);
  for (const [lo, hi] of STONE_ARCS) {
    const n = Math.ceil((hi - lo) / 0.06), step = (hi - lo) / n, H = 4.7, rr = R + 0.15;
    for (let i = 0; i < n; i++) {
      const a = lo + (i + 0.5) * step, len = 2 * rr * Math.sin(step / 2) + 0.05;
      sbox(len, H + 0.5, 0.9, a, rr, H / 2 - 0.25);                     // wall course, footing sunk into the sand bank
      sbox(len, 0.28, 1.1, a, rr, H + 0.14);                             // coping
      if (i % 2 === 0) sbox(len * 0.95, 0.75, 0.75, a, rr + 0.05, H + 0.62); // merlons
      if (i % 4 === 1) sbox(0.5, 1.4, 0.35, a, rr - 0.55, 0.45);         // squat inner buttress
    }
    for (const a of [lo, hi]) { sbox(1.3, 6, 1.3, a, R + 0.1, 2.6); sbox(1.5, 0.3, 1.5, a, R + 0.1, 5.7); } // piers where the logs meet the stone
  }
  // gatehouse: two square stone towers carrying a stone lintel and a rusted portcullis
  for (const s of [-1, 1]) {
    const a = Math.PI + s * (GATE + 0.05);
    sbox(1.9, 8.6, 1.9, a, R + 0.1, 3.8);
    sbox(2.2, 0.35, 2.2, a, R + 0.1, 8.2);
    for (const k of [-1, 1]) sbox(0.55, 0.8, 0.55, a + k * 0.03, R + 0.1, 8.75);
  }
  sbox(5.8, 1.3, 1.6, Math.PI, R + 0.1, 7.0);
  bakeStatic(masonry);
  const logs = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.27, 0.31, 1, 9), logMat, pts.length);
  const tips = new THREE.InstancedMesh(new THREE.ConeGeometry(0.27, 0.7, 9), logMat, pts.length);
  const d = new THREE.Object3D();
  pts.forEach((p, i) => {
    const r = R + rand(-0.06, 0.06);
    d.position.set(Math.sin(p.a) * r, p.h / 2, Math.cos(p.a) * r);
    d.rotation.set(rand(-0.03, 0.03), rand(0, 6), rand(-0.03, 0.03)); d.scale.set(1, p.h, 1);
    d.updateMatrix(); logs.setMatrixAt(i, d.matrix);
    d.position.y = p.h + 0.35; d.scale.set(1, 1, 1); d.updateMatrix(); tips.setMatrixAt(i, d.matrix);
  });
  for (const im of [logs, tips]) { im.castShadow = im.receiveShadow = true; scene.add(im); }

  // horizontal binding beams on the inside
  const beamGeo = new THREE.BoxGeometry(1, 0.2, 0.16);
  const beamList = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    const gap = angWrap(q.a - p.a);
    if (gap > 0.2 || gap < 0) continue;
    beamList.push({ a: p.a + gap / 2, len: 2 * (R - 0.35) * Math.sin(gap / 2) + 0.12 });
  }
  const beams = new THREE.InstancedMesh(beamGeo, darkWood, beamList.length * 2);
  let bi = 0;
  for (const b of beamList) for (const y of [1.25, 3.5]) {
    d.position.set(Math.sin(b.a) * (R - 0.38), y + rand(-0.04, 0.04), Math.cos(b.a) * (R - 0.38));
    d.rotation.set(0, b.a, 0); d.scale.set(b.len, 1, 1); d.updateMatrix(); beams.setMatrixAt(bi++, d.matrix);
  }
  beams.castShadow = beams.receiveShadow = true; scene.add(beams);

  // raised portcullis under the gatehouse lintel
  const fixtures = new THREE.Group();
  for (let i = -5; i <= 5; i++) mesh(new THREE.BoxGeometry(0.1, 2.0, 0.1), rustM, fixtures, [i * 0.42, 5.4, -R - 0.1]);
  for (const y of [4.65, 5.5]) mesh(new THREE.BoxGeometry(4.6, 0.1, 0.12), rustM, fixtures, [0, y, -R - 0.1]);
  for (let i = -5; i <= 5; i++) mesh(cone(0.07, 0.25, 4), rustM, fixtures, [i * 0.42, 4.3, -R - 0.1], [Math.PI, 0, 0]);
  // a dark pen beyond the gate
  const pen = mesh(new THREE.BoxGeometry(5, 6, 8), std(0x0d0806, 1), scene, [0, 3, -R - 4.4]);
  pen.material.side = THREE.BackSide;

  // two tiers of spectator stands behind the stockade
  for (let i = 0; i < 44; i++) {
    const a = (i / 44) * Math.PI * 2;
    if (Math.abs(angWrap(a - Math.PI)) < 0.4) continue;
    for (const [r, y] of STAND_TIERS) {
      mesh(new THREE.BoxGeometry(2.9, 0.22, 1.4), darkWood, fixtures, [Math.sin(a) * r, y, Math.cos(a) * r], [0, a, 0]);
      mesh(new THREE.BoxGeometry(0.18, y, 0.18), darkWood, fixtures, [Math.sin(a) * (r + 0.5), y / 2, Math.cos(a) * (r + 0.5)]);
    }
  }
  bakeStatic(fixtures);
})();

// ============================================================ the town, city wall and castle
function buildTown() {
  const tmp = new THREE.Group();
  const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
  const pick = a => a[(Math.random() * a.length) | 0];
  // the previous house's choices, so the next one along the street always looks different
  const look = { type: null, roof: null, plaster: null };
  const pickNot = (a, ...avoid) => { const ok = a.filter(x => !avoid.includes(x)); return pick(ok.length ? ok : a); };

  // ---- walls: three grubby plaster-and-timber variants, a daub gable fill, weathered boards
  const frameTex = (base, pattern) => canvasTex(256, (g, s) => {
    g.fillStyle = base; g.fillRect(0, 0, s, s);
    for (let i = 0; i < 40; i++) { g.fillStyle = `rgba(60,48,30,${rand(.04, .12)})`; g.beginPath(); g.arc(rand(0, s), rand(0, s), rand(8, 40), 0, 7); g.fill(); }
    for (let i = 0; i < 12; i++) { // hairline cracks and fallen patches showing the wattle
      g.strokeStyle = 'rgba(30,22,14,.5)'; g.lineWidth = 1; g.beginPath(); let x = rand(0, s), y = rand(0, s); g.moveTo(x, y);
      for (let k = 0; k < 5; k++) { x += rand(-10, 10); y += rand(4, 14); g.lineTo(x, y); } g.stroke();
    }
    for (let i = 0; i < 4; i++) { g.fillStyle = 'rgba(70,52,34,.55)'; g.beginPath(); g.ellipse(rand(20, s - 20), rand(30, s - 30), rand(4, 12), rand(3, 9), rand(0, 3), 0, 7); g.fill(); }
    const T = '#1f150d'; g.fillStyle = T; g.strokeStyle = T;
    g.fillRect(0, 0, s, 12); g.fillRect(0, s - 12, s, 12);
    for (const x of [0, s / 3, (2 * s) / 3, s]) g.fillRect(x - 7, 0, 14, s);
    g.lineWidth = 11; g.beginPath();
    if (pattern === 'cross') { g.moveTo(s / 3, s - 12); g.lineTo(2 * s / 3, 12); g.moveTo(s / 3, 12); g.lineTo(2 * s / 3, s - 12); }
    else if (pattern === 'brace') { for (const x of [0, 2 * s / 3]) { g.moveTo(x + 6, s * 0.7); g.lineTo(x + 40, s - 12); g.moveTo(x + s / 3 - 6, s * 0.7); g.lineTo(x + s / 3 - 40, s - 12); } }
    else { for (const x of [s / 6, s / 2, 5 * s / 6]) { g.moveTo(x, 12); g.lineTo(x, s - 12); } g.moveTo(0, s / 2); g.lineTo(s, s / 2); }
    g.stroke();
    for (const cx of [s / 6, (5 * s) / 6]) {
      const ww = (s / 3) * 0.45, wh = s * 0.38, wy = s * 0.45;
      g.fillStyle = T; g.fillRect(cx - ww / 2 - 6, wy - wh / 2 - 6, ww + 12, wh + 12);
      g.fillStyle = '#11161b'; g.fillRect(cx - ww / 2, wy - wh / 2, ww, wh);
      g.fillStyle = 'rgba(40,30,20,.6)'; g.fillRect(cx - 1, wy - wh / 2, 2, wh); g.fillRect(cx - ww / 2, wy - 1, ww, 2); // leading
      const st = g.createLinearGradient(0, wy + wh / 2, 0, wy + wh / 2 + 60); st.addColorStop(0, 'rgba(20,14,8,.45)'); st.addColorStop(1, 'rgba(20,14,8,0)');
      g.fillStyle = st; g.fillRect(cx - ww / 2, wy + wh / 2 + 6, ww, 60); // rain stain under the sill
    }
    weather(g, s, { streaks: 40, streakA: 0.3, damp: 0.35, dampA: 0.6, blotches: 30, moss: 0.25, grit: 3500 });
  });
  const plasterMs = [frameTex('#6c6250', 'cross'), frameTex('#625542', 'brace'), frameTex('#615e56', 'studs')].map(t => surfMat(t, 0.95, 1.5));
  const daubTex = canvasTex(256, (g, s) => {
    g.fillStyle = '#62584a'; g.fillRect(0, 0, s, s);
    g.fillStyle = '#1f150d'; for (const x of [s * 0.25, s * 0.5, s * 0.75]) g.fillRect(x - 6, 0, 12, s); g.fillRect(0, s * 0.55, s, 10);
    weather(g, s, { streaks: 30, damp: 0.2, dampA: 0.4, blotches: 20, grit: 2500 });
  });
  const daubM = surfMat(daubTex, 0.95, 1.5, 0, { side: THREE.DoubleSide });
  const planksTex = canvasTex(256, (g, s) => {
    let x = 0;
    while (x < s) {
      const w = rand(18, 30), v = rand(48, 72) | 0;
      g.fillStyle = `rgb(${v},${v * 0.86 | 0},${v * 0.72 | 0})`; g.fillRect(x, 0, w, s);
      for (let i = 0; i < 18; i++) { g.strokeStyle = `rgba(${Math.random() < .6 ? '10,6,3' : '120,115,100'},${rand(.08, .25)})`; g.lineWidth = rand(.5, 2); const gx = x + rand(2, w - 2); g.beginPath(); g.moveTo(gx, 0); g.lineTo(gx + rand(-3, 3), s); g.stroke(); }
      g.fillStyle = '#0d0905'; g.fillRect(x + w - 2, 0, 2, s);                        // gap between boards
      for (const y of [s * 0.2, s * 0.8]) { g.fillStyle = '#2a1a10'; g.fillRect(x + w / 2 - 2, y, 4, 4); } // nail heads, rust bleeding below
      x += w;
    }
    weather(g, s, { streaks: 20, damp: 0.4, dampA: 0.55, blotches: 18, moss: 0.4, grit: 2000 });
  });
  const planksM = groundBlend(surfMat(planksTex, 0.95, 2.5, 0, { side: THREE.DoubleSide }), 0.3, 0.7); planksM.userData.world = 3;

  // ---- roofs: four coverings, each a tile texture laid out 8 across × 8 courses so the geometry can match it
  const tileTex = (draw, under) => canvasTex(512, (g, s) => {
    g.fillStyle = under; g.fillRect(0, 0, s, s);
    const tw = s / 8, bh = s / 8;
    for (let k = 0; k < 8; k++) {
      const y = s - (k + 1) * bh, off = (k % 2) * tw / 2;
      for (let i = -1; i < 9; i++) {
        const x = i * tw + off;
        draw(g, x, y, tw, bh);
        if (x + tw > s) draw(g, x - s, y, tw, bh);
      }
      const sh = g.createLinearGradient(0, y, 0, y + bh * 0.45); // shadow cast by the butt of the course above
      sh.addColorStop(0, 'rgba(0,0,0,.65)'); sh.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = sh; g.fillRect(0, y, s, bh * 0.45);
      g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(0, y + bh - 2, s, 2);
    }
    weather(g, s, { streaks: 0, damp: 0, blotches: 40, moss: 0.6, grit: 1800 });
  });
  const clayTex = tileTex((g, x, y, w, h) => {
    const c = pick(['78,40,28', '88,46,32', '66,36,26', '56,42,34', '74,50,36', '56,52,34', '92,54,36', '46,34,28']);
    const gr = g.createLinearGradient(x, 0, x + w, 0); // curved pantile: lit crown, dark trough
    gr.addColorStop(0, `rgba(${c},1)`); gr.addColorStop(0.35, `rgb(${c.split(',').map(v => Math.min(255, +v + 16)).join(',')})`); gr.addColorStop(1, 'rgb(28,16,10)');
    g.fillStyle = gr; g.fillRect(x + 1, y, w - 2, h - 1);
    if (Math.random() < 0.3) { g.fillStyle = 'rgba(160,150,110,.35)'; for (let i = 0; i < 6; i++) g.fillRect(x + rand(0, w), y + rand(h * .4, h), rand(2, 5), rand(2, 4)); } // lichen
    if (Math.random() < 0.25) { g.fillStyle = 'rgba(18,12,8,.45)'; g.beginPath(); g.arc(x + rand(4, w - 4), y + h - 2, rand(2, 5), 0, 7); g.fill(); } // chipped edge
  }, '#160c08');
  const slateTex = tileTex((g, x, y, w, h) => {
    const v = rand(34, 56) | 0, b = Math.random() < 0.12 ? 10 : 0;
    g.fillStyle = `rgb(${v + b},${v + 2},${v + 6 - b})`; g.fillRect(x + 1.5, y, w - 3, h - 1);
    for (let i = 0; i < 4; i++) { g.strokeStyle = `rgba(255,255,255,${rand(.03, .07)})`; g.lineWidth = 1; g.beginPath(); const yy = y + rand(0, h); g.moveTo(x, yy); g.lineTo(x + w, yy + rand(-3, 3)); g.stroke(); } // cleavage
    if (Math.random() < 0.25) { g.fillStyle = 'rgba(170,165,120,.3)'; g.beginPath(); g.arc(x + rand(0, w), y + rand(h * .4, h), rand(3, 9), 0, 7); g.fill(); }
    if (Math.random() < 0.15) { g.strokeStyle = 'rgba(5,5,5,.9)'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(x + rand(5, w - 5), y + h); g.lineTo(x + rand(5, w - 5), y + h * 0.3); g.stroke(); } // crack
  }, '#0b0c0d');
  const shingleTex = tileTex((g, x, y, w, h) => {
    const v = rand(46, 70) | 0;
    g.fillStyle = `rgb(${v},${v * 0.88 | 0},${v * 0.74 | 0})`; g.fillRect(x + 1.5, y, w - 3, h - 1);
    for (let i = 0; i < 7; i++) { g.strokeStyle = `rgba(${Math.random() < .5 ? '10,6,3' : '130,125,110'},${rand(.1, .3)})`; g.lineWidth = 1; const gx = x + rand(2, w - 2); g.beginPath(); g.moveTo(gx, y); g.lineTo(gx + rand(-2, 2), y + h); g.stroke(); }
    if (Math.random() < 0.15) { g.fillStyle = 'rgba(6,4,2,.9)'; g.fillRect(x + rand(4, w - 6), y + h * 0.4, 2, h * 0.6); } // split shingle
    if (Math.random() < 0.3) { g.fillStyle = 'rgba(50,62,26,.45)'; g.beginPath(); g.arc(x + rand(0, w), y + rand(0, h), rand(4, 12), 0, 7); g.fill(); } // moss
  }, '#120c07');
  const thatchTex = tileTex((g, x, y, w, h) => {
    g.fillStyle = 'rgb(66,54,34)'; g.fillRect(x, y, w, h);
    for (let i = 0; i < 140; i++) { // straw ends, combed down the slope
      const sx = x + rand(0, w), l = rand(h * 0.4, h * 1.1), v = rand(50, 118) | 0, grey = Math.random() < 0.4;
      g.strokeStyle = grey ? `rgba(${v},${v * 0.95 | 0},${v * 0.85 | 0},.7)` : `rgba(${v + 20},${v},${v * 0.55 | 0},.75)`;
      g.lineWidth = rand(0.6, 1.4); g.beginPath(); g.moveTo(sx, y + h - l); g.lineTo(sx + rand(-4, 4), y + h + rand(-3, 3)); g.stroke();
    }
  }, '#2a2214');
  // tw/course: tile size (m); lift: how far each course's butt stands proud; jit: per-tile wobble; sag: belly between eave and ridge
  const ROOF = {
    clay:    { mat: std(0xffffff, 1, 0, { map: clayTex, ...deriveMaps(clayTex, 0.72, 5), envMapIntensity: 0.36, side: THREE.DoubleSide }), tw: 0.36, course: 0.32, lift: 0.075, jit: 0.45, sag: 0.1, ridge: 0.13 },
    slate:   { mat: std(0xffffff, 1, 0, { map: slateTex, ...deriveMaps(slateTex, 0.48, 5), envMapIntensity: 0.39, side: THREE.DoubleSide }), tw: 0.38, course: 0.26, lift: 0.04, jit: 0.5, sag: 0.07, ridge: 0.09 },
    shingle: { mat: surfMat(shingleTex, 0.95, 2, 0, { side: THREE.DoubleSide }), tw: 0.24, course: 0.24, lift: 0.045, jit: 0.6, sag: 0.12, ridge: 0.1 },
    thatch:  { mat: surfMat(thatchTex, 1, 3, 0, { side: THREE.DoubleSide }), tw: 0.5, course: 0.42, lift: 0.13, jit: 0.3, sag: 0.18, ridge: 0.3, bulge: true },
  };
  const slateM = ROOF.slate.mat;

  // Lay courses of individual tiles over one or more roof planes. Each plane: eave centre O, unit X along the eave,
  // unit S up the slope, outward normal Nv, width W, slope length L. Each course steps proud of the one below it.
  function courses(R, planes) {
    const P = [], UV = [], I = [], sagA = R.sag * rand(0.3, 1.2);
    const quad = (a, b, c, d, ua, ub, va, vb) => { const i = P.length / 3; P.push(...a, ...b, ...c, ...d); UV.push(ua, va, ub, va, ub, vb, ua, vb); I.push(i, i + 1, i + 2, i, i + 2, i + 3); };
    for (const { O, X, S, Nv, W, L } of planes) {
      const nC = Math.max(2, Math.round(L / R.course)), c = L / nC, texU = R.tw * 8;
      const sag = (x, s) => -sagA * Math.sin(Math.PI * (x / W + 0.5)) * Math.sin(Math.PI * s / L);
      const at = (x, s, l) => { l += sag(x, s); return [O[0] + X[0] * x + S[0] * s + Nv[0] * l, O[1] + X[1] * x + S[1] * s + Nv[1] * l, O[2] + X[2] * x + S[2] * s + Nv[2] * l]; };
      for (let k = 0; k < nC; k++) {
        const off = (k % 2) * R.tw / 2, s0 = k * c, s1 = (k + 1) * c, v0 = (k % 8) / 8, v1 = v0 + 1 / 8;
        for (let x0 = -W / 2 - off; x0 < W / 2; x0 += R.tw) {
          const a = Math.max(x0, -W / 2), b = Math.min(x0 + R.tw, W / 2);
          if (b - a < 0.03) continue;
          const slip = Math.random() < 0.03 ? 0.4 : 1; // the odd slipped tile
          let ta = R.lift * slip * (1 + rand(-R.jit, R.jit)), tb = R.lift * slip * (1 + rand(-R.jit, R.jit));
          const ua = (a + W / 2) / texU, ub = (b + W / 2) / texU;
          if (R.bulge) { // rounded bundles (thatch): the face swells before tucking under the course above
            const sm = s0 + c * 0.45, vm = v0 + 0.45 / 8;
            quad(at(a, s0, ta * 0.55), at(b, s0, tb * 0.55), at(b, sm, tb), at(a, sm, ta), ua, ub, v0 + 0.003, vm);
            quad(at(a, sm, ta), at(b, sm, tb), at(b, s1, 0), at(a, s1, 0), ua, ub, vm, v1 - 0.003);
            ta *= 0.55; tb *= 0.55;
          } else quad(at(a, s0, ta), at(b, s0, tb), at(b, s1, 0), at(a, s1, 0), ua, ub, v0 + 0.003, v1 - 0.003); // tile face
          quad(at(a, s0, 0), at(b, s0, 0), at(b, s0, tb), at(a, s0, ta), ua, ub, v0 + 0.001, v0 + 0.004); // butt edge
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(UV, 2));
    g.setIndex(I); g.computeVertexNormals(); return g;
  }
  // a gable roof (ridge along local x) with a ridge cap, added to parent at y
  function gableRoof(parent, R, w, d, h, y, z = 0, rotY = 0) {
    const g = new THREE.Group(); g.position.set(0, y, z); g.rotation.y = rotY; parent.add(g);
    const d2 = d / 2, L = Math.hypot(d2, h);
    g.add(new THREE.Mesh(courses(R, [
      { O: [0, 0, d2], X: [1, 0, 0], S: [0, h / L, -d2 / L], Nv: [0, d2 / L, h / L], W: w, L },
      { O: [0, 0, -d2], X: [-1, 0, 0], S: [0, h / L, d2 / L], Nv: [0, d2 / L, -h / L], W: w, L },
    ]), R.mat));
    const rg = new THREE.CylinderGeometry(R.ridge, R.ridge, w + 0.1, 7, 1);
    const uv = rg.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 0.4, uv.getY(i) * w / (R.tw * 8));
    rg.rotateZ(Math.PI / 2);
    mesh(rg, R.mat, g, [0, h + R.lift * 0.5, 0]);
    return g;
  }
  // a conical (or, with 4 sides, pyramidal) roof built as a lathe of stepped courses
  function coneRoof(R, r, h, sides = 24) {
    const L = Math.hypot(r, h), nC = Math.max(3, Math.round(L / R.course)), c = L / nC, pts = [], vs = [];
    const pt = (s, l) => new THREE.Vector2(Math.max(0, r * (1 - s / L) + (h / L) * l), h * s / L + (r / L) * l - h / 2);
    for (let k = 0; k < nC; k++) {
      const v0 = (k % 8) / 8, lift = R.lift * (k === nC - 1 ? 0.3 : 1);
      pts.push(pt(k * c, 0), pt(k * c, lift), pt(k * c, lift), pt((k + 1) * c, 0)); // duplicates → hard creases
      vs.push(v0 + 0.001, v0 + 0.004, v0 + 0.004, v0 + 1 / 8 - 0.003);
    }
    const g = new THREE.LatheGeometry(pts, sides), uv = g.attributes.uv, rep = Math.round(2 * Math.PI * r / (R.tw * 8)) || 1;
    for (let i = 0; i <= sides; i++) for (let j = 0; j < pts.length; j++) uv.setXY(i * pts.length + j, (i / sides) * rep, vs[j]);
    g.computeVertexNormals(); return g;
  }
  function gableEndGeo(w, d, h) {
    const x = w / 2, z = d / 2;
    const P = [-x, 0, -z, -x, 0, z, -x, h, 0, x, 0, z, x, 0, -z, x, h, 0];
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, .5, 1, 0, 0, 1, 0, .5, 1], 2));
    g.computeVertexNormals(); return g;
  }

  const glassM = std(0x0c0f12, 0.5, 0.1); // old, grimy crown glass
  const doorM = surfMat(woodTex, 0.9, 2.5, 0, { color: 0x7a6a5a });
  const beamM = surfMat(woodTex, 0.9, 2.5, 0, { color: 0x5a4a3c });
  const shutterMs = [0x4a5a46, 0x6a3a2c, 0x5a5650, 0x3e4a56].map(c => surfMat(woodTex, 0.92, 2.5, 0, { color: c }));
  const sootM = std(0x141210, 1);
  const clothM = std(0x5e1812, 0.95, 0, { side: THREE.DoubleSide });
  const hillM = std(0x48582e, 1);
  const pineM = std(0x263a22, 0.9), trunkM = std(0x3a2a1c, 0.9);

  const crenels = (parent, len, y, z, step = 2.2) => { for (let x = -len / 2 + 0.6; x < len / 2; x += step) mesh(box(1.1, 1.3, 0.9), stoneM, parent, [x, y + 0.65, z]); };
  function roundTower(parent, x, z, r, h, roofH, base = 0) {
    mesh(new THREE.CylinderGeometry(r, r * 1.08, h + 2, 20), stoneM, parent, [x, base + h / 2 - 1, z]);
    mesh(new THREE.CylinderGeometry(r * 1.15, r, 1, 20), stoneM, parent, [x, base + h + 0.5, z]);
    for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2; mesh(box(0.9, 1.2, 0.7), stoneM, parent, [x + Math.sin(a) * r * 1.08, base + h + 1.6, z + Math.cos(a) * r * 1.08], [0, a, 0]); }
    mesh(coneRoof(ROOF.slate, r * 1.25, roofH), slateM, parent, [x, base + h + 1 + roofH / 2, z]);
    for (let i = 0; i < 3; i++) { const a = rand(0, 6.28); mesh(box(0.35, 1.1, 0.2), glassM, parent, [x + Math.sin(a) * r * 1.02, base + h * rand(0.45, 0.85), z + Math.cos(a) * r * 1.02], [0, a, 0]); }
  }
  function banner(parent, x, y, z, rot) {
    mesh(new THREE.CylinderGeometry(0.08, 0.08, 4, 6), beamM, parent, [x, y + 2, z]);
    mesh(new THREE.PlaneGeometry(1.6, 1.0), clothM, parent, [x + Math.cos(rot) * 0.85, y + 3.4, z - Math.sin(rot) * 0.85], [0, rot, 0]);
  }

  // ---- house details
  function door(g, x, z, w = 1.15, h = 2.15) {
    mesh(box(w, h, 0.12), doorM, g, [x, h / 2, z]);
    for (const y of [0.4, h - 0.4]) mesh(box(w * 0.85, 0.08, 0.03), rustM, g, [x - w * 0.06, y, z + 0.075]); // strap hinges
    mesh(box(0.09, 0.09, 0.07), rustM, g, [x + w * 0.33, h * 0.48, z + 0.09]);
    mesh(box(w + 0.3, 0.2, 0.2), beamM, g, [x, h + 0.1, z + 0.02]); // lintel
  }
  function win(g, x, y, z, w, h, shutters) {
    mesh(box(w, h, 0.06), glassM, g, [x, y, z]);
    mesh(box(w + 0.2, 0.1, 0.16), beamM, g, [x, y - h / 2 - 0.05, z + 0.04]);
    if (shutters) {
      const m = pick(shutterMs);
      for (const s of [-1, 1]) if (Math.random() < 0.85) mesh(box(w * 0.5, h * 1.04, 0.05), m, g, [x + s * (w * 0.75 + 0.05), y, z + 0.05], [0, s * rand(0, 0.25), 0]);
    }
  }
  function chimney(g, x, z, top) {
    const h = top + rand(0.8, 1.6);
    mesh(box(0.8, h, 0.8), stoneM, g, [x, h / 2, z]);
    mesh(box(0.95, 0.3, 0.95), sootM, g, [x, h + 0.1, z]);
  }
  function sign(g, x, y, z) {
    mesh(box(0.06, 0.06, 1.1), rustM, g, [x, y, z + 0.55]);
    mesh(box(0.03, 0.25, 0.03), rustM, g, [x, y - 0.13, z + 0.95]);
    mesh(box(0.06, 0.6, 0.8), doorM, g, [x, y - 0.55, z + 0.7], [0, Math.PI / 2, 0]);
  }

  // timber-framed: stone ground floor, jettied plaster storeys, clay / slate / shingle roof
  function timberHouse(g) {
    const w = rand(5, 7.5), d = rand(5, 6.5), storeys = Math.random() < 0.5 ? 2 : 3, gh = 3.2, plaster = look.plaster = pickNot(plasterMs, look.plaster);
    mesh(box(w, gh + 0.8, d), stoneM, g, [0, (gh - 0.8) / 2, 0]); // plinth sinks into uneven ground
    door(g, rand(-w / 4, w / 4), d / 2 + 0.05);
    for (const sx of [-1, 1]) win(g, sx * w * 0.33, 1.9, d / 2 + 0.04, 0.7, 0.9, Math.random() < 0.6);
    let y = gh, jet = 0, fw = w, fd = d;
    for (let i = 1; i < storeys; i++) {
      jet += 0.3; fw = w + jet * 0.6; fd = d + jet;
      mesh(box(fw + 0.1, 0.22, fd + 0.1), beamM, g, [0, y + 0.11, jet / 2]);
      mesh(box(fw, 2.8, fd), plaster, g, [0, y + 0.22 + 1.4, jet / 2]);
      for (const sx of [-1, 1]) mesh(box(fw / 3 * 0.45, 1.06, 0.06), glassM, g, [sx * fw / 3, y + 0.22 + 1.54, jet / 2 + fd / 2 + 0.02]);
      for (const sx of [-0.5, 0.5]) mesh(box(0.08, 0.35, 0.04), rustM, g, [sx * fw, y + 0.11, jet / 2 + fd / 2 + 0.08]); // tie-rod anchors
      y += 3.02;
    }
    const R = ROOF[look.roof = pickNot(['clay', 'clay', 'clay', 'slate', 'shingle'], look.roof)], rh = fd * rand(0.6, 0.85);
    gableRoof(g, R, fw + 0.7, fd + 0.9, rh, y, jet / 2);
    const ends = new THREE.Mesh(gableEndGeo(fw, fd, rh * 0.94), daubM); ends.position.set(0, y, jet / 2); g.add(ends);
    if (Math.random() < 0.8) chimney(g, fw * rand(-0.35, 0.35), -fd * 0.2, y + rh * 0.6);
    if (Math.random() < 0.25) sign(g, w * 0.45, 2.9, d / 2);
  }
  // low stone cottage under a heavy, steep thatch
  function cottage(g) {
    const w = rand(5, 6.5), d = rand(4.2, 5), wh = 2.7;
    mesh(box(w, wh + 0.6, d), stoneM, g, [0, (wh - 0.6) / 2, 0]);
    door(g, rand(-w / 5, w / 5), d / 2 + 0.05, 1.0, 1.9);
    for (const sx of [-1, 1]) win(g, sx * w * 0.32, 1.55, d / 2 + 0.04, 0.55, 0.6, true);
    const rh = d * rand(0.85, 1.05);
    gableRoof(g, ROOF.thatch, w + 0.9, d + 1.5, rh + 0.25, wh - 0.2); look.roof = 'thatch'; look.plaster = null;
    const ends = new THREE.Mesh(gableEndGeo(w, d, rh * 0.95), stoneM); ends.position.set(0, wh, 0); g.add(ends);
    chimney(g, (Math.random() < 0.5 ? -1 : 1) * (w / 2 - 0.4), 0, wh + rh);
  }
  // weatherboarded house with a shingle roof, often a lean-to shed against one side
  function plankHouse(g) {
    const w = rand(5, 6.5), d = rand(4.5, 5.5), wh = Math.random() < 0.5 ? 3.4 : 5.6;
    mesh(box(w + 0.1, 1.2, d + 0.1), stoneM, g, [0, 0.1, 0]);
    mesh(box(w, wh - 0.6, d), planksM, g, [0, 0.7 + (wh - 0.6) / 2 - 0.3, 0]);
    door(g, rand(-w / 4, w / 4), d / 2 + 0.05);
    for (const sx of [-1, 1]) win(g, sx * w * 0.32, 1.9, d / 2 + 0.04, 0.6, 0.8, Math.random() < 0.7);
    if (wh > 4) for (const sx of [-1, 0, 1]) win(g, sx * w * 0.3, 4.2, d / 2 + 0.04, 0.55, 0.75, false);
    const rh = d * rand(0.55, 0.75);
    gableRoof(g, ROOF.shingle, w + 0.6, d + 0.8, rh, wh); look.roof = 'shingle'; look.plaster = null;
    const ends = new THREE.Mesh(gableEndGeo(w, d, rh * 0.94), planksM); ends.position.set(0, wh, 0); g.add(ends);
    if (Math.random() < 0.6) { // lean-to
      const sw = rand(1.8, 2.4), sd = d * 0.8, top = wh - 0.6, low = 2.0, run = sw + 0.3, L = Math.hypot(run, top - low), sx = w / 2 + sw / 2;
      mesh(box(sw, low, sd), planksM, g, [sx, low / 2, 0]);
      mesh(courses(ROOF.shingle, [{ O: [w / 2 + run, low, 0], X: [0, 0, 1], S: [-run / L, (top - low) / L, 0], Nv: [(top - low) / L, run / L, 0], W: sd + 0.4, L }]), ROOF.shingle.mat, g);
    }
    if (Math.random() < 0.5) chimney(g, -w / 2 + 0.5, -d * 0.2, wh + rh * 0.7);
  }
  // tall, narrow townhouse turning its gable to the street
  function townhouse(g) {
    const w = rand(4.2, 5.2), d = rand(6, 7.5), storeys = Math.random() < 0.5 ? 3 : 4, gh = 3.2, plaster = look.plaster = pickNot(plasterMs, look.plaster);
    mesh(box(w, gh + 0.8, d), stoneM, g, [0, (gh - 0.8) / 2, 0]);
    door(g, -w * 0.2, d / 2 + 0.05);
    win(g, w * 0.25, 1.9, d / 2 + 0.04, 0.8, 1.0, Math.random() < 0.5);
    let y = gh, jet = 0, fw = w, fd = d;
    for (let i = 1; i < storeys; i++) {
      jet += 0.25; fw = w + jet * 0.5; fd = d + jet;
      mesh(box(fw + 0.1, 0.22, fd + 0.1), beamM, g, [0, y + 0.11, jet / 2]);
      mesh(box(fw, 2.8, fd), plaster, g, [0, y + 0.22 + 1.4, jet / 2]);
      y += 3.02;
    }
    const R = ROOF[look.roof = pickNot(['slate', 'slate', 'clay'], look.roof)], rh = fw * rand(0.95, 1.25);
    gableRoof(g, R, fd + 0.6, fw + 0.6, rh, y, jet / 2, Math.PI / 2); // ridge runs front to back
    const ends = new THREE.Mesh(gableEndGeo(fd, fw, rh * 0.95), daubM); ends.position.set(0, y, jet / 2); ends.rotation.y = Math.PI / 2; g.add(ends);
    win(g, 0, y + rh * 0.35, jet / 2 + fd / 2 + 0.02, 0.6, 0.8, false); // attic window in the gable
    if (Math.random() < 0.3) sign(g, w * 0.45, 2.9, d / 2);
    chimney(g, fw / 2 - 0.4, -fd * 0.25, y + rh * 0.5);
  }

  const houseRings = []; window.__houseRings = houseRings; // (debug: the type sequence of each ring)
  // houses in rings around the arena, leaving a road open towards the castle; the inner rings are denser and taller.
  // Every ring has all four types (weighted: the inner ring is mostly tall houses, the outer mostly cottages), so the
  // 3-house gap between equal types leaves room for variety instead of a rigid pattern.
  for (const [r, n, jitter, mix] of [[27, 24, 1.5, [timberHouse, timberHouse, townhouse, townhouse, plankHouse, cottage]], [37, 30, 2, [timberHouse, townhouse, plankHouse, cottage]], [48, 36, 2.5, [timberHouse, plankHouse, cottage, cottage, townhouse]]]) {
    // the plots first, so the choice of house type can look ahead around the ring as well as back
    const plots = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rand(-0.04, 0.04);
      if (Math.abs(angWrap(a - Math.PI)) < 6 / r) continue;
      if (r === 37 && Math.abs(angWrap(a - 1.05)) < 0.18) continue; // bell tower plot
      plots.push(a);
    }
    // A house type comes back no sooner than 3 houses on: it may not match either of the 2 houses before it, and
    // near the end of the ring, either of the 2 after it (the ring closes on its first houses). The mix's repeats
    // still weight the choice. If a ring has too few types to satisfy that everywhere, the gap shrinks to 2 there.
    const types = [], m = plots.length;
    for (let k = 0; k < m; k++) {
      const near = [types[k - 1], types[k - 2]];
      if (k >= m - 2) near.push(types[(k + 1) % m], types[(k + 2) % m]);
      let pool = mix.filter(t => !near.includes(t));
      if (!pool.length) pool = mix.filter(t => t !== types[k - 1] && (k < m - 1 || t !== types[0]));
      types.push(pool.length ? pick(pool) : pick(mix));
    }
    plots.forEach((a, k) => {
      const rr = r + rand(-jitter, jitter);
      const g = new THREE.Group(); g.position.set(Math.sin(a) * rr, 0, Math.cos(a) * rr); g.rotation.y = a + Math.PI + rand(-0.12, 0.12); tmp.add(g);
      look.type = types[k]; types[k](g);
      g.userData.houseType = types[k].name;
    });
    houseRings.push(plots.map((a, k) => types[k].name));
  }
  // bell tower
  {
    const a = 1.05, r = 37, g = new THREE.Group(); g.position.set(Math.sin(a) * r, 0, Math.cos(a) * r); g.rotation.y = a; tmp.add(g);
    mesh(box(6, 22, 6), stoneM, g, [0, 11, 0]);
    for (const [sx, sz, ry] of [[0, 3.02, 0], [0, -3.02, 0], [3.02, 0, Math.PI / 2], [-3.02, 0, Math.PI / 2]]) mesh(box(1.4, 3, 0.1), glassM, g, [sx, 18, sz], [0, ry, 0]);
    mesh(box(7, 0.8, 7), stoneM, g, [0, 22.4, 0]);
    mesh(coneRoof(ROOF.slate, 5.2, 12, 4), slateM, g, [0, 28.8, 0], [0, Math.PI / 4, 0]);
    mesh(box(10, 9, 7), stoneM, g, [0, 4.5, -6.5]);
    const nave = new THREE.Group(); nave.position.z = -6.5; g.add(nave); gableRoof(nave, ROOF.slate, 7.6, 11, 5, 9, 0, Math.PI / 2);
  }
  // city wall with towers
  {
    const R = 62, N = 16;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2, b = ((i + 1) / N) * Math.PI * 2, m = (a + b) / 2;
      roundTower(tmp, Math.sin(a) * R, Math.cos(a) * R, 3.4, 13, 7);
      if (Math.abs(angWrap(m - Math.PI)) < 0.15) continue; // the castle road passes here
      const len = 2 * R * Math.sin(Math.PI / N) - 6;
      const g = new THREE.Group(); g.position.set(Math.sin(m) * R * Math.cos(Math.PI / N), 0, Math.cos(m) * R * Math.cos(Math.PI / N)); g.rotation.y = m + Math.PI / 2; tmp.add(g);
      mesh(box(len, 11, 2.4), stoneM, g, [0, 3.5, 0]);
      crenels(g, len, 9, 0.9);
    }
  }
  // castle on a hill beyond the gate
  {
    const cx = 0, cz = -112, base = 9;
    mesh(new THREE.SphereGeometry(1, 32, 16), hillM, tmp, [cx, -4, cz], [0, 0, 0], [62, 14, 50]);
    const g = new THREE.Group(); g.position.set(cx, 0, cz); tmp.add(g);
    const W = 56, D = 40, H = 12;
    for (const [x, z, w, d] of [[0, -D / 2, W, 2.8], [-W / 2, 0, 2.8, D], [W / 2, 0, 2.8, D]]) {
      mesh(box(w, base + H, d), stoneM, g, [x, (base + H) / 2, z]);
    }
    for (const s of [-1, 1]) mesh(box(W / 2 - 5, base + H, 2.8), stoneM, g, [s * (W / 4 + 2.5), (base + H) / 2, D / 2]);
    for (const [len, x, z, ry] of [[W, 0, D / 2 + 1, 0], [W, 0, -D / 2 - 1, 0], [D, W / 2 + 1, 0, Math.PI / 2], [D, -W / 2 - 1, 0, Math.PI / 2]]) {
      const c = new THREE.Group(); c.position.set(x, 0, z); c.rotation.y = ry; g.add(c); crenels(c, len, base + H, 0);
    }
    for (const [x, z] of [[-W / 2, -D / 2], [W / 2, -D / 2], [-W / 2, D / 2], [W / 2, D / 2]]) roundTower(g, x, z, 4.4, base + 19, 10);
    for (const s of [-1, 1]) roundTower(g, s * 4.6, D / 2 + 1, 3.1, base + 16, 7);
    mesh(box(5.4, 7, 1), doorM, g, [0, base + 3.5, D / 2 + 1.6]);
    // the keep
    mesh(box(17, base + 30, 15), stoneM, g, [0, (base + 30) / 2, -5]);
    for (const [len, x, z, ry] of [[17, 0, 2.6, 0], [17, 0, -12.6, 0], [15, 8.6, -5, Math.PI / 2], [15, -8.6, -5, Math.PI / 2]]) {
      const c = new THREE.Group(); c.position.set(x, 0, z); c.rotation.y = ry; g.add(c); crenels(c, len, base + 30, 0, 2.0);
    }
    for (const [x, z] of [[-8.5, 2.5], [8.5, 2.5], [-8.5, -12.5], [8.5, -12.5]]) roundTower(g, x, z, 1.8, base + 35, 6);
    for (let i = 0; i < 4; i++) for (const s of [-1, 1]) mesh(box(0.6, 2.2, 0.1), glassM, g, [s * (2 + i * 1.6), base + 14 + (i % 2) * 7, 2.56]);
    banner(g, 0, base + 30, -5, 0); banner(g, -W / 2, base + 30, -D / 2, 0.4); banner(g, W / 2, base + 30, -D / 2, -0.4);
    // dirt road from the arena gate to the castle
    const rg = new THREE.PlaneGeometry(6, 80, 6, 120); rg.rotateX(-Math.PI / 2); rg.translate(0, 0, -58);
    const rp = rg.attributes.position; for (let i = 0; i < rp.count; i++) rp.setY(i, groundH(rp.getX(i), rp.getZ(i)) + 0.05);
    rg.computeVertexNormals();
    const road = new THREE.Mesh(rg, std(0x54432f, 1)); road.receiveShadow = true; scene.add(road);
  }
  // forest and mountains beyond the walls
  for (let i = 0; i < 140; i++) {
    const a = rand(0, Math.PI * 2), r = rand(70, 150);
    const x = Math.sin(a) * r, z = Math.cos(a) * r;
    if (Math.hypot(x, z + 112) < 62) continue;
    const s = rand(0.8, 1.5);
    const gy = groundH(x, z) - 0.3;
    mesh(new THREE.CylinderGeometry(0.3 * s, 0.4 * s, 3 * s, 6), trunkM, tmp, [x, gy + 1.5 * s, z]);
    for (let k = 0; k < 3; k++) mesh(cone((3 - k * 0.7) * s, 4 * s, 8), pineM, tmp, [x, gy + (3 + k * 2.4) * s, z]);
  }
  bakeStatic(tmp);
  // The mountains: one ring of terrain around the valley, pushed up by ridged noise into peaks, ridges and saddles
  // (sharp crests where the noise folds), with forested foothills, grey rock, and snow on the high ground that thins on
  // steep faces. Vertex colours only; the haze does the rest.
  {
    const geo = new THREE.RingGeometry(160, 255, 260, 30); geo.rotateX(-Math.PI / 2);
    const p = geo.attributes.position, col = new Float32Array(p.count * 3);
    const ridge = (x, z) => { let s = 0, a = 0.5, f = 1; for (let o = 0; o < 5; o++) { const n = 1 - Math.abs(noise2(x * f, z * f) * 2 - 1); s += a * n * n; f *= 2.1; a *= 0.5; } return s; };
    const H = new Float32Array(p.count);
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), z = p.getZ(i), r = Math.hypot(x, z);
      const rise = smoothstep(160, 200, r) * (1 - 0.25 * smoothstep(225, 255, r));            // up from the valley floor
      const range = 0.55 + 0.45 * fbm2(x * 0.006 + 11, z * 0.006 - 4, 2);                       // some stretches higher
      const h = rise * range * (ridge(x * 0.011 + 40, z * 0.011 + 40) * 105 + 6) - 4;
      H[i] = h; p.setY(i, h);
    }
    geo.computeVertexNormals();
    const nr = geo.attributes.normal;
    for (let i = 0; i < p.count; i++) {
      const h = H[i], up = nr.getY(i), x = p.getX(i), z = p.getZ(i);
      const forest = 1 - smoothstep(8, 26, h), snowLine = 46 + fbm2(x * 0.03, z * 0.03, 2) * 18;
      const snow = smoothstep(snowLine, snowLine + 10, h) * smoothstep(0.45, 0.75, up);       // snow settles on the gentler slopes
      const rock = 0.3 + fbm2(x * 0.05 + 3, z * 0.05, 2) * 0.12;
      let c = [rock * 0.95, rock * 1.0, rock * 1.08];
      c = c.map((k, j) => lerp(k, [0.13, 0.17, 0.12][j], forest));
      c = c.map((k, j) => lerp(k, [0.86, 0.89, 0.93][j], snow));
      col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2];
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const m = new THREE.Mesh(geo, std(0xffffff, 0.95, 0, { vertexColors: true, envMapIntensity: 0.4 }));
    m.receiveShadow = false; scene.add(m);
  }
}
// merge all static geometry by material and region → few draw calls, and only for what is actually in view
function bakeStatic(group) {
  group.updateMatrixWorld(true);
  const bins = new Map();
  group.traverse(o => {
    if (!o.isMesh) return;
    let g = o.geometry.clone().applyMatrix4(o.matrixWorld);
    if (g.index) g = g.toNonIndexed();
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    const ws = o.material.userData.world;
    if (ws) {
      const p = g.attributes.position, n = g.attributes.normal, uv = g.attributes.uv;
      for (let i = 0; i < p.count; i++) {
        const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i)), az = Math.abs(n.getZ(i));
        let u, v;
        if (ay >= ax && ay >= az) { u = p.getX(i); v = p.getZ(i); } else if (ax >= az) { u = p.getZ(i); v = p.getY(i); } else { u = p.getX(i); v = p.getY(i); }
        uv.setXY(i, u / ws, v / ws);
      }
    }
    // region = ring around the arena × compass sector. Each region is its own mesh with a tight bounding sphere, so the
    // camera skips whatever is behind it and the shadow pass skips everything that cannot shade the arena.
    g.computeBoundingBox(); const c = g.boundingBox.getCenter(new V3()), r = Math.hypot(c.x, c.z);
    const ring = r < 24 ? 0 : r < 33 ? 1 : r < 43 ? 2 : r < 56 ? 3 : r < 80 ? 4 : 5, sectors = ring ? 8 : 6;
    const key = o.material.uuid + ':' + ring + ':' + Math.min(sectors - 1, Math.floor((Math.atan2(c.x, c.z) + Math.PI) / (Math.PI * 2) * sectors));
    if (!bins.has(key)) bins.set(key, { mat: o.material, arr: [] });
    bins.get(key).arr.push(g);
  });
  for (const { mat, arr } of bins.values()) {
    const m = new THREE.Mesh(mergeGeometries(arr), mat);
    m.castShadow = true; m.receiveShadow = true;
    scene.add(m);
  }
}


// props scattered around the edge
const banners = [];
(function props() {
  const fixed = new THREE.Group();
  const crateTex = canvasTex(128, (g, s) => {
    g.fillStyle = '#45311f'; g.fillRect(0, 0, s, s);
    g.strokeStyle = '#1a1008'; g.lineWidth = 8; g.strokeRect(4, 4, s - 8, s - 8);
    g.beginPath(); g.moveTo(8, 8); g.lineTo(s - 8, s - 8); g.stroke();
    for (let i = 0; i < 60; i++) { g.fillStyle = `rgba(0,0,0,${rand(.05, .15)})`; g.fillRect(rand(0, s), rand(0, s), rand(10, 40), 2); }
    weather(g, s, { streaks: 8, damp: 0.4, dampA: 0.5, blotches: 8, moss: 0.3, grit: 1500 });
  });
  const crateMat = surfMat(crateTex, 0.95, 2);
  const spots = [[0.75, 1], [0.82, 0.8], [2.3, 1.1], [-0.9, 0.9], [-2.2, 1], [-2.3, 0.75], [1.6, 0.85]];
  for (const [a, s] of spots) {
    const r = 16.9;
    mesh(new THREE.BoxGeometry(s, s, s), crateMat, fixed, [Math.sin(a) * r, s / 2, Math.cos(a) * r], [0, rand(0, 3), 0]);
  }
  const barrelMat = surfMat(woodTex, 0.9, 2.5, 0, { color: 0x9a8070 });
  for (const a of [0.55, -1.4, 2.0, -2.75]) {
    const r = 17.0;
    const b = mesh(new THREE.CylinderGeometry(0.42, 0.42, 1.1, 14), barrelMat, fixed, [Math.sin(a) * r, 0.55, Math.cos(a) * r]);
    mesh(new THREE.TorusGeometry(0.43, 0.03, 6, 18), rustM, b, [0, 0.35, 0], [Math.PI / 2, 0, 0]);
    mesh(new THREE.TorusGeometry(0.43, 0.03, 6, 18), rustM, b, [0, -0.35, 0], [Math.PI / 2, 0, 0]);
  }
  // bleached bones in the sand
  const boneMat = std(0xa89c82, 0.85);
  for (let i = 0; i < 18; i++) {
    const a = rand(0, 6.28), r = rand(4, 16);
    mesh(new THREE.CylinderGeometry(0.04, 0.05, rand(0.4, 0.9), 6), boneMat, fixed, [Math.sin(a) * r, groundH(Math.sin(a) * r, Math.cos(a) * r) + 0.03, Math.cos(a) * r], [Math.PI / 2, 0, rand(0, 3)]);
  }
  // banners
  const clothMat = std(0x5a1812, 0.97, 0, { side: THREE.DoubleSide });
  for (const a of [Math.PI + 0.55, Math.PI - 0.55, 0.0]) {
    const r = 18.0;
    mesh(new THREE.CylinderGeometry(0.06, 0.06, 7.5, 6), darkWood, fixed, [Math.sin(a) * r, 3.75, Math.cos(a) * r]);
    const cloth = mesh(new THREE.PlaneGeometry(1.1, 2.4, 4, 8), clothMat, scene, [Math.sin(a) * (r - 0.05), 5.9, Math.cos(a) * (r - 0.05)], [0, a + Math.PI, 0]);
    banners.push({ m: cloth, base: cloth.geometry.attributes.position.array.slice(), ph: rand(0, 6) });
  }
  bakeStatic(fixed);
})();

// ============================================================ particles
const particleSystems = [];
const pointScale = () => (innerHeight * renderer.getPixelRatio()) / (2 * Math.tan((camera.fov * Math.PI) / 360));
class Particles {
  constructor(max, additive) {
    this.max = max; this.i = 0;
    this.pos = new Float32Array(max * 3); this.col = new Float32Array(max * 3);
    this.alpha = new Float32Array(max); this.size = new Float32Array(max);
    this.vel = new Float32Array(max * 3); this.life = new Float32Array(max); this.maxLife = new Float32Array(max).fill(1);
    this.a0 = new Float32Array(max); this.grav = new Float32Array(max); this.drag = new Float32Array(max);
    this.grow = new Float32Array(max); this.flag = new Uint8Array(max);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('pcolor', new THREE.BufferAttribute(this.col, 3));
    g.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1));
    g.setAttribute('psize', new THREE.BufferAttribute(this.size, 1));
    this.mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      uniforms: { scale: { value: pointScale() } },
      vertexShader: `attribute vec3 pcolor; attribute float alpha; attribute float psize; uniform float scale;
        varying vec3 vC; varying float vA;
        void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); gl_PointSize = psize * scale / max(0.1, -mv.z);
          gl_Position = projectionMatrix * mv; vC = pcolor; vA = alpha; }`,
      fragmentShader: `varying vec3 vC; varying float vA;
        void main(){ float r = length(gl_PointCoord - 0.5); if (r > 0.5) discard;
          gl_FragColor = vec4(vC, vA * (1.0 - smoothstep(0.1, 0.5, r))); }`
    });
    this.geo = g;
    this.points = new THREE.Points(g, this.mat); this.points.frustumCulled = false;
    scene.add(this.points); particleSystems.push(this);
  }
  emit(p, v, c, size, life, grav = -9.8, drag = 0.5, grow = 0, a = 1, flag = 0) {
    const i = this.i; this.i = (this.i + 1) % this.max; const i3 = i * 3;
    this.pos[i3] = p.x; this.pos[i3 + 1] = p.y; this.pos[i3 + 2] = p.z;
    this.vel[i3] = v.x; this.vel[i3 + 1] = v.y; this.vel[i3 + 2] = v.z;
    this.col[i3] = c[0]; this.col[i3 + 1] = c[1]; this.col[i3 + 2] = c[2];
    this.size[i] = size; this.life[i] = this.maxLife[i] = life; this.a0[i] = a; this.alpha[i] = a;
    this.grav[i] = grav; this.drag[i] = drag; this.grow[i] = grow; this.flag[i] = flag;
  }
  update(dt) {
    let alive = false;
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) continue;
      alive = true;
      this.life[i] -= dt;
      if (this.life[i] <= 0) { this.alpha[i] = 0; this.size[i] = 0; continue; }
      const i3 = i * 3, dr = Math.exp(-this.drag[i] * dt);
      this.vel[i3 + 1] += this.grav[i] * dt;
      this.vel[i3] *= dr; this.vel[i3 + 1] *= dr; this.vel[i3 + 2] *= dr;
      this.pos[i3] += this.vel[i3] * dt; this.pos[i3 + 1] += this.vel[i3 + 1] * dt; this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      const gy = this.pos[i3 + 1] < 0.6 ? groundH(this.pos[i3], this.pos[i3 + 2]) + 0.03 : -1;
      if (this.pos[i3 + 1] < gy) {
        this.pos[i3 + 1] = gy;
        if (this.flag[i] === 1) { addDecal(this.pos[i3], this.pos[i3 + 2], rand(0.05, 0.16)); this.flag[i] = 0; this.life[i] = Math.min(this.life[i], 0.15); }
        this.vel[i3 + 1] = 0; this.vel[i3] *= 0.4; this.vel[i3 + 2] *= 0.4;
      }
      const k = this.life[i] / this.maxLife[i];
      this.alpha[i] = this.a0[i] * Math.min(1, k * 1.6);
      this.size[i] = Math.max(0, this.size[i] + this.grow[i] * dt);
    }
    if (alive || this.wasAlive) for (const n of ['position', 'pcolor', 'alpha', 'psize']) this.geo.attributes[n].needsUpdate = true;
    this.wasAlive = alive;
  }
}
const fxAdd = new Particles(1800, true);   // fire, sparks, embers
const fxNorm = new Particles(1400, false); // blood, dust, feathers

const decalGeo = new THREE.CircleGeometry(1, 14); decalGeo.rotateX(-Math.PI / 2);
const decals = [];
for (let i = 0; i < 160; i++) {
  const m = new THREE.Mesh(decalGeo, new THREE.MeshStandardMaterial({ color: 0x3d0705, roughness: 0.35, transparent: true, opacity: 0.85, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
  m.visible = false; m.receiveShadow = true; scene.add(m); decals.push(m);
}
let decalIdx = 0;
function addDecal(x, z, s) {
  const m = decals[decalIdx]; decalIdx = (decalIdx + 1) % decals.length;
  m.position.set(x, groundH(x, z) + 0.011 + Math.random() * 0.004, z);
  m.scale.set(s, 1, s * rand(0.6, 1)); m.rotation.y = rand(0, 6.28);
  m.visible = true;
}
const tmpV = new V3(), tmpV2 = new V3();
function bloodBurst(p, dir, n) {
  for (let i = 0; i < n; i++) {
    const v = tmpV.set(dir.x * rand(1, 4.5) + rand(-1.6, 1.6), rand(0.6, 3.6), dir.z * rand(1, 4.5) + rand(-1.6, 1.6));
    const s = rand(0.45, 1);
    fxNorm.emit(p, v, [0.42 * s, 0.02, 0.02], rand(0.05, 0.13), rand(0.6, 1.1), -11, 0.6, 0, 0.95, Math.random() < 0.6 ? 1 : 0);
  }
}
function sparks(p, n) {
  for (let i = 0; i < n; i++) {
    fxAdd.emit(p, tmpV.set(rand(-5, 5), rand(1, 5), rand(-5, 5)), [1.0, rand(0.6, 0.9), 0.4], rand(0.03, 0.06), rand(0.15, 0.4), -12, 1.5);
  }
  fxAdd.emit(p, tmpV.set(0, 0, 0), [1.0, 0.85, 0.6], 0.6, 0.08, 0, 0, 3);
}
function dust(p, n, spread = 0.5, strength = 1) {
  for (let i = 0; i < n; i++) {
    tmpV2.set(p.x + rand(-spread, spread), 0.1, p.z + rand(-spread, spread));
    fxNorm.emit(tmpV2, tmpV.set(rand(-1, 1) * strength, rand(0.2, 0.9) * strength, rand(-1, 1) * strength), [0.42, 0.33, 0.23], rand(0.25, 0.5), rand(0.5, 1.0), 0.15, 2.0, 0.9, 0.32);
  }
}
function feathers(p, n, col) {
  for (let i = 0; i < n; i++) {
    fxNorm.emit(p, tmpV.set(rand(-2, 2), rand(0.5, 2.5), rand(-2, 2)), col, rand(0.07, 0.12), rand(1.2, 2.2), -1.2, 2.5, 0, 0.9);
  }
}

// sword trail
class Trail {
  constructor() {
    this.N = 22; this.samples = [];
    this.posArr = new Float32Array(this.N * 2 * 3); this.aArr = new Float32Array(this.N * 2);
    const idx = [];
    for (let i = 0; i < this.N - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.posArr, 3));
    this.geo.setAttribute('alpha', new THREE.BufferAttribute(this.aArr, 1));
    this.geo.setIndex(idx);
    this.mesh = new THREE.Mesh(this.geo, new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
      uniforms: { col: { value: new THREE.Color(1.0, 0.86, 0.66) } },
      vertexShader: `attribute float alpha; varying float vA; void main(){ vA = alpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform vec3 col; varying float vA; void main(){ gl_FragColor = vec4(col, vA); }`
    }));
    this.mesh.frustumCulled = false; scene.add(this.mesh);
  }
  push(b, t, strength = 1) {
    this.samples.unshift({ b: b.clone(), t: t.clone(), age: 0, s: strength });
    if (this.samples.length > this.N) this.samples.pop();
  }
  update(dt) {
    for (const s of this.samples) s.age += dt;
    while (this.samples.length && this.samples[this.samples.length - 1].age > 0.17) this.samples.pop();
    const n = this.samples.length;
    for (let i = 0; i < this.N; i++) {
      const s = this.samples[Math.min(i, n - 1)];
      const o = i * 6;
      if (!s) { this.aArr[i * 2] = this.aArr[i * 2 + 1] = 0; continue; }
      this.posArr[o] = s.b.x; this.posArr[o + 1] = s.b.y; this.posArr[o + 2] = s.b.z;
      this.posArr[o + 3] = s.t.x; this.posArr[o + 4] = s.t.y; this.posArr[o + 5] = s.t.z;
      const a = i < n ? Math.max(0, 1 - s.age / 0.17) * (1 - i / this.N) * 0.6 * s.s : 0;
      this.aArr[i * 2] = a * 0.15; this.aArr[i * 2 + 1] = a;
    }
    this.geo.setDrawRange(0, Math.max(0, n - 1) * 6);
    this.geo.attributes.position.needsUpdate = true; this.geo.attributes.alpha.needsUpdate = true;
  }
}
const trail = new Trail();

// ============================================================ torches
const torches = [];
(function buildTorches() {
  const angles = [0.4, 1.15, 1.95, 2.6, -0.4, -1.15, -1.95, -2.6];
  const postMat = darkWood, ironMat = rustM, torchPosts = new THREE.Group();
  angles.forEach((a, i) => {
    const r = 17.5, x = Math.sin(a) * r, z = Math.cos(a) * r;
    mesh(new THREE.CylinderGeometry(0.08, 0.1, 2.7, 7), postMat, torchPosts, [x, 1.35, z]);
    mesh(new THREE.CylinderGeometry(0.22, 0.1, 0.25, 10, 1, true), ironMat, torchPosts, [x, 2.78, z]);
    const t = { p: new V3(x, 2.95, z), acc: 0, seed: rand(0, 100), light: null };
    if (i % 2 === 0) {
      t.light = new THREE.PointLight(0xff8a3c, 10, 12, 1.7);
      t.light.position.copy(t.p).add(new V3(-x * 0.03, 0.3, -z * 0.03));
      scene.add(t.light);
    }
    torches.push(t);
  });
  bakeStatic(torchPosts);
})();
function updateTorches(dt, time) {
  for (const t of torches) {
    t.acc += dt * 46;
    while (t.acc > 1) {
      t.acc--;
      tmpV2.set(t.p.x + rand(-0.12, 0.12), t.p.y + rand(-0.05, 0.1), t.p.z + rand(-0.12, 0.12));
      const hot = Math.random();
      fxAdd.emit(tmpV2, tmpV.set(rand(-0.2, 0.2), rand(0.8, 1.8), rand(-0.2, 0.2)), [1.0, 0.35 + hot * 0.35, 0.08 + hot * 0.1], rand(0.25, 0.45), rand(0.35, 0.6), 1.5, 1.5, -0.5, 0.75);
      if (Math.random() < 0.04) fxAdd.emit(tmpV2, tmpV.set(rand(-0.6, 0.6), rand(1.5, 3), rand(-0.6, 0.6)), [1, 0.55, 0.2], 0.04, rand(1.5, 2.8), 0.4, 0.4);
      if (Math.random() < 0.08) fxNorm.emit(tmpV2.setY(t.p.y + 0.5), tmpV.set(rand(-0.2, 0.2), 1.1, rand(-0.2, 0.2)), [0.12, 0.1, 0.1], 0.4, 1.6, 0.2, 0.6, 0.6, 0.25);
    }
    if (t.light) {
      const f = Math.sin(time * 11 + t.seed) * 0.5 + Math.sin(time * 23.7 + t.seed * 2) * 0.3 + Math.sin(time * 5.3 + t.seed) * 0.2;
      t.light.intensity = 10 * (0.85 + 0.15 * f) * Daylight.torch;
    }
  }
}

// ============================================================ day and night
// The sun follows the player's own clock: up at 6:00, highest at noon, down at 18:00, with a golden hour either side;
// at night the moon (opposite the sun) lights the arena faintly in blue, the stars come out and the torches carry the
// scene. ?hour=21.5 in the URL (or __game.setHour) fixes the time, for testing.
const Daylight = (() => {
  const q = new URLSearchParams(location.search);
  let fixed = q.has('hour') ? parseFloat(q.get('hour')) : null;
  const st = { hour: 12, day: 1, dusk: 0, night: 0, torch: 1, sunI: 2.75, fillI: 1.1, hemiI: 0.55, fog: new THREE.Color(0x8e9296), fogWet: new THREE.Color(0x676d71) };
  const SUN_C = new THREE.Color(0xffeccc), DUSK_C = new THREE.Color(0xff9a55), MOON_C = new THREE.Color(0x9fb4e0);
  const HEMI_DAY = new THREE.Color(0xcfe0ff), HEMI_NIGHT = new THREE.Color(0x3a4a6e), GROUND_DAY = new THREE.Color(0x6a5a40), GROUND_NIGHT = new THREE.Color(0x1c1914);
  const FOG_DAY = new THREE.Color(0x8e9296), FOG_NIGHT = new THREE.Color(0x141922), FOG_DUSK = new THREE.Color(0x9a7f70);
  const moon = new V3();
  function update() {
    const now = new Date();
    const h = fixed ?? now.getHours() + now.getMinutes() / 60 + now.getSeconds() / 3600;
    st.hour = h;
    const el = Math.sin((h - 6) / 12 * Math.PI) * 0.95;         // sun elevation (rad): about 54° at noon, -54° at midnight
    const az = (h / 24) * Math.PI * 2 + 0.6;
    SUN_DIR.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
    moon.set(-SUN_DIR.x, Math.max(0.25, -SUN_DIR.y), -SUN_DIR.z).normalize();
    st.day = smoothstep(-0.14, 0.22, SUN_DIR.y); st.night = 1 - st.day;
    st.dusk = Math.exp(-(((SUN_DIR.y - 0.04) / 0.16) ** 2));
    // one directional light: the sun while it is up, the moon after it sets (it is dim around the switch, so no pop)
    if (SUN_DIR.y > 0.0) {
      sun.position.copy(SUN_DIR).multiplyScalar(60); sun.color.copy(SUN_C).lerp(DUSK_C, st.dusk);
      st.sunI = 2.75 * smoothstep(0.0, 0.2, SUN_DIR.y);
    } else {
      sun.position.copy(moon).multiplyScalar(60); sun.color.copy(MOON_C);
      st.sunI = 0.95 * smoothstep(0.0, 0.18, -SUN_DIR.y);
    }
    st.fillI = 1.1 * lerp(0.2, 1, st.day); st.hemiI = 0.55 * lerp(0.55, 1, st.day); // moonlit nights: dark, but you can still fight
    hemi.color.copy(HEMI_NIGHT).lerp(HEMI_DAY, st.day); hemi.groundColor.copy(GROUND_NIGHT).lerp(GROUND_DAY, st.day);
    st.fog.copy(FOG_NIGHT).lerp(FOG_DAY, st.day).lerp(FOG_DUSK, st.dusk * 0.55);
    st.fogWet.copy(FOG_NIGHT).lerp(new THREE.Color(0x676d71), st.day);
    st.torch = 1 + 0.9 * st.night;
    const u = sky.material.uniforms; u.dayK.value = st.day; u.duskK.value = st.dusk; u.moonDir.value.copy(moon);
    let bright = 1; try { bright = settings.bright; } catch (e) { /* settings aren't loaded yet on the first call */ }
    renderer.toneMappingExposure = 0.9 * bright * (1 + 0.6 * st.night);
  }
  update();
  return { st, update, get torch() { return st.torch; }, setHour(hh) { fixed = hh; update(); } };
})();

// ============================================================ weather
// After medieval-sim's dynamic weather: dry spells and showers take turns. Clouds build up over half a minute and close
// into a grey lid, the sun is buried, the haze thickens and the light goes flat; then the rain comes, as streaks falling
// through a box that travels with the camera, splashes in the sand and a hiss over everything. The sand, stone and wood
// darken and turn slick while it rains and dry out slowly afterwards. Pause menu: Changing / Dry / Rain.
const Weather = (() => {
  const wx = { cloud: 0, rain: 0, wet: 0, want: false, t: rand(70, 160) };
  const FOG_D = 0.0058; // fog colours come from the time of day (Daylight)
  const smooth = x => x * x * (3 - 2 * x);
  // surfaces that get wet: [material, dry roughness]
  const wetMats = [stoneM, logMat, darkWood].map(m => [m, m.roughness]); // the ground has its own, patchy wetness (wetGround)
  let bakedOC = 0, bakedDay = 1, bakedDusk = 0;
  const N = TOUCH ? 700 : 1500, BOX = [30, 18, 30], FALL = 14, WIND = [2.4, 1.0], LEN = 0.6;
  const pos = new Float32Array(N * 6), seed = new Float32Array(N * 3);
  for (let i = 0; i < seed.length; i++) seed[i] = Math.random();
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.LineBasicMaterial({ color: 0xb2bcc4, transparent: true, opacity: 0, depthWrite: false });
  const lines = new THREE.LineSegments(geo, mat); lines.frustumCulled = false; lines.visible = false; scene.add(lines);
  let hiss = null, patter = null, splashAcc = 0;
  function initAudio() { // two noise beds: the hiss of the drops in the air, and a duller patter on sand and wood
    if (hiss || !AC) return;
    const bed = (type, f, q, extra) => {
      const s = AC.createBufferSource(); s.buffer = noiseBuf; s.loop = true;
      const f1 = AC.createBiquadFilter(); f1.type = type; f1.frequency.value = f; f1.Q.value = q;
      const g = AC.createGain(); g.gain.value = 0;
      let n = s.connect(f1); if (extra) { const f2 = AC.createBiquadFilter(); f2.type = 'lowpass'; f2.frequency.value = extra; n = n.connect(f2); }
      n.connect(g).connect(master); s.start(0, Math.random()); return g;
    };
    hiss = bed('highpass', 1300, 0.5, 7000); patter = bed('bandpass', 520, 0.6);
  }
  function setLevel(r) {
    if (!hiss) return;
    hiss.gain.setTargetAtTime(r * 0.16, AC.currentTime, 0.4); patter.gain.setTargetAtTime(r * 0.22, AC.currentTime, 0.4);
  }
  function update(dt, time) {
    const mode = settings.weather;
    if (mode === 'dynamic') { if ((wx.t -= dt) < 0) { wx.want = !wx.want; wx.t = wx.want ? rand(60, 130) : rand(100, 220); } }
    else wx.want = mode === 'rain';
    wx.cloud = clamp(wx.cloud + (wx.want ? dt : -dt) / 28, 0, 1);
    wx.rain = smooth(clamp((wx.cloud - 0.5) / 0.5, 0, 1));
    wx.wet = clamp(wx.wet + (wx.rain > wx.wet ? (wx.rain - wx.wet) * dt / 8 : -dt / 70), 0, 1); // soaks in fast, dries slowly
    const c = smooth(wx.cloud), w = wx.wet;
    // sky, haze and light
    sky.material.uniforms.overcast.value = c;
    const D = Daylight.st;
    scene.fog.color.lerpColors(D.fog, D.fogWet, c); scene.fog.density = FOG_D * (1 + 0.9 * c);
    sun.intensity = D.sunI * (1 - 0.62 * c); coldFill.intensity = D.fillI * (1 - 0.35 * c); hemi.intensity = D.hemiI * (1 + 0.15 * c);
    for (const [m, r] of wetMats) { m.roughness = r * (1 - 0.3 * w); m.color.setScalar(1 - 0.22 * w); }
    groundWet.value = w;
    // re-take the sky reflection when the clouds or the time of day have changed enough
    if (Math.abs(c - bakedOC) > 0.2 || (c !== bakedOC && (c === 0 || c === 1)) || Math.abs(D.day - bakedDay) > 0.08 || Math.abs(D.dusk - bakedDusk) > 0.15) {
      bakedOC = c; bakedDay = D.day; bakedDusk = D.dusk; rebakeEnv();
    }
    // rain streaks: each drop loops through a box that moves with the camera, slanted by the wind
    const r = wx.rain;
    lines.visible = r > 0.01;
    if (lines.visible) {
      mat.opacity = 0.42 * r;
      const cp = camera.position, n = Math.floor(N * r);
      for (let i = 0; i < N; i++) {
        const o = i * 6, s3 = i * 3;
        if (i >= n) { pos.fill(0, o, o + 6); continue; }
        const y = ((seed[s3 + 1] * BOX[1] - time * FALL) % BOX[1] + BOX[1]) % BOX[1], fallen = BOX[1] - y;
        const x = cp.x + ((seed[s3] * BOX[0] + fallen * WIND[0] / FALL - cp.x) % BOX[0] + BOX[0]) % BOX[0] - BOX[0] / 2;
        const z = cp.z + ((seed[s3 + 2] * BOX[2] + fallen * WIND[1] / FALL - cp.z) % BOX[2] + BOX[2]) % BOX[2] - BOX[2] / 2;
        const yy = cp.y - 7 + y;
        pos[o] = x; pos[o + 1] = yy; pos[o + 2] = z;
        pos[o + 3] = x - WIND[0] / FALL * LEN; pos[o + 4] = yy + LEN; pos[o + 5] = z - WIND[1] / FALL * LEN;
      }
      geo.attributes.position.needsUpdate = true;
      // little splashes in the sand around the hero
      splashAcc += dt * 140 * r;
      while (splashAcc > 1) {
        splashAcc--;
        const a = rand(0, 6.28), d = Math.sqrt(Math.random()) * 10, x = P.pos.x + Math.sin(a) * d, z = P.pos.z + Math.cos(a) * d;
        if (Math.hypot(x, z) > ARENA_R) continue;
        fxNorm.emit(tmpV2.set(x, groundH(x, z) + 0.03, z), tmpV.set(rand(-0.4, 0.4), rand(0.6, 1.3), rand(-0.4, 0.4)), [0.62, 0.64, 0.66], rand(0.03, 0.05), rand(0.15, 0.28), -9, 0.5, 0, 0.55);
      }
    }
    setLevel(r);
  }
  return {
    wx, update, initAudio,
    silence() { setLevel(0); },
    warm(on) { lines.visible = on; if (on) geo.setDrawRange(0, 0); else geo.setDrawRange(0, Infinity); }, // compile the rain's shader at load
    get rain() { return wx.rain; },
    get agitation() { return clamp(wx.cloud * 0.45 + wx.rain * 0.55, 0, 1); }, // how disturbed the barrier is
  };
})();

// ============================================================ night ambience: crickets
// A handful of crickets around the arena, each with its own pitch, rhythm and place in the stereo field. A chirp is a
// few very short, high pulses. They sing at night, fall silent in the rain, and stop while the game is paused.
const Ambience = (() => {
  const crickets = Array.from({ length: 5 }, (_, i) => ({ f: rand(3900, 5200), period: rand(0.55, 1.3), pulses: 2 + (Math.random() * 3 | 0), gap: rand(0.035, 0.05), pan: rand(-0.9, 0.9), vol: rand(0.5, 1), t: rand(0, 2), rest: 0 }));
  function update(dt) {
    if (!AC) return;
    const level = Daylight.st.night * (1 - Weather.rain) * (game.state === 'title' ? 0.6 : 1);
    if (level < 0.05) return;
    for (const c of crickets) {
      if ((c.t -= dt) > 0) continue;
      c.t = c.period * rand(0.85, 1.15);
      if (c.rest > 0) { c.rest--; continue; }
      if (Math.random() < 0.06) c.rest = 3 + (Math.random() * 6 | 0); // now and then one pauses for a few beats
      for (let k = 0; k < c.pulses; k++) tn({ dur: 0.02, f0: c.f, f1: c.f * 0.97, gain: 0.014 * level * c.vol, attack: 0.003, delay: k * c.gap, pan: c.pan });
    }
  }
  return { update };
})();

// ============================================================ audio (synthesized)
let AC = null, master = null, noiseBuf = null;
function initAudio() {
  if (AC) { AC.resume(); return; }
  AC = new (window.AudioContext || window.webkitAudioContext)();
  master = AC.createGain(); master.gain.value = 0.6;
  const comp = AC.createDynamicsCompressor(); master.connect(comp); comp.connect(AC.destination);
  noiseBuf = AC.createBuffer(1, AC.sampleRate * 2, AC.sampleRate);
  const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  // wind bed
  const src = AC.createBufferSource(); src.buffer = noiseBuf; src.loop = true;
  const f = AC.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 360;
  const g = AC.createGain(); g.gain.value = 0.07;
  src.connect(f).connect(g).connect(master); src.start();
  const lfo = AC.createOscillator(); lfo.frequency.value = 0.11;
  const lg = AC.createGain(); lg.gain.value = 170; lfo.connect(lg).connect(f.frequency); lfo.start();
  master.gain.value = settings.sound;
  Music.init(AC, master);
  Weather.initAudio();
}

// ============================================================ orchestral score
// An original battle theme in D minor, written as MIDI note numbers and performed with sampled
// General MIDI instruments (FluidR3_GM soundfont, CC-BY 3.0, via gleitz/midi-js-soundfonts):
// string ensemble, pizzicato, harp, nylon-string "lute", French horn, trumpet, recorder,
// timpani, taiko war drums and toms. Samples stream in the background; the game never waits on them.
const Music = (() => {
  const SF = 'https://gleitz.github.io/midi-js-soundfonts/FluidR3_GM/';
  // name: [soundfont file, lowest midi, highest midi] — only notes the score uses get decoded
  const INST = {
    strings: ['string_ensemble_1', 28, 84], choir: ['choir_aahs', 48, 76], harp: ['orchestral_harp', 38, 86],
    lute: ['acoustic_guitar_nylon', 40, 79], pizz: ['pizzicato_strings', 26, 55], drum: ['taiko_drum', 33, 45],
    timp: ['timpani', 31, 45], horn: ['french_horn', 38, 70], recorder: ['recorder', 57, 82], bell: ['tubular_bells', 60, 72],
  };
  const ORDER = ['strings', 'choir', 'harp', 'recorder', 'drum', 'lute', 'timp', 'horn', 'pizz', 'bell'];
  const NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
  const noteName = n => NAMES[n % 12] + (Math.floor(n / 12) - 1);
  let ctx, out, layers = {}, nextT = 0, step = 0, on = true, vol = 0.8, ducked = false;
  const banks = {}; // inst -> Map(midi -> AudioBuffer)
  // Slow, dark and modal: D minor with Phrygian E-flat colour, long drones, sparse plucked voices.
  const BPM = 62, S16 = 60 / BPM / 4, LOOP = 256;
  const CH = {
    Dm: [38, 50, 57, 62, 65], Eb: [39, 51, 58, 63, 67], A: [33, 45, 57, 61, 64], Asus: [33, 45, 57, 62, 64],
    Gm: [31, 43, 58, 62, 67], Bb: [34, 46, 58, 62, 65],
    C: [36, 48, 55, 60, 64],
  };
  const PROG = [['Dm', 'Dm', 'Eb', 'Dm', 'Gm', 'Eb', 'A', 'A'], ['Gm', 'Gm', 'Bb', 'Eb', 'Dm', 'Gm', 'Asus', 'A']];
  // [beat, beats, midi] per bar — long, falling phrases
  const MEL = [[
    [[0, 2, 69], [2, 2, 65]],
    [[0, 3, 62], [3, 1, 64]],
    [[0, 2, 65], [2, 1, 63], [3, 1, 62]],
    [[0, 4, 62]],
    [[0, 2, 67], [2, 2, 70]],
    [[0, 2, 67], [2, 2, 63]],
    [[0, 2, 64], [2, 2, 61]],
    [[0, 4, 62]],
  ], [
    [[0, 4, 62]],
    [[0, 2, 67], [2, 1, 65], [3, 1, 63]],
    [[0, 3, 65], [3, 1, 62]],
    [[0, 4, 63]],
    [[0, 2, 62], [2, 2, 69]],
    [[0, 2, 70], [2, 2, 67]],
    [[0, 4, 64]],
    [[0, 2, 61], [2, 2, 57]],
  ]];
  const HARP_STEPS = [0, 6, 10]; // a slow, broken chord each bar
  const SUSTAIN = new Set(['strings', 'choir', 'horn', 'recorder']);

  function impulse() {
    const len = ctx.sampleRate * 5, b = ctx.createBuffer(2, len, ctx.sampleRate); // long, cavernous tail
    for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.4); }
    return b;
  }
  async function loadInst(key) {
    const [file, lo, hi] = INST[key];
    const txt = await (await fetch(SF + file + '-mp3.js')).text();
    const want = new Set(); for (let n = lo; n <= hi; n++) want.add(noteName(n));
    const map = new Map(), jobs = [];
    const re = /"([A-G]b?-?\d)":\s*"data:audio\/mp3;base64,([^"]+)"/g;
    let m;
    while ((m = re.exec(txt))) {
      if (!want.has(m[1])) continue;
      const name = m[1], b64 = m[2];
      const midi = NAMES.indexOf(name.replace(/-?\d+$/, '')) + (parseInt(name.match(/-?\d+$/)[0], 10) + 1) * 12;
      const bin = atob(b64), u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      jobs.push(ctx.decodeAudioData(u8.buffer).then(buf => map.set(midi, buf)).catch(() => {}));
    }
    await Promise.all(jobs);
    banks[key] = map;
  }
  async function loadAll(onProgress) {
    let done = 0;
    for (const k of ORDER) {
      try { await loadInst(k); } catch (e) { console.warn('music: could not load', k, e); }
      onProgress?.(++done / ORDER.length);
    }
    console.info(`music: ${Object.values(banks).filter(b => b.size).length}/${ORDER.length} instruments ready`);
  }
  function init(c, dest) {
    if (ctx) return;
    ctx = c; out = ctx.createGain(); out.gain.value = vol; out.connect(dest);
    const rev = ctx.createConvolver(); rev.buffer = impulse();
    const wet = ctx.createGain(); wet.gain.value = 0.6; rev.connect(wet).connect(out);
    for (const [k, send] of [['strings', 0.7], ['choir', 0.9], ['harp', 0.8], ['lute', 0.6], ['low', 0.4], ['brass', 0.6], ['calm', 0.8], ['perc', 0.5]]) {
      const g = ctx.createGain(); g.gain.value = 0; g.connect(out);
      const s = ctx.createGain(); s.gain.value = send; g.connect(s).connect(rev);
      layers[k] = g;
    }
    nextT = ctx.currentTime + 0.15;
    setInterval(tick, 40);
    loadAll();
  }
  // play a sampled note; picks the nearest decoded sample and repitches it
  function play(inst, layer, n, t, dur, vel, release = 0.25, attack = 0.005) {
    const bank = banks[inst]; if (!bank || !bank.size) return;
    let buf = bank.get(n), sn = n;
    if (!buf) { let best = 1e9; for (const [k, b] of bank) if (Math.abs(k - n) < best) { best = Math.abs(k - n); buf = b; sn = k; } }
    const rate = Math.pow(2, (n - sn) / 12);
    const src = ctx.createBufferSource(); src.buffer = buf; src.playbackRate.value = rate;
    // sustained instruments loop the steady middle of the sample so long drones never run out
    const sustain = SUSTAIN.has(inst) && dur > (buf.duration - 0.5) / rate;
    if (sustain) { src.loop = true; src.loopStart = 0.9; src.loopEnd = buf.duration - 0.35; }
    const g = ctx.createGain(), end = t + (sustain ? dur : Math.min(dur, buf.duration / rate));
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(vel, t + attack);
    g.gain.setValueAtTime(vel, end); g.gain.exponentialRampToValueAtTime(0.0001, end + release);
    src.connect(g).connect(layers[layer]); src.start(t); src.stop(end + release + 0.05);
  }
  // DAY: the original calm theme — drones, harp, a lone lute, the recorder's slow falling melody
  function dayScore(s, t) {
    const bar = Math.floor(s / 16), sec = bar < 8 ? 0 : 1, bi = bar % 8, p = s % 16;
    const ch = CH[PROG[sec][bi]], barLen = 16 * S16, up = ch.slice(2);
    if (p === 0) {
      // low drone: root + fifth in the basses, always present
      play('strings', 'strings', ch[0], t, barLen + 0.4, 0.34, 1.6, 0.9);
      play('strings', 'strings', ch[1], t, barLen + 0.4, 0.22, 1.6, 0.9);
      // upper strings and choir swell in slowly
      for (const n of up) play('strings', 'strings', n, t + 0.1, barLen, 0.13, 1.8, 1.4);
      for (const n of up.slice(0, 2)) play('choir', 'choir', n, t + 0.3, barLen, 0.16, 1.8, 1.6);
      if (bi === 0) play('bell', 'harp', sec ? 62 : 69, t, 4, 0.16, 3); // a distant bell at each phrase
    }
    // sparse harp: a slow broken chord, high and quiet
    const hi = HARP_STEPS.indexOf(p);
    if (hi >= 0) play('harp', 'harp', [ch[1] + 12, up[0] + 12, up[1] + 12][hi], t, 3, 0.32, 2.2);
    // a lone lute plucking in the gaps
    if ((bi % 2 === 1 && p === 8) || (bi === 3 && p === 12)) play('lute', 'lute', up[2] - 12, t, 2.5, 0.3, 1.2);
    // slow melody: recorder alone when calm, low horns join it in a fight
    for (const [beat, len, n] of MEL[sec][bi]) {
      if (beat * 4 !== p) continue;
      const d = len * 4 * S16 * 0.97;
      play('recorder', 'calm', n, t, d, 0.26, 0.9, 0.18);
      play('horn', 'brass', n - 12, t, d, 0.38, 1.0, 0.25);
    }
  }

  // NIGHT: darker and emptier. A hushed string drone, the choir breathing in and out every other bar, harp notes falling
  // slowly like drops, a far-off bell, and the recorder only now and then, an octave up and twice as slow.
  const NPROG = [['Dm', 'Bb', 'Gm', 'Dm', 'Eb', 'Bb', 'Asus', 'A'], ['Gm', 'Dm', 'Eb', 'Bb', 'Gm', 'Eb', 'Asus', 'Dm']];
  const NMEL = [[[0, 8, 74]], [], [[0, 4, 70], [4, 4, 69]], [], [[0, 8, 67]], [], [[0, 4, 69], [4, 4, 73]], []];
  function nightScore(s, t) {
    const bar = Math.floor(s / 16), sec = bar < 8 ? 0 : 1, bi = bar % 8, p = s % 16;
    const ch = CH[NPROG[sec][bi]], barLen = 16 * S16;
    if (p === 0) {
      play('strings', 'strings', ch[0], t, barLen + 0.6, 0.26, 2.2, 1.6);
      play('strings', 'strings', ch[2], t + 0.4, barLen, 0.08, 2.2, 2.0);
      if (bi % 2 === 0) for (const n of ch.slice(2, 4)) play('choir', 'choir', n, t + 0.5, barLen * 2 - 0.6, 0.13, 2.6, 2.4);
      if (bi === 4) play('bell', 'harp', sec ? 57 : 62, t + 0.3, 5, 0.1, 4);
    }
    // falling harp drops: a slow descending broken chord on alternate bars
    if (bi % 2 === 1 && p % 4 === 0) play('harp', 'harp', [ch[4] + 12, ch[3] + 12, ch[2] + 12, ch[1] + 12][p / 4], t, 4, 0.22, 3);
    // the recorder, rarely, half as fast and an octave up
    if (sec === 1 || bi % 4 < 2) for (const [st8, len, n] of NMEL[bi]) if (st8 * 2 === p) play('recorder', 'calm', n, t, len * 2 * S16 * 0.97, 0.16, 1.4, 0.3);
    // a soft, low pluck like a distant footstep
    if (p === 10 && bi % 4 === 3) play('pizz', 'low', ch[0], t, S16 * 4, 0.2, 0.8);
  }

  // COMBAT: Gothic-style battle music. A Phrygian D minor that drives: staccato low strings on every eighth note, war
  // drums on the beat with off-beat answers, horn calls over held brass chords, and a timpani roll into each new phrase.
  const FPROG = [['Dm', 'Dm', 'C', 'Bb', 'Dm', 'Eb', 'C', 'A'], ['Gm', 'Gm', 'Eb', 'Bb', 'Dm', 'Eb', 'Asus', 'A']];
  const FCALL = [[0, 62], [2, 65], [3, 64], [4, 62], [8, 69], [12, 67], [14, 65]]; // a horn call, every other bar
  function fightScore(s, t) {
    const bar = Math.floor(s / 16), sec = bar < 8 ? 0 : 1, bi = bar % 8, p = s % 16;
    const ch = CH[FPROG[sec][bi]], barLen = 16 * S16;
    if (p === 0) {
      play('strings', 'strings', ch[0], t, barLen + 0.2, 0.3, 0.8, 0.3);
      for (const n of ch.slice(2)) play('strings', 'strings', n + 12, t, barLen, 0.1, 1.0, 0.6);   // high, tense strings
      play('horn', 'brass', ch[1], t, barLen, 0.26, 1.0, 0.5);
      if (bi === 0) for (const n of ch.slice(2, 4)) play('choir', 'choir', n, t, barLen * 2, 0.16, 1.5, 0.8);
    }
    // the drive: staccato eighths on the root, jumping the octave on the off-beats
    if (p % 2 === 0) play('pizz', 'low', ch[0] + (p % 4 === 2 ? 12 : 0), t, S16 * 1.5, p % 4 === 0 ? 0.5 : 0.34, 0.25);
    // war drums: the beat, with answers on the off-beats
    if (p % 4 === 0) play('drum', 'perc', p === 0 || p === 8 ? 36 : 33, t, 1.5, p === 0 ? 0.85 : 0.55, 0.8);
    if (p === 6 || p === 14) play('drum', 'perc', 40, t, 1, 0.35, 0.6);
    // horn call every other bar; trumpet-bright horns an octave down underneath
    if (bi % 2 === 0) for (const [at, n] of FCALL) if (at === p) { play('horn', 'brass', n, t, S16 * 2.6, 0.36, 0.5, 0.05); play('horn', 'brass', n - 12, t, S16 * 2.6, 0.2, 0.5, 0.05); }
    // timpani roll building into the next phrase
    if (bi === 7) { if (p % 2 === 0) play('timp', 'perc', 33, t, 1.2, 0.2 + (p / 16) * 0.5, 0.6); }
    else if (p === 0 && bi % 2 === 0) play('timp', 'perc', ch[0], t, 3, 0.55, 1.2);
    if (p === 12 && bi % 4 === 3) play('bell', 'harp', 74, t, 2, 0.12, 1.5);
  }
  // themes change on a bar line, and their layers cross-fade
  const MIX = {
    day: { strings: 0.9, choir: 0.7, harp: 0.8, lute: 0.7, low: 0, brass: 0.25, calm: 0.85, perc: 0 },
    night: { strings: 0.75, choir: 0.85, harp: 0.75, lute: 0, low: 0.45, brass: 0, calm: 0.6, perc: 0 },
    fight: { strings: 0.95, choir: 0.6, harp: 0.35, lute: 0, low: 0.9, brass: 0.95, calm: 0.3, perc: 0.95 },
  };
  let theme = null, pending = 'day';
  function schedule(s, t) {
    if (s % 16 === 0 && pending !== theme) {
      theme = pending;
      for (const k in MIX[theme]) layers[k].gain.setTargetAtTime(MIX[theme][k], t, 1.2);
    }
    if (theme === 'fight') fightScore(s, t); else if (theme === 'night') nightScore(s, t); else dayScore(s, t);
  }
  function tick() {
    if (!ctx || ctx.state !== 'running') return;
    if (nextT < ctx.currentTime - 1) nextT = ctx.currentTime + 0.05;
    while (nextT < ctx.currentTime + 0.25) { schedule(step, nextT); nextT += S16; step = (step + 1) % LOOP; }
  }
  // 'day' | 'night' | 'fight'. A fight starts on the next bar line, at once; the others wait for the next phrase
  function setTheme(name) {
    if (name === pending) return;
    pending = name;
    if (name === 'fight' && ctx) step = Math.ceil(step / 16) * 16 % LOOP; // jump straight to the next bar
  }
  const apply = () => ctx && out.gain.setTargetAtTime(on ? vol * (ducked ? 0.4 : 1) : 0, ctx.currentTime, 0.15);
  return {
    init, setTheme, get theme() { return theme; },
    toggle() { on = !on; apply(); return on; },
    setVolume(v) { vol = v; apply(); },
    duck(d) { ducked = d; apply(); },
    get volume() { return vol; }, get enabled() { return on; },
  };
})();
function nz({ dur = 0.2, type = 'bandpass', f0 = 1000, f1 = f0, q = 1, gain = 0.4, attack = 0.004, delay = 0, pan = 0 }) {
  if (!AC) return;
  const t = AC.currentTime + delay;
  const s = AC.createBufferSource(); s.buffer = noiseBuf;
  const f = AC.createBiquadFilter(); f.type = type; f.Q.value = q;
  f.frequency.setValueAtTime(f0, t); f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
  const g = AC.createGain(); g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + attack); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  let out = s.connect(f).connect(g);
  if (pan && AC.createStereoPanner) { const p = AC.createStereoPanner(); p.pan.value = pan; out = out.connect(p); }
  out.connect(master); s.start(t, Math.random()); s.stop(t + dur + 0.05);
}
function tn({ dur = 0.2, type = 'sine', f0 = 440, f1 = f0, gain = 0.3, attack = 0.004, delay = 0, lp = 0, vib = 0, vibF = 25, pan = 0 }) {
  if (!AC) return;
  const t = AC.currentTime + delay;
  const o = AC.createOscillator(); o.type = type;
  o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
  let node = o;
  if (vib) { const l = AC.createOscillator(); l.frequency.value = vibF; const lg = AC.createGain(); lg.gain.value = vib; l.connect(lg).connect(o.frequency); l.start(t); l.stop(t + dur + 0.05); }
  if (lp) { const f = AC.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = lp; node.connect(f); node = f; }
  const g = AC.createGain(); g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + attack); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  let out = node.connect(g);
  if (pan && AC.createStereoPanner) { const p = AC.createStereoPanner(); p.pan.value = pan; out = out.connect(p); }
  out.connect(master); o.start(t); o.stop(t + dur + 0.05);
}
// A synthesized male voice (no recordings). The pieces that make it read as human rather than a buzzer:
//  · a glottal-pulse source whose harmonics fall off like real vocal folds (pressed/effortful = brighter),
//  · five formants at male vowel frequencies and bandwidths, morphing between vowels,
//  · slow random pitch drift, a little vibrato and loudness shimmer, baked at 10 ms resolution,
//  · aspiration noise through the same formants (a breathy "h" onset and an exhale tail),
//  · creak / vocal fry as sub-harmonic amplitude modulation (the voice "breaking"),
//  · chest resonance and a short outdoor reverb.
// pitch / amp / creak / breath are contours sampled evenly over dur.
const VOWELS = {
  a: [730, 1090, 2440, 3400, 3900], ae: [660, 1720, 2410, 3400, 3900], o: [570, 840, 2410, 3300, 3800],
  u: [320, 870, 2240, 3300, 3800], uh: [520, 1190, 2390, 3350, 3850], e: [530, 1840, 2480, 3400, 3900],
  n: [260, 1050, 2300, 3300, 3800], // clenched hum
};
const FBW = [70, 95, 130, 230, 300], FG = [1, 0.72, 0.36, 0.2, 0.12];
let voiceRig = null;
function getVoiceRig() {
  if (voiceRig && voiceRig.ac === AC) return voiceRig;
  const wave = tilt => { const N = 48, re = new Float32Array(N), im = new Float32Array(N); for (let k = 1; k < N; k++) im[k] = Math.pow(k, -tilt) * (k % 2 ? 1 : 0.85); return AC.createPeriodicWave(re, im); };
  const ir = AC.createBuffer(2, AC.sampleRate * 0.9, AC.sampleRate);
  for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c); for (let i = 0; i < d.length; i++) { const t = i / AC.sampleRate; d[i] = (Math.random() * 2 - 1) * Math.exp(-t * 6) * (t < 0.012 ? 0 : 1); } }
  const verb = AC.createConvolver(); verb.buffer = ir; const wet = AC.createGain(); wet.gain.value = 0.16; verb.connect(wet).connect(master);
  voiceRig = { ac: AC, soft: wave(1.9), pressed: wave(1.25), verb };
  return voiceRig;
}
function voice({ dur, pitch, amp, vowels = ['uh'], creak = [0], breath = [0.15], effort = 0.5, gain = 0.5, delay = 0 }) {
  if (!AC) return;
  const rig = getVoiceRig(), t = AC.currentTime + delay, n = Math.max(8, Math.round(dur * 100));
  const at = (arr, u) => { const x = u * (arr.length - 1), j = Math.min(arr.length - 2, Math.floor(x)); return arr.length < 2 ? arr[0] : lerp(arr[j], arr[j + 1], x - j); };
  let drift = 0;
  const f0 = new Float32Array(n), env = new Float32Array(n), sub = new Float32Array(n), cr = new Float32Array(n), br = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1);
    drift = drift * 0.9 + (Math.random() - 0.5) * 0.012;                       // slow, wandering pitch instability
    const vib = Math.sin(i * 0.01 * 2 * Math.PI * 5.6) * 0.007 * Math.min(1, u * 4); // vibrato settles in after the attack
    f0[i] = at(pitch, u) * (1 + drift + vib); sub[i] = f0[i] * 0.5;
    env[i] = at(amp, u) * (1 + (Math.random() - 0.5) * 0.12) * gain;           // shimmer
    cr[i] = Math.min(0.95, at(creak, u)); br[i] = at(breath, u) * gain;
  }
  env[0] = 0; env[n - 1] = 0;
  const end = t + dur + 0.05;
  // glottal source, amplitude-modulated at half the pitch for creak
  const src = AC.createOscillator(); src.setPeriodicWave(effort > 0.6 ? rig.pressed : rig.soft); src.frequency.setValueCurveAtTime(f0, t, dur);
  const am = AC.createGain(); am.gain.setValueCurveAtTime(cr.map(c => 1 - c * 0.5), t, dur);
  const subO = AC.createOscillator(); subO.type = 'sine'; subO.frequency.setValueCurveAtTime(sub, t, dur);
  const subG = AC.createGain(); subG.gain.setValueCurveAtTime(cr.map(c => c * 0.5), t, dur);
  subO.connect(subG).connect(am.gain); src.connect(am);
  const shaper = AC.createWaveShaper(), k = 1 + effort * 2.5; // vocal strain, kept gentle
  shaper.curve = Float32Array.from({ length: 1024 }, (_, i) => { const x = i / 511.5 - 1; return Math.tanh(k * x) / Math.tanh(k); });
  const vEnv = AC.createGain(); vEnv.gain.setValueCurveAtTime(env, t, dur);
  am.connect(shaper).connect(vEnv);
  // aspiration through the same vocal tract
  const nsrc = AC.createBufferSource(); nsrc.buffer = noiseBuf; nsrc.loop = true;
  const nhp = AC.createBiquadFilter(); nhp.type = 'highpass'; nhp.frequency.value = 400;
  const nEnv = AC.createGain(); nEnv.gain.setValueCurveAtTime(br, t, dur);
  nsrc.connect(nhp).connect(nEnv);
  // formant bank
  const tract = AC.createGain(); tract.gain.value = 1;
  const vs = vowels.map(v => VOWELS[v]);
  for (let fi = 0; fi < 5; fi++) {
    const curve = Float32Array.from({ length: n }, (_, i) => at(vs.map(f => f[fi]), i / (n - 1)) * (1 + effort * 0.06 * (fi === 0 ? 1 : 0)));
    const bp = AC.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = curve[0] / FBW[fi];
    bp.frequency.setValueCurveAtTime(curve, t, dur);
    const g = AC.createGain(); g.gain.value = FG[fi] * 6;
    vEnv.connect(bp); nEnv.connect(bp); bp.connect(g).connect(tract);
  }
  const chest = AC.createBiquadFilter(); chest.type = 'lowshelf'; chest.frequency.value = 280; chest.gain.value = 5;
  const air = AC.createBiquadFilter(); air.type = 'lowpass'; air.frequency.value = 5200;
  tract.connect(chest).connect(air);
  air.connect(master); air.connect(rig.verb);
  for (const o of [src, subO]) { o.start(t); o.stop(end); }
  nsrc.start(t, Math.random() * 1.5); nsrc.stop(end);
}
const SFX = {
  swing(step) { nz({ dur: 0.2 + step * 0.03, f0: 450, f1: 2600 + step * 300, q: 1.3, gain: 0.3 + step * 0.04 }); nz({ dur: 0.15, type: 'highpass', f0: 3500, f1: 6500, gain: 0.05 }); },
  hit(heavy) {
    tn({ dur: 0.18, f0: 150, f1: 45, gain: 0.9 });
    nz({ dur: 0.14, type: 'lowpass', f0: 2000, f1: 300, gain: 0.6 });
    nz({ dur: 0.1, f0: 700, f1: 260, q: 3, gain: 0.4, delay: 0.012 });
    if (heavy) { tn({ dur: 0.35, f0: 95, f1: 32, gain: 0.8 }); nz({ dur: 0.25, type: 'lowpass', f0: 900, f1: 120, gain: 0.5 }); }
  },
  block() {
    [640, 1490, 2380, 3720].forEach((f, i) => tn({ dur: 0.55 - i * 0.09, f0: f * rand(0.97, 1.03), f1: f * 0.985, gain: 0.16 / (i + 1) + 0.04, attack: 0.002 }));
    nz({ dur: 0.08, type: 'highpass', f0: 2500, f1: 5200, gain: 0.35 });
  },
  screech(p = 1) {
    tn({ dur: 0.65, type: 'sawtooth', f0: 1150 * p, f1: 480 * p, gain: 0.2, lp: 2600, vib: 90, vibF: 31 });
    tn({ dur: 0.55, type: 'square', f0: 760 * p, f1: 330 * p, gain: 0.08, lp: 1800, vib: 60, vibF: 23, delay: 0.03 });
    nz({ dur: 0.5, f0: 2200, f1: 1200, q: 2, gain: 0.12 });
  },
  squawk(p = 1) {
    tn({ dur: 0.2, type: 'sawtooth', f0: 1350 * p, f1: 760 * p, gain: 0.18, lp: 2800, vib: 70, vibF: 40 });
    nz({ dur: 0.15, f0: 1800, f1: 1100, q: 2, gain: 0.1 });
  },
  snap() { nz({ dur: 0.07, f0: 3200, f1: 1500, q: 3, gain: 0.25 }); tn({ dur: 0.05, f0: 900, f1: 500, gain: 0.1 }); },
  hurt(heavy, variant = (Math.random() * 4) | 0) {
    nz({ dur: 0.16, type: 'lowpass', f0: 900, f1: 260, gain: 0.32 });
    const p = rand(0.9, 1.1), d = 0.03;
    if (heavy) { // "HAAGH-hh": a pained cry forced out, cracking at the end, then a ragged breath out
      voice({ dur: 0.85, pitch: [165 * p, 250 * p, 265 * p, 230 * p, 170 * p, 130 * p], amp: [0, 0.9, 1, 0.85, 0.45, 0.15, 0], vowels: ['ae', 'a', 'a', 'a', 'uh', 'uh'],
        creak: [0.1, 0, 0, 0.15, 0.5, 0.8], breath: [0.9, 0.2, 0.12, 0.15, 0.35, 0.6, 0.3], effort: 0.8, gain: 0.36, delay: d });
      return;
    }
    [
      () => voice({ dur: 0.34, pitch: [118 * p, 148 * p, 132 * p, 100 * p], amp: [0, 1, 0.7, 0.2, 0], vowels: ['uh', 'uh', 'u'],           // "uhh!" punched out of the gut
        creak: [0.2, 0, 0.3, 0.7], breath: [0.8, 0.15, 0.25, 0.5, 0.2], effort: 0.5, gain: 0.49, delay: d }),
      () => voice({ dur: 0.42, pitch: [150 * p, 195 * p, 175 * p, 128 * p], amp: [0, 1, 0.85, 0.35, 0], vowels: ['a', 'a', 'uh'],             // "agh!"
        creak: [0, 0, 0.25, 0.75], breath: [0.6, 0.12, 0.2, 0.5, 0.2], effort: 0.65, gain: 0.5, delay: d }),
      () => voice({ dur: 0.36, pitch: [112 * p, 128 * p, 120 * p, 96 * p], amp: [0, 0.8, 1, 0.4, 0], vowels: ['n', 'n', 'uh'],              // "hnngh" through clenched teeth
        creak: [0.3, 0.2, 0.4, 0.8], breath: [0.5, 0.35, 0.3, 0.5, 0.2], effort: 0.55, gain: 0.21, delay: d }),
      () => voice({ dur: 0.26, pitch: [135 * p, 120 * p, 98 * p], amp: [0, 0.6, 1, 0.3, 0], vowels: ['u', 'u', 'uh'],                         // "hoof" — winded
        creak: [0, 0.2, 0.6], breath: [1.4, 0.9, 0.3, 0.4, 0.15], effort: 0.35, gain: 0.32, delay: d }),
    ][variant]();
  },
  // death scream: a long, raw cry that strains, breaks, and collapses into a dying groan and a last breath
  scream() {
    const p = rand(0.93, 1.07);
    voice({ dur: 1.9, pitch: [190 * p, 300 * p, 345 * p, 360 * p, 340 * p, 300 * p, 230 * p, 165 * p], amp: [0, 0.85, 1, 1, 0.95, 0.8, 0.5, 0.2, 0],
      vowels: ['ae', 'a', 'a', 'a', 'a', 'o', 'uh'], creak: [0.05, 0, 0, 0.1, 0.2, 0.45, 0.75, 0.9], breath: [1.0, 0.18, 0.12, 0.12, 0.18, 0.3, 0.5, 0.6, 0.3], effort: 1, gain: 0.39 });
    voice({ dur: 1.5, pitch: [118 * p, 108 * p, 96 * p, 84 * p, 78 * p], amp: [0, 0.7, 0.55, 0.3, 0.1, 0], vowels: ['uh', 'o', 'u', 'u'],
      creak: [0.6, 0.7, 0.85, 0.95], breath: [0.4, 0.3, 0.45, 0.8, 0.5, 0.2], effort: 0.3, gain: 0.35, delay: 1.75 });
  },
  step(heavy) {
    nz({ dur: heavy ? 0.13 : 0.06, type: 'lowpass', f0: heavy ? 260 : 480, f1: 90, gain: heavy ? 0.32 : 0.09 });
    if (heavy) tn({ dur: 0.12, f0: 75, f1: 40, gain: 0.22 });
  },
  draw() { nz({ dur: 0.45, f0: 2400, f1: 7200, q: 4, gain: 0.17 }); tn({ dur: 0.7, f0: 3100, f1: 3050, gain: 0.035, delay: 0.32 }); },
  sheath() { nz({ dur: 0.35, f0: 6500, f1: 1900, q: 4, gain: 0.15 }); tn({ dur: 0.09, f0: 300, f1: 180, gain: 0.22, delay: 0.33 }); },
  thud() { tn({ dur: 0.45, f0: 85, f1: 28, gain: 0.9 }); nz({ dur: 0.35, type: 'lowpass', f0: 500, f1: 70, gain: 0.55 }); },
  dodge() { nz({ dur: 0.26, type: 'lowpass', f0: 900, f1: 180, gain: 0.25 }); },
  gong() { [98, 196.5, 247, 392.7, 523].forEach((f, i) => tn({ dur: 3.2 - i * 0.4, f0: f, f1: f * 0.995, gain: 0.22 / (i + 1), attack: 0.01 })); nz({ dur: 0.3, type: 'lowpass', f0: 600, f1: 100, gain: 0.3 }); },
  // the barrier crackling somewhere far overhead, then a low rumble rolling across the town
  zap(near = 1, pan = 0) {
    for (let i = 0, t = 0; i < 6; i++, t += rand(0.015, 0.07)) nz({ dur: rand(0.02, 0.06), type: 'highpass', f0: rand(2500, 4500), f1: 1400, gain: 0.035 * near, delay: t, pan });
    nz({ dur: 1.4, type: 'lowpass', f0: 260, f1: 50, gain: 0.08 * near, attack: 0.15, delay: rand(0.3, 0.7), pan: pan * 0.5 });
  },
  whiff() { nz({ dur: 0.22, f0: 600, f1: 1600, q: 0.8, gain: 0.18 }); },
  lockSwitch() { tn({ dur: 0.06, f0: 1900, f1: 1300, gain: 0.04 }); },
  // knocked flat on the back: the body slapping into the sand, the wind knocked out of him
  knockdown() { tn({ dur: 0.4, f0: 110, f1: 34, gain: 0.85 }); nz({ dur: 0.45, type: 'lowpass', f0: 700, f1: 90, gain: 0.6 }); this.hurt(false, 3); },
};

// ============================================================ the hero
function buildHero() {
  const M = {
    skin: phys(0xc4906f, 0.6, 0, { sheen: 0.3, sheenColor: 0xffd8c0 }),
    leather: std(0x4b3020, 0.8),
    cloth: phys(0x37362c, 0.85, 0, { sheen: 0.7, sheenColor: 0x9fb4cc, sheenRoughness: 0.45 }),
    sash: phys(0x8c2a1c, 0.8, 0, { sheen: 0.5, sheenColor: 0xd0c0c8 }),
    boot: std(0x271a10, 0.75), hair: std(0x2a1b12, 1),
    metal: std(0xd8e0ea, 0.3, 1.0, { roughnessMap: metalRough, emissive: 0x000000 }),
    steel: std(0xa4adb8, 0.85, 0.85, { roughnessMap: metalRough }),
    iron: std(0x5c6168, 1.1, 0.8, { roughnessMap: metalRough }), eye: phys(0x111111, 0.1, 0, { clearcoat: 1 }),
  };
  const root = new THREE.Group(); root.rotation.order = 'YXZ';
  const j = {};
  const hips = new THREE.Group(); hips.position.y = 0.98; root.add(hips); j.hips = hips;
  mesh(new THREE.BoxGeometry(0.34, 0.2, 0.22), M.cloth, hips);
  mesh(new THREE.BoxGeometry(0.37, 0.07, 0.25), M.sash, hips, [0, 0.09, 0]);
  mesh(new THREE.BoxGeometry(0.36, 0.22, 0.05), M.leather, hips, [0, -0.13, 0.1], [0.1, 0, 0]); // tasset front
  mesh(new THREE.BoxGeometry(0.36, 0.22, 0.05), M.leather, hips, [0, -0.13, -0.1], [-0.1, 0, 0]);
  const spine = new THREE.Group(); spine.position.y = 0.1; hips.add(spine); j.spine = spine;
  mesh(new THREE.BoxGeometry(0.4, 0.5, 0.25), M.leather, spine, [0, 0.29, 0]);
  mesh(new THREE.BoxGeometry(0.42, 0.06, 0.27), M.iron, spine, [0, 0.12, 0]);
  mesh(new THREE.BoxGeometry(0.06, 0.55, 0.27), M.sash, spine, [0.05, 0.3, 0], [0, 0, 0.55]); // shoulder strap
  for (const s of [1, -1]) mesh(sphere(0.125, 16, 12), M.steel, spine, [s * 0.24, 0.53, 0], [0, 0, 0], [1.15, 0.72, 1.05]); // pauldrons
  const neck = new THREE.Group(); neck.position.y = 0.56; spine.add(neck); j.neck = neck;
  mesh(new THREE.CylinderGeometry(0.055, 0.065, 0.12, 8), M.skin, neck, [0, 0.05, 0]);
  const head = new THREE.Group(); head.position.y = 0.12; neck.add(head);
  mesh(sphere(0.12, 16, 12), M.skin, head, [0, 0.09, 0.01], [0, 0, 0], [0.95, 1.12, 1.05]);
  mesh(new THREE.SphereGeometry(0.132, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.55), M.steel, head, [0, 0.1, -0.006], [-0.2, 0, 0]); // skullcap
  mesh(new THREE.BoxGeometry(0.022, 0.09, 0.02), M.steel, head, [0, 0.13, 0.13]); // nasal guard
  mesh(new THREE.BoxGeometry(0.17, 0.08, 0.06), M.hair, head, [0, 0.01, 0.1], [0.2, 0, 0]); // beard
  for (const s of [1, -1]) mesh(sphere(0.016, 6, 5), M.eye, head, [s * 0.045, 0.11, 0.115]);
  mesh(new THREE.BoxGeometry(0.03, 0.05, 0.04), M.skin, head, [0, 0.07, 0.125]); // nose

  function arm(s) {
    const sh = new THREE.Group(); sh.position.set(s * 0.27, 0.5, 0); spine.add(sh);
    mesh(capsule(0.058, 0.2), M.cloth, sh, [0, -0.15, 0]);
    const el = new THREE.Group(); el.position.y = -0.3; sh.add(el);
    mesh(capsule(0.05, 0.18), M.skin, el, [0, -0.13, 0]);
    mesh(new THREE.CylinderGeometry(0.064, 0.057, 0.16, 12), M.steel, el, [0, -0.17, 0]); // vambrace
    const ha = new THREE.Group(); ha.position.y = -0.28; el.add(ha);
    mesh(sphere(0.055, 8, 6), M.skin, ha, [0, 0, 0.01], [0, 0, 0], [1, 1.1, 1.2]);
    return [sh, el, ha];
  }
  [j.lSh, j.lEl, j.lHa] = arm(1);
  [j.rSh, j.rEl, j.rHa] = arm(-1);
  function leg(s) {
    const hp = new THREE.Group(); hp.position.set(s * 0.1, -0.04, 0); hips.add(hp);
    mesh(capsule(0.078, 0.28), M.cloth, hp, [0, -0.21, 0]);
    const kn = new THREE.Group(); kn.position.y = -0.44; hp.add(kn);
    mesh(capsule(0.062, 0.26), M.boot, kn, [0, -0.2, 0]);
    mesh(new THREE.BoxGeometry(0.11, 0.07, 0.24), M.boot, kn, [0, -0.43, 0.05]);
    return [hp, kn];
  }
  [j.lHip, j.lKn] = leg(1);
  [j.rHip, j.rKn] = leg(-1);

  // sword — blade along local +Z, grip at origin
  const sword = new THREE.Group();
  mesh(new THREE.CylinderGeometry(0.019, 0.021, 0.2, 8), M.leather, sword, [0, 0, 0.0], [Math.PI / 2, 0, 0]);
  mesh(sphere(0.034, 8, 6), M.iron, sword, [0, 0, -0.115]);
  mesh(new THREE.BoxGeometry(0.24, 0.035, 0.045), M.iron, sword, [0, 0, 0.11]);
  mesh(new THREE.BoxGeometry(0.052, 0.012, 0.86), M.metal, sword, [0, 0, 0.56]);
  mesh(new THREE.BoxGeometry(0.014, 0.016, 0.8), M.iron, sword, [0, 0, 0.53]); // fuller
  const tip = mesh(new THREE.ConeGeometry(0.026, 0.1, 4), M.metal, sword, [0, 0, 1.04], [Math.PI / 2, 0, 0]);
  tip.scale.set(1, 1, 0.25);
  const swordTip = new THREE.Object3D(); swordTip.position.z = 1.05; sword.add(swordTip);
  const swordBase = new THREE.Object3D(); swordBase.position.z = 0.2; sword.add(swordBase);
  const swordMid = new THREE.Object3D(); swordMid.position.z = 0.6; sword.add(swordMid);

  const sheath = new THREE.Group(); sheath.position.set(0.22, 0.02, -0.04); sheath.rotation.set(2.45, 0, -0.12); hips.add(sheath);
  mesh(new THREE.BoxGeometry(0.075, 0.03, 0.9), M.leather, sheath, [0, 0, 0.58]);
  mesh(new THREE.BoxGeometry(0.085, 0.04, 0.06), M.iron, sheath, [0, 0, 1.0]);
  sheath.add(sword);
  root.traverse(o => { if (o.isMesh) o.castShadow = true; });
  return { root, j, sword, swordTip, swordBase, swordMid, sheath, bladeMat: M.metal };
}

// pose system
const PJ = ['spine', 'neck', 'lSh', 'lEl', 'rSh', 'rEl', 'rHa', 'lHip', 'lKn', 'rHip', 'rKn', 'hipR'];
function pose(o) { const p = { hy: o.hy ?? 0 }; for (const k of PJ) p[k] = o[k] ? o[k].slice() : [0, 0, 0]; return p; }
function blend(a, b, t) {
  const o = { hy: lerp(a.hy, b.hy, t) };
  for (const k of PJ) { const x = a[k], y = b[k]; o[k] = [lerp(x[0], y[0], t), lerp(x[1], y[1], t), lerp(x[2], y[2], t)]; }
  return o;
}
const POSE = {
  relaxed: pose({ lSh: [0.05, 0, 0.1], rSh: [0.05, 0, -0.1], lEl: [-0.15, 0, 0], rEl: [-0.15, 0, 0] }),
  stance: pose({ spine: [0.1, 0.22, 0], neck: [0, -0.2, 0], rSh: [-0.55, 0, -0.25], rEl: [-1.0, 0, 0], rHa: [0.45, 0, 0], lSh: [-0.35, 0, 0.28], lEl: [-0.9, 0, 0], lHip: [-0.32, 0, 0.06], lKn: [0.42, 0, 0], rHip: [0.25, 0, -0.08], rKn: [0.35, 0, 0], hy: -0.05 }),
  draw: pose({ spine: [0.12, 0.45, 0], neck: [0, -0.4, 0], rSh: [-0.45, 0, 0.75], rEl: [-1.35, 0, 0], lSh: [0.1, 0, 0.3], lEl: [-0.4, 0, 0], hy: -0.03 }),
  chopW: pose({ spine: [-0.25, 0.15, 0], neck: [0.12, -0.1, 0], rSh: [-2.8, 0, -0.25], rEl: [-1.2, 0, 0], rHa: [0.1, 0, 0], lSh: [-0.6, 0, 0.3], lEl: [-1.0, 0, 0], lHip: [-0.3, 0, 0.06], lKn: [0.3, 0, 0], rHip: [0.3, 0, -0.08], rKn: [0.3, 0, 0], hy: -0.02 }),
  chopS: pose({ spine: [0.5, -0.05, 0], neck: [-0.35, 0, 0], rSh: [-1.05, 0, -0.05], rEl: [-0.1, 0, 0], rHa: [1.05, 0, 0], lSh: [0.4, 0, 0.35], lEl: [-0.5, 0, 0], lHip: [-0.75, 0, 0.06], lKn: [0.75, 0, 0], rHip: [0.45, 0, -0.08], rKn: [0.25, 0, 0], hy: -0.16 }),
  rlW: pose({ spine: [0.05, -1.1, 0], neck: [0, 1.0, 0], rSh: [-0.35, 0, -1.35], rEl: [-0.7, 0, 0], rHa: [0.2, 0, 0], lSh: [-0.8, 0, 0.5], lEl: [-1.0, 0, 0], lHip: [-0.3, 0, 0.06], lKn: [0.35, 0, 0], rHip: [0.3, 0, -0.06], rKn: [0.35, 0, 0], hy: -0.06 }),
  rlS: pose({ spine: [0.2, 1.05, 0], neck: [0, -0.95, 0], rSh: [-0.3, 0, -1.3], rEl: [-0.15, 0, 0], rHa: [0.1, 0, 0], lSh: [0.2, 0, 0.6], lEl: [-0.4, 0, 0], lHip: [-0.6, 0, 0.06], lKn: [0.6, 0, 0], rHip: [0.4, 0, -0.06], rKn: [0.3, 0, 0], hy: -0.14 }),
  lrW: pose({ spine: [0.05, 1.0, 0], neck: [0, -0.9, 0], rSh: [-1.3, 0, 0.55], rEl: [-1.5, 0, 0], rHa: [0.3, 0, 0], lSh: [-0.2, 0, 0.4], lEl: [-0.6, 0, 0], lHip: [-0.3, 0, 0.06], lKn: [0.35, 0, 0], rHip: [0.3, 0, -0.06], rKn: [0.35, 0, 0], hy: -0.06 }),
  lrS: pose({ spine: [0.2, -1.05, 0], neck: [0, 0.95, 0], rSh: [-0.35, 0, -1.45], rEl: [-0.1, 0, 0], rHa: [0.0, 0, 0], lSh: [-0.7, 0, 0.5], lEl: [-0.9, 0, 0], lHip: [-0.6, 0, 0.06], lKn: [0.6, 0, 0], rHip: [0.4, 0, -0.06], rKn: [0.3, 0, 0], hy: -0.14 }),
  heavyW: pose({ spine: [-0.42, 0.35, 0], neck: [0.2, -0.3, 0], rSh: [-3.05, 0, -0.3], rEl: [-1.35, 0, 0], rHa: [0.0, 0, 0], lSh: [-2.6, 0, -0.2], lEl: [-1.2, 0, 0], lHip: [-0.4, 0, 0.06], lKn: [0.25, 0, 0], rHip: [0.35, 0, -0.08], rKn: [0.2, 0, 0], hy: 0.02 }),
  heavyS: pose({ spine: [0.75, -0.1, 0], neck: [-0.5, 0, 0], rSh: [-0.95, 0, 0.0], rEl: [-0.05, 0, 0], rHa: [1.25, 0, 0], lSh: [-0.9, 0, -0.3], lEl: [-0.2, 0, 0], lHip: [-0.95, 0, 0.06], lKn: [1.15, 0, 0], rHip: [0.6, 0, -0.08], rKn: [0.5, 0, 0], hy: -0.3 }),
  // weaving cut: down across to the left, the wrist rolls the blade over high on the left, then down across to the right
  waveW: pose({ spine: [-0.1, -0.95, 0], neck: [0.05, 0.85, 0], rSh: [-1.9, 0, -0.9], rEl: [-1.0, 0, 0], rHa: [0.2, 0, 0], lSh: [-0.7, 0, 0.5], lEl: [-1.0, 0, 0], lHip: [-0.3, 0, 0.06], lKn: [0.35, 0, 0], rHip: [0.3, 0, -0.06], rKn: [0.35, 0, 0], hy: -0.04 }),
  wave1: pose({ spine: [0.3, 0.7, 0], neck: [-0.15, -0.6, 0], rSh: [-0.45, 0, -0.5], rEl: [-0.15, 0, 0], rHa: [0.85, 0, 0], lSh: [0.1, 0, 0.55], lEl: [-0.5, 0, 0], lHip: [-0.55, 0, 0.06], lKn: [0.6, 0, 0], rHip: [0.4, 0, -0.06], rKn: [0.3, 0, 0], hy: -0.13 }),
  waveM: pose({ spine: [-0.05, 0.95, 0], neck: [0.05, -0.85, 0], rSh: [-2.0, 0, 0.45], rEl: [-1.3, 0, 0], rHa: [0.25, 0, 0], lSh: [-0.3, 0, 0.45], lEl: [-0.7, 0, 0], lHip: [-0.4, 0, 0.06], lKn: [0.45, 0, 0], rHip: [0.35, 0, -0.06], rKn: [0.35, 0, 0], hy: -0.07 }),
  wave2: pose({ spine: [0.32, -0.95, 0], neck: [-0.15, 0.85, 0], rSh: [-0.5, 0, -1.35], rEl: [-0.1, 0, 0], rHa: [0.8, 0, 0], lSh: [-0.6, 0, 0.5], lEl: [-0.9, 0, 0], lHip: [-0.65, 0, 0.06], lKn: [0.7, 0, 0], rHip: [0.42, 0, -0.06], rKn: [0.3, 0, 0], hy: -0.16 }),
  // turn-around strike: coil, whip the whole body through a full turn with the blade flung out level, land the cut
  spinW: pose({ spine: [0.15, 0.85, 0], neck: [0, -0.5, 0], rSh: [-0.9, 0, 0.7], rEl: [-1.5, 0, 0], rHa: [0.3, 0, 0], lSh: [-0.3, 0, 0.6], lEl: [-0.8, 0, 0], lHip: [-0.5, 0, 0.1], lKn: [0.75, 0, 0], rHip: [0.3, 0, -0.1], rKn: [0.7, 0, 0], hy: -0.2 }),
  spinA: pose({ spine: [0.1, -0.35, 0], neck: [0, 0.3, 0], rSh: [-0.15, 0, -1.5], rEl: [-0.08, 0, 0], rHa: [0.05, 0, 0], lSh: [-0.2, 0, 1.1], lEl: [-0.5, 0, 0], lHip: [-0.35, 0, 0.14], lKn: [0.55, 0, 0], rHip: [0.25, 0, -0.14], rKn: [0.5, 0, 0], hy: -0.14 }),
  spinS: pose({ spine: [0.28, -1.1, 0], neck: [-0.1, 0.95, 0], rSh: [-0.4, 0, -1.45], rEl: [-0.05, 0, 0], rHa: [0.3, 0, 0], lSh: [-0.7, 0, 0.5], lEl: [-0.9, 0, 0], lHip: [-0.75, 0, 0.08], lKn: [0.85, 0, 0], rHip: [0.45, 0, -0.08], rKn: [0.4, 0, 0], hy: -0.2 }),
  block: pose({ spine: [0.12, 0.15, 0], neck: [-0.05, -0.15, 0], rSh: [-1.25, 0, 0.25], rEl: [-1.25, 0, 0], rHa: [0.65, 1.35, 0], lSh: [-1.0, 0, 0.1], lEl: [-1.4, 0, 0], lHip: [-0.42, 0, 0.06], lKn: [0.55, 0, 0], rHip: [0.32, 0, -0.08], rKn: [0.45, 0, 0], hy: -0.1 }),
  hurt: pose({ spine: [-0.45, 0, 0.15], neck: [-0.4, 0, 0], rSh: [-0.2, 0, -0.6], rEl: [-0.6, 0, 0], lSh: [-0.1, 0, 0.7], lEl: [-0.4, 0, 0], lHip: [0.2, 0, 0], lKn: [0.4, 0, 0], rHip: [-0.3, 0, 0], rKn: [0.5, 0, 0], hy: -0.08 }),
  jumpUp: pose({ spine: [0.12, 0, 0], neck: [-0.1, 0, 0], rSh: [-0.7, 0, -0.45], rEl: [-0.9, 0, 0], lSh: [-0.6, 0, 0.5], lEl: [-0.8, 0, 0], lHip: [-1.0, 0, 0.05], lKn: [1.4, 0, 0], rHip: [-0.35, 0, -0.05], rKn: [0.7, 0, 0], hy: -0.02 }),
  jumpDown: pose({ spine: [0.05, 0, 0], neck: [0.05, 0, 0], rSh: [-0.35, 0, -0.6], rEl: [-0.6, 0, 0], lSh: [-0.25, 0, 0.65], lEl: [-0.5, 0, 0], lHip: [-0.55, 0, 0.06], lKn: [0.75, 0, 0], rHip: [-0.4, 0, -0.06], rKn: [0.6, 0, 0], hy: 0 }),
  hurtB: pose({ spine: [0.55, 0, -0.12], neck: [0.35, 0, 0], rSh: [0.5, 0, -0.7], rEl: [-0.5, 0, 0], lSh: [0.6, 0, 0.8], lEl: [-0.3, 0, 0], lHip: [-0.5, 0, 0], lKn: [0.6, 0, 0], rHip: [0.3, 0, 0], rKn: [0.3, 0, 0], hy: -0.1 }),
  down: pose({ spine: [-0.15, 0, 0.05], neck: [-0.3, 0.3, 0], rSh: [-0.4, 0, -1.2], rEl: [-0.4, 0, 0], lSh: [-0.3, 0, 1.1], lEl: [-0.6, 0, 0], lHip: [-0.6, 0, 0.12], lKn: [1.0, 0, 0], rHip: [-0.15, 0, -0.1], rKn: [0.35, 0, 0] }),
  dodge: pose({ spine: [0.32, 0, 0], neck: [-0.25, 0, 0], rSh: [-0.4, 0, -0.5], rEl: [-0.9, 0, 0], lSh: [-0.3, 0, 0.6], lEl: [-0.8, 0, 0], lHip: [-0.9, 0, 0], lKn: [1.2, 0, 0], rHip: [-0.35, 0, 0], rKn: [1.0, 0, 0], hy: -0.22 }),
  dead: pose({ spine: [-0.2, 0, 0], neck: [-0.5, 0.4, 0], rSh: [-2.6, 0, -0.6], rEl: [-0.2, 0, 0], lSh: [-2.4, 0, 0.7], lEl: [-0.3, 0, 0], lHip: [-0.2, 0, 0.1], rHip: [-0.1, 0, -0.15], lKn: [0.2, 0, 0], rKn: [0.3, 0, 0] }),
};
// seq: the poses the strike passes through. cuts: which of those segments can wound (the weaving cut lands twice).
const SWINGS = {
  chop: { w: 'chopW', seq: ['chopS'], arc: 0.6, dmg: 1.0, lunge: 1.5 },
  rl: { w: 'rlW', seq: ['rlS'], arc: 1.2, dmg: 0.9, lunge: 1.0 },
  lr: { w: 'lrW', seq: ['lrS'], arc: 1.2, dmg: 0.95, lunge: 1.0 },
  wave: { w: 'waveW', seq: ['wave1', 'waveM', 'wave2'], cuts: [0, 2], arc: 1.25, dmg: 0.7, lunge: 0.9, aMul: 2.7, slow: 1.05 },
  spin: { w: 'spinW', seq: ['spinA', 'spinS'], cuts: [0, 1], once: true, arc: 3.3, dmg: 1.4, lunge: 1.2, aMul: 2.3, wMul: 1.15, spin: true },
  heavy: { w: 'heavyW', seq: ['heavyS'], arc: 0.7, dmg: 1.75, lunge: 2.6, slow: 1.3 },
};
const COMBO = ['chop', 'rl', 'lr', 'wave', 'spin', 'heavy'];
const easeIn = t => t * t, easeOut = t => 1 - (1 - t) * (1 - t);

const hero = buildHero();
// ---- surface detail for the hero's leather and hair. The model has no texture coordinates, so the detail is projected
// from three sides (triplanar, in the part's own space) and blended by the surface's facing. It tints the colour (a
// grey texture: 0.5 = no change) and bumps the normal from the texture's slope, so grain and strands catch the light.
function detailTex(draw) {
  const s = 256, c = document.createElement('canvas'); c.width = c.height = s; const x = c.getContext('2d');
  x.fillStyle = 'rgb(128,128,128)'; x.fillRect(0, 0, s, s); draw(x, s);
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4; return t;
}
const wrapDraw = (x, s, fn) => { for (const ox of [-s, 0, s]) for (const oy of [-s, 0, s]) fn(ox, oy); }; // tileable
// Grainy leather, sized for the screen: a pebbled grain of irregular cells (5-12 mm on the model, finer than that
// only flickers), creases where it flexes, and lighter, worn scuffs.
const leatherTex = detailTex((x, s) => {
  for (let i = 0; i < 420; i++) {
    const px = rand(0, s), py = rand(0, s), r = rand(4, 9), v = rand(120, 146) | 0, q = rand(0, 3);
    wrapDraw(x, s, (ox, oy) => {
      x.fillStyle = 'rgba(78,78,78,.22)'; x.beginPath(); x.ellipse(px + ox, py + oy, r + 1.5, r * 0.8 + 1.5, q, 0, 7); x.fill();
      x.fillStyle = `rgb(${v},${v},${v})`; x.beginPath(); x.ellipse(px + ox, py + oy, r, r * 0.8, q, 0, 7); x.fill();
    });
  }
  for (let i = 0; i < 22; i++) { // creases
    const px = rand(0, s), py = rand(0, s), a = rand(0, 3.14), l = rand(40, 110);
    wrapDraw(x, s, (ox, oy) => { x.strokeStyle = `rgba(55,55,55,${rand(0.35, 0.6)})`; x.lineWidth = rand(1.8, 3.2); x.beginPath(); x.moveTo(px + ox, py + oy);
      x.quadraticCurveTo(px + ox + Math.cos(a) * l * 0.5 + rand(-14, 14), py + oy + Math.sin(a) * l * 0.5 + rand(-14, 14), px + ox + Math.cos(a) * l, py + oy + Math.sin(a) * l); x.stroke(); });
  }
  for (let i = 0; i < 14; i++) { // worn scuffs
    const px = rand(0, s), py = rand(0, s), r = rand(16, 40);
    wrapDraw(x, s, (ox, oy) => { const gr = x.createRadialGradient(px + ox, py + oy, 0, px + ox, py + oy, r); gr.addColorStop(0, 'rgba(176,176,176,.4)'); gr.addColorStop(1, 'rgba(176,176,176,0)'); x.fillStyle = gr; x.fillRect(px + ox - r, py + oy - r, 2 * r, 2 * r); });
  }
});
// Hair: tufts (1-3 cm on the model) of thick strands running down the texture, with dark gaps between the tufts.
const hairTex = detailTex((x, s) => {
  x.fillStyle = 'rgb(78,78,78)'; x.fillRect(0, 0, s, s);
  for (let k = 0; k < 34; k++) {
    const cx = rand(0, s), w = rand(10, 22), y0 = rand(0, s), len = rand(90, 200), sway = rand(-22, 22);
    for (let i = 0; i < 16; i++) {
      const px = cx + rand(-w, w) * (1 - i / 32), v = rand(130, 190) | 0, lw = rand(1.6, 3.2);
      wrapDraw(x, s, (ox, oy) => { x.strokeStyle = `rgba(${v},${v},${v},${rand(0.55, 0.9)})`; x.lineWidth = lw; x.lineCap = 'round'; x.beginPath(); x.moveTo(px + ox, y0 + oy);
        x.bezierCurveTo(px + ox + sway * 0.3, y0 + oy + len * 0.35, px + ox + sway, y0 + oy + len * 0.7, px + ox + sway * 0.7, y0 + oy + len); x.stroke(); });
    }
  }
});
function triplanarDetail(mat, tex, scale, bump, strength = 1, roughVar = 0) {
  // the bump comes from the texture's own slope (central differences in each projection), not from screen-space
  // derivatives: smooth at any resolution, no 2×2-pixel blocks
  mat.onBeforeCompile = sh => {
    sh.uniforms.tDetail = { value: tex };
    sh.vertexShader = 'varying vec3 vObjP; varying vec3 vObjN; varying vec3 vNm0; varying vec3 vNm1; varying vec3 vNm2;\n' + sh.vertexShader.replace('#include <begin_vertex>',
      '#include <begin_vertex>\n  vObjP = position; vObjN = normal; vNm0 = normalMatrix[0]; vNm1 = normalMatrix[1]; vNm2 = normalMatrix[2];');
    const S = (uv, o) => `texture2D(tDetail, ${uv} + ${o}).r`;
    sh.fragmentShader = 'uniform sampler2D tDetail; varying vec3 vObjP; varying vec3 vObjN; varying vec3 vNm0; varying vec3 vNm1; varying vec3 vNm2;\n' + sh.fragmentShader
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec3 tw = pow(abs(normalize(vObjN)), vec3(4.0)); tw /= (tw.x + tw.y + tw.z);
        vec3 tp = vObjP * ${scale.toFixed(2)};
        const vec2 e1 = vec2(1.5 / 256.0, 0.0), e2 = vec2(0.0, 1.5 / 256.0);
        float dX = ${S('tp.zy', 'vec2(0.0)')}, dY = ${S('tp.xz', 'vec2(0.0)')}, dZ = ${S('tp.xy', 'vec2(0.0)')};
        float det = dX * tw.x + dY * tw.y + dZ * tw.z;
        // object-space slope of the detail, per projection (plane zy → z,y; xz → x,z; xy → x,y)
        vec3 dn = tw.x * vec3(0.0, ${S('tp.zy', 'e2')} - ${S('tp.zy', '-e2')}, ${S('tp.zy', 'e1')} - ${S('tp.zy', '-e1')})
                + tw.y * vec3(${S('tp.xz', 'e1')} - ${S('tp.xz', '-e1')}, 0.0, ${S('tp.xz', 'e2')} - ${S('tp.xz', '-e2')})
                + tw.z * vec3(${S('tp.xy', 'e1')} - ${S('tp.xy', '-e1')}, ${S('tp.xy', 'e2')} - ${S('tp.xy', '-e2')}, 0.0);
        diffuseColor.rgb *= 1.0 + (det - 0.5) * ${(2 * strength).toFixed(2)};`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = clamp(roughnessFactor + (0.5 - det) * ${roughVar.toFixed(2)}, 0.05, 1.0);`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        normal = normalize(normal - mat3(vNm0, vNm1, vNm2) * dn * ${bump.toFixed(3)});`);
    mat.userData.extraCompile?.(sh);
  };
  mat.customProgramCacheKey = () => 'detail' + scale + bump + strength + (mat.userData.extraKey || '');
  return mat;
}

// ---- the hero's head, sculpted in code after the player's own photos (replacing the model's head, hair and beard)
// Head space: metres, +Y up, +Z the way he faces; the chin is at y ≈ -0.045, the crown at y ≈ 0.22.
// The skin is a dense sphere pushed into shape by smooth feature functions (a rounder face, a straight, prominent
// nose, modest brows, full cheeks, lips, a rounded chin, the neck). The hair and beard are shells grown out from that
// same surface wherever a mask says hair grows, tapering to nothing at the edges so they blend into the skin:
// short and dark at the back and sides, the hairline receding at the temples, a mop of loose curls on top falling
// forward with lighter tips, thick dark brows, and a full dark beard with grey on the cheeks, running down the neck.
function buildFace(head, hairMat, skinMat) {
  const lin = hex => new THREE.Color(hex);                      // colours are given in sRGB; three converts them
  const gauss = (x, y, cx, cy, sx, sy) => Math.exp(-(((x - cx) / sx) ** 2 + ((y - cy) / sy) ** 2));
  const interp = (tab, t) => { for (let i = 1; i < tab.length; i++) if (t <= tab[i][0]) { const [a, va] = tab[i - 1], [b, vb] = tab[i]; return lerp(va, vb, (t - a) / (b - a)); } return tab[tab.length - 1][1]; };
  const C = new V3(0, 0.095, 0);
  // the skull and face, for a direction d from the centre (before features)
  function base(d) {
    const p = new V3(d.x * 0.09, d.y * 0.118, d.z * (d.z > 0 ? 0.1 : 0.108)).add(C);
    if (p.z > 0.055 && p.y > -0.04 && p.y < 0.175) p.z = 0.055 + (p.z - 0.055) * 0.7;        // a flatter face
    if (p.y < 0.09) { const k = smoothstep(0.09, -0.04, p.y); p.x *= 1 + 0.1 * k * (1 - k) * 4; } // full, round cheeks and jaw
    if (d.y < 0 && d.z > 0) { p.y -= 0.05 * d.z * smoothstep(0, -0.7, d.y); p.z += 0.012 * d.z * smoothstep(-0.2, -0.7, d.y); } // the chin comes down and forward
    if (d.y < -0.45) { // below the jaw: into the neck
      const t = smoothstep(-0.45, -1, d.y), h = Math.hypot(d.x, d.z) || 1;
      p.x = lerp(p.x, d.x / h * 0.056, t); p.z = lerp(p.z, -0.012 + d.z / h * 0.058, t); p.y = lerp(p.y, -0.15, t * t);
    }
    return p;
  }
  // features, added on the surface point p (outward along the surface direction)
  function features(p) {
    const ax = Math.abs(p.x); let out = 0, fwd = 0;
    if (p.z > 0.02) {
      // the nose: a straight bridge from between the eyes to a firm tip, wider at the nostrils
      const t = clamp((0.118 - p.y) / 0.06, 0, 1), w = lerp(0.008, 0.0145, t);
      const h = p.y > 0.046 ? lerp(0.005, 0.038, smoothstep(0.118, 0.066, p.y)) * smoothstep(0.044, 0.062, p.y) : 0;
      fwd += h * Math.exp(-((p.x / w) ** 2));
      fwd += 0.011 * gauss(ax, p.y, 0.016, 0.054, 0.008, 0.008);                          // nostril wings
      fwd -= 0.016 * gauss(ax, p.y, 0.033, 0.104, 0.015, 0.011);                          // eye sockets
      fwd += 0.004 * gauss(ax, p.y, 0.034, 0.128, 0.022, 0.007);                          // brow ridge, modest
      fwd += 0.007 * gauss(ax, p.y, 0.05, 0.068, 0.02, 0.022);                            // full cheeks
      fwd += 0.005 * gauss(p.x, p.y, 0, 0.031, 0.02, 0.006) + 0.005 * gauss(p.x, p.y, 0, 0.019, 0.019, 0.006); // lips
      fwd -= 0.003 * gauss(p.x, p.y, 0, 0.0255, 0.022, 0.0025);                           // the line between them
      fwd += 0.006 * gauss(p.x, p.y, 0, -0.02, 0.022, 0.02);                              // rounded chin
    }
    return { out, fwd };
  }
  const SEG = 96, RINGS = 80;
  const sphere = new THREE.SphereGeometry(1, SEG, RINGS), sp = sphere.attributes.position, N = sp.count;
  const dirs = [], skinPts = [];
  for (let i = 0; i < N; i++) {
    const d = new V3().fromBufferAttribute(sp, i).normalize(); dirs.push(d);
    const p = base(d), f = features(p); p.z += f.fwd; skinPts.push(p);
  }
  const skinGeo = sphere.clone(); const P = skinGeo.attributes.position;
  skinPts.forEach((p, i) => P.setXYZ(i, p.x, p.y, p.z)); skinGeo.computeVertexNormals();
  const NRM = skinGeo.attributes.normal;
  // skin tones: fair, warmer and rosier on the cheeks, nose and ears, pink lips
  const skinC = new Float32Array(N * 3), base0 = lin(0xdcae98), rosy = lin(0xd48a78), lip = lin(0xb86a62), tc = new THREE.Color();
  for (let i = 0; i < N; i++) {
    const p = skinPts[i], ax = Math.abs(p.x);
    tc.copy(base0).lerp(rosy, clamp(gauss(ax, p.y, 0.05, 0.07, 0.02, 0.018) * 0.5 + gauss(p.x, p.y, 0, 0.065, 0.012, 0.02) * 0.4, 0, 1));
    if (p.z > 0.06) tc.lerp(lip, clamp(gauss(p.x, p.y, 0, 0.025, 0.021, 0.0085) * 1.3, 0, 1));
    skinC[i * 3] = tc.r; skinC[i * 3 + 1] = tc.g; skinC[i * 3 + 2] = tc.b;
  }
  skinGeo.setAttribute('color', new THREE.BufferAttribute(skinC, 3));
  const skin = new THREE.Mesh(skinGeo, skinMat); head.add(skin);

  // ---- hair masks (0..1) on the skin; phi = angle round the head, 0 straight ahead
  const jit = (p, s) => (noise2(p.x * s + 13.1, p.y * s + p.z * s * 0.7) - 0.5);
  // the hairline: high at the receding temples, a short sideburn before the ear, down to the nape at the back
  const HAIRLINE = [[0, 0.168], [0.18, 0.172], [0.42, 0.195], [0.62, 0.19], [0.85, 0.15], [1.02, 0.11], [1.15, 0.062], [1.27, 0.062], [1.33, 0.13], [1.8, 0.13], [2.15, 0.035], [3.15, -0.005]];
  const scalpMask = p => { const phi = Math.abs(Math.atan2(p.x, p.z)), y0 = interp(HAIRLINE, phi) + jit(p, 160) * 0.008; return smoothstep(y0 - 0.002, y0 + 0.008, p.y); };
  // the beard: under a line from the sideburn to the corner of the mouth, down onto the neck; lips left bare
  const BEARD_TOP = [[0, 0.05], [0.22, 0.044], [0.42, 0.04], [0.75, 0.058], [1.05, 0.074], [1.2, 0.072], [1.3, 0.02], [1.6, -0.06], [3.15, -0.2]];
  const beardMask = p => {
    const phi = Math.abs(Math.atan2(p.x, p.z)), top = interp(BEARD_TOP, phi) + jit(p, 140) * 0.008;
    let m = smoothstep(top + 0.004, top - 0.008, p.y);
    m *= smoothstep(-0.13 + phi * 0.04, -0.105 + phi * 0.04, p.y);                       // where it ends on the neck
    if (p.z > 0.03) m *= 1 - gauss(p.x, p.y, 0, 0.0255, 0.026, 0.0085);                   // the lips
    if (Math.abs(p.x) < 0.03 && p.y > 0.04 && p.y < 0.06 && p.z > 0.06) m = Math.max(m, smoothstep(0.06, 0.05, p.y) * smoothstep(0.041, 0.046, p.y)); // moustache
    return clamp(m, 0, 1);
  };
  const browMask = p => {
    if (p.z < 0.04) return 0;
    const ax = Math.abs(p.x), yc = 0.1285 + 0.004 * Math.cos((ax - 0.032) * 60) - Math.max(0, ax - 0.048) * 0.25; // a slight arch, the tails dropping
    return smoothstep(0.0055, 0.0025, Math.abs(p.y - yc)) * smoothstep(0.012, 0.016, ax) * smoothstep(0.058, 0.05, ax);
  };
  // ---- a shell grown from the skin: thickness × mask along the normal (inside the skin where there's no hair)
  function shell(maskFn, thick, colourFn) {
    const geo = sphere.clone(), pos = geo.attributes.position, col = new Float32Array(N * 3), c = new THREE.Color();
    for (let i = 0; i < N; i++) {
      const p = skinPts[i], m = maskFn(p), t = typeof thick === 'function' ? thick(p) : thick, n = new V3().fromBufferAttribute(NRM, i);
      const q = p.clone().addScaledVector(n, m > 0.02 ? m * t : -0.003);
      pos.setXYZ(i, q.x, q.y, q.z);
      colourFn(p, m, c); col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    // drop the triangles that stay hidden under the skin
    const idx = geo.index.array, keep = [];
    for (let k = 0; k < idx.length; k += 3) if (maskFn(skinPts[idx[k]]) + maskFn(skinPts[idx[k + 1]]) + maskFn(skinPts[idx[k + 2]]) > 0.03) keep.push(idx[k], idx[k + 1], idx[k + 2]);
    geo.setIndex(keep); geo.setAttribute('color', new THREE.BufferAttribute(col, 3)); geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, hairMat); head.add(m); return m;
  }
  const DARK = lin(0x2c2018), DARK2 = lin(0x34261c), GREY = lin(0x7d7a76), TIP = lin(0x7a6a56);
  // short back and sides, a little longer towards the top
  shell(scalpMask, p => lerp(0.006, 0.016, smoothstep(0.14, 0.21, p.y)), (p, m, c) => c.copy(DARK).lerp(DARK2, smoothstep(0.15, 0.21, p.y)));
  shell(beardMask, p => (p.y < 0.0 ? 0.016 : 0.012) - (p.y > 0.04 ? 0.004 : 0), (p, m, c) => {
    const ax = Math.abs(p.x), cheek = smoothstep(0.035, 0.065, ax) * smoothstep(-0.01, 0.02, p.y) * smoothstep(0.085, 0.06, p.y);
    const salt = noise2(p.x * 2400, p.y * 2400 + p.z * 1700) > 0.7 ? 1 : 0;              // fine grey hairs among the dark
    c.copy(DARK).lerp(GREY, cheek * (0.12 + 0.3 * salt) + 0.05 * salt);
  });
  shell(browMask, 0.0055, (p, m, c) => c.copy(DARK));

  // ---- the curls: a mop of loose spiral locks on top, falling forward over the hairline, darker at the root
  const curlGeos = [], up = new V3(0, 1, 0);
  const tops = []; for (let i = 0; i < N; i++) { const p = skinPts[i]; if (p.y > 0.15 && scalpMask(p) > 0.6 && Math.abs(Math.atan2(p.x, p.z)) < 2.0 && Math.abs(p.x) < 0.07) tops.push(i); }
  for (let k = 0; k < 230 && tops.length; k++) {
    const i = tops[(Math.random() * tops.length) | 0], p = skinPts[i], n = new V3().fromBufferAttribute(NRM, i);
    const front = smoothstep(-0.02, 0.07, p.z);                                             // locks at the front tip forward
    const axis = n.clone().multiplyScalar(0.9).add(new V3(rand(-0.5, 0.5), 0.15, 0.35 + front * 0.8)).normalize();
    const len = rand(0.03, 0.055) * (0.8 + front * 0.5), turns = rand(1.2, 2.4), R = rand(0.0045, 0.008);
    const side = new V3().crossVectors(axis, up).normalize(); if (side.lengthSq() < 0.1) side.set(1, 0, 0);
    const side2 = new V3().crossVectors(axis, side).normalize(), ph = rand(0, 6.28);
    const pts = [];
    for (let s = 0; s <= 14; s++) {
      const t = s / 14, a = ph + t * turns * Math.PI * 2, r = R * (0.5 + t);
      pts.push(p.clone().addScaledVector(n, 0.008).addScaledVector(axis, len * t).addScaledVector(side, Math.cos(a) * r).addScaledVector(side2, Math.sin(a) * r).add(new V3(0, -0.012 * t * t * front, 0)));
    }
    const tube = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 18, rand(0.0032, 0.0048), 5, false);
    const tp = tube.attributes.position, col = new Float32Array(tp.count * 3), c = new THREE.Color(), tipK = rand(0.15, 0.85);
    for (let v = 0; v < tp.count; v++) { const t = Math.floor(v / 6) / 18; c.copy(DARK2).lerp(TIP, smoothstep(0.55, 1, t) * tipK); col[v * 3] = c.r; col[v * 3 + 1] = c.g; col[v * 3 + 2] = c.b; }
    tube.setAttribute('color', new THREE.BufferAttribute(col, 3)); tube.deleteAttribute('uv'); curlGeos.push(tube);
  }
  if (curlGeos.length) { const curls = new THREE.Mesh(mergeGeometries(curlGeos), hairMat); head.add(curls); }

  // ---- ears: a flattened, dished shell with a rim, set a little proud of the head and tilted back
  const earGeo = new THREE.SphereGeometry(1, 20, 16), ep = earGeo.attributes.position;
  for (let i = 0; i < ep.count; i++) {
    const x = ep.getX(i), y = ep.getY(i), z = ep.getZ(i);
    const dish = x > 0 ? 0.55 * Math.exp(-((y * 1.2) ** 2 + (z * 1.4) ** 2) * 2) : 0;        // the bowl of the ear
    ep.setXYZ(i, (x * 0.28 - dish * 0.22) * 0.03, y * 0.031 * (y > 0 ? 1.1 : 0.9), z * 0.019);
  }
  earGeo.computeVertexNormals();
  const ec = new Float32Array(ep.count * 3), earC = lin(0xd8958a); for (let i = 0; i < ep.count; i++) { ec[i * 3] = earC.r; ec[i * 3 + 1] = earC.g; ec[i * 3 + 2] = earC.b; }
  earGeo.setAttribute('color', new THREE.BufferAttribute(ec, 3));
  for (const s of [-1, 1]) {
    const ear = new THREE.Mesh(earGeo, skinMat); ear.position.set(s * 0.086, 0.09, -0.012); ear.rotation.set(-0.15, s * 0.32, s * 0.08); ear.scale.x = s; head.add(ear);
  }
  // ---- eyes: white with a dark brown iris and pupil, sitting in the sockets
  const eyeW = new THREE.MeshStandardMaterial({ color: 0xe8e2d8, roughness: 0.25 }), iris = new THREE.MeshStandardMaterial({ color: 0x3a2214, roughness: 0.3 }), pupil = new THREE.MeshBasicMaterial({ color: 0x050302 });
  for (const s of [-1, 1]) {
    const e = new THREE.Group(); e.position.set(s * 0.033, 0.103, 0.066); head.add(e);
    e.add(new THREE.Mesh(new THREE.SphereGeometry(0.012, 16, 12), eyeW));
    const ir = new THREE.Mesh(new THREE.CircleGeometry(0.0066, 18), iris); ir.position.z = 0.0119; e.add(ir);
    const pu = new THREE.Mesh(new THREE.CircleGeometry(0.0029, 12), pupil); pu.position.z = 0.0121; e.add(pu);
    // lids: skin-coloured caps over the top and bottom of the eye, so it reads as an almond, not a goggle
    const lid = new THREE.Mesh(new THREE.SphereGeometry(0.0128, 16, 8, 0, Math.PI * 2, 0, Math.PI * 0.4), skinLidMat); lid.rotation.x = 0.5; e.add(lid);
    const low = new THREE.Mesh(new THREE.SphereGeometry(0.0127, 16, 8, 0, Math.PI * 2, Math.PI * 0.66, Math.PI * 0.34), skinLidMat); low.rotation.x = -0.25; e.add(low);
  }
  head.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
}
const skinLidMat = new THREE.MeshStandardMaterial({ color: 0xc8957e, roughness: 0.7 });
// Blender-built hero (tools/build_hero.py -> models/hero.glb); swapped in place of the primitive hero at load.
function buildHeroGLB(tpl) {
  const vc = { vertexColors: true };
  const M = {
    // worn, matte finishes: skin with a soft sheen, dry leather, dull brushed steel; only the blade keeps an edge of shine
    skin: phys(0xc4917a, 0.8, 0, { ...vc, sheen: 0.1, sheenColor: 0xd8a890, sheenRoughness: 0.7, specularIntensity: 0.5, envMapIntensity: 0.5 }),
    leather: triplanarDetail(std(0x50301d, 0.82, 0, vc), leatherTex, 3.2, 1.1, 0.5, 0.3),
    cloth: std(0x3d3c31, 0.96, 0, { ...vc, side: THREE.DoubleSide }),
    sash: std(0x7a2418, 0.92, 0, { ...vc, side: THREE.DoubleSide }),
    boot: triplanarDetail(std(0x2b1d12, 0.78, 0, vc), leatherTex, 2.8, 1.1, 0.45, 0.3),
    hair: triplanarDetail(std(0x2a1b12, 0.9, 0, vc), hairTex, 3.0, 1.5, 0.75, 0.3),
    // metals: worn and dull underneath, with a thin clear layer that throws a small, crisp, cold highlight
    // No clearcoat: worn steel has no lacquer over it, and a clear layer is what made the armour read as plastic.
    // The roughness texture breaks the reflections up instead (scratches and burnish glint, smudges stay dull).
    steel: std(0x868b92, 0.88, 0.8, { ...vc, roughnessMap: metalRough, bumpMap: metalRough, bumpScale: 0.25, envMapIntensity: 0.55 }),
    iron: std(0x46474a, 1.35, 0.7, { ...vc, roughnessMap: metalRough, bumpMap: metalRough, bumpScale: 0.3, envMapIntensity: 0.4 }),
    mail: std(0x5f6266, 1.4, 0.7, { ...vc, roughnessMap: metalRough, side: THREE.DoubleSide, envMapIntensity: 0.4 }),
    metal: std(0xb8c0c8, 0.6, 1.0, { ...vc, roughnessMap: metalRough, emissive: 0x000000, envMapIntensity: 0.75 }),
    eye: std(0xb8b0a2, 0.45, 0, vc),
  };
  const model = tpl.clone(true);
  model.traverse(o => { if (o.isMesh) { o.material = M[(o.material.name || '').toLowerCase()] || M.cloth; o.castShadow = true; o.receiveShadow = true; } });
  const f = n => model.getObjectByName(n);
  const root = new THREE.Group(); root.rotation.order = 'YXZ'; root.add(model);
  const j = { hips: f('Hips'), spine: f('Spine'), neck: f('Neck'), lSh: f('ShoulderL'), lEl: f('ElbowL'), lHa: f('HandL'),
    rSh: f('ShoulderR'), rEl: f('ElbowR'), rHa: f('HandR'), lHip: f('HipL'), lKn: f('KneeL'), rHip: f('HipR'), rKn: f('KneeR') };
  // Ball-joint fillers. The model is rigid parts hanging off joints, so when a shoulder turns, the top of the arm swings
  // away from the chest and leaves a gap. A padded shoulder mass sits on the torso at each shoulder pivot (a ball joint:
  // whatever the arm's angle, the arm's root stays buried in it), with a slope of quilting up to the neck. Vertex
  // colours darken the armpit side, like the model's baked occlusion.
  const shade = (geo, k0, k1) => {
    const p = geo.attributes.position, c = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) { const v = lerp(k0, k1, clamp(p.getY(i) / 0.09 * 0.5 + 0.5, 0, 1)); c[i * 3] = c[i * 3 + 1] = c[i * 3 + 2] = v; }
    geo.setAttribute('color', new THREE.BufferAttribute(c, 3)); return geo;
  };
  model.updateMatrixWorld(true);
  for (const [sh, s] of [[j.lSh, 1], [j.rSh, -1]]) {
    if (!sh || !j.spine) continue;
    const at = j.spine.worldToLocal(sh.getWorldPosition(new V3()));
    const ball = new THREE.Mesh(shade(new THREE.SphereGeometry(0.088, 16, 12), 0.45, 1), M.cloth);
    ball.position.copy(at).add(new V3(-s * 0.012, -0.012, 0)); ball.scale.set(1, 0.95, 1.08);
    const trap = new THREE.Mesh(shade(new THREE.SphereGeometry(0.075, 14, 10), 0.6, 1), M.cloth);
    trap.position.copy(at).multiply(new V3(0.55, 1, 1)).add(new V3(0, 0.005, -0.01)); trap.scale.set(1.6, 0.75, 1.15);
    for (const m of [ball, trap]) { m.castShadow = m.receiveShadow = true; j.spine.add(m); }
  }
  // the head: the model's own skin, hair, beard and eyes are hidden, and the sculpted head takes their place
  const headMesh = f('HeadMesh');
  if (j.head || f('Head')) {
    if (headMesh) headMesh.visible = false;
    const faceHair = triplanarDetail(std(0xffffff, 0.86, 0, { vertexColors: true }), hairTex, 6.0, 0.9, 0.38, 0.3);
    const faceSkin = phys(0xffffff, 0.72, 0, { vertexColors: true, sheen: 0.12, sheenColor: 0xffc8b0, sheenRoughness: 0.6, specularIntensity: 0.45, envMapIntensity: 0.45 });
    buildFace(f('Head'), faceHair, faceSkin);
  }
  const sword = f('Sword'), scab = f('Scabbard');
  sword.removeFromParent(); scab.removeFromParent();
  const mk = z => { const o = new THREE.Object3D(); o.position.z = z; sword.add(o); return o; };
  const swordTip = mk(1.05), swordBase = mk(0.2), swordMid = mk(0.6);
  const sheath = new THREE.Group(); sheath.position.set(0.22, 0.02, -0.04); sheath.rotation.set(2.45, 0, -0.12); j.hips.add(sheath);
  scab.position.set(0, 0, 0); scab.rotation.set(0, 0, 0); sheath.add(scab); sheath.add(sword);
  sword.position.set(0, 0, 0); sword.rotation.set(0, 0, 0);
  return { root, j, sword, swordTip, swordBase, swordMid, sheath, bladeMat: M.metal };
}
scene.add(hero.root);
hero.root.userData.occluder = true; // throws light shafts
const HJMAP = { spine: 'spine', neck: 'neck', lSh: 'lSh', lEl: 'lEl', rSh: 'rSh', rEl: 'rEl', rHa: 'rHa', lHip: 'lHip', lKn: 'lKn', rHip: 'rHip', rKn: 'rKn', hipR: 'hips' };
function applyHero(p, k, dt) {
  for (const key of PJ) {
    const o = hero.j[HJMAP[key]], v = p[key];
    o.rotation.x = damp(o.rotation.x, v[0], k, dt); o.rotation.y = damp(o.rotation.y, v[1], k, dt); o.rotation.z = damp(o.rotation.z, v[2], k, dt);
  }
  hero.j.hips.position.y = damp(hero.j.hips.position.y, 0.98 + p.hy, k, dt);
}
function setSwordInHand(inHand) {
  const parent = inHand ? hero.j.rHa : hero.sheath;
  parent.add(hero.sword);
  hero.sword.position.set(0, 0, 0); hero.sword.rotation.set(0, 0, 0);
}

const P = {
  pos: new V3(0, 0, 7), yaw: Math.PI, vel: new V3(), hp: 100, maxHp: 100, st: 100, maxSt: 100,
  drawn: false, state: 'idle', t: 0, step: 0, swing: null, swingType: '', times: null, queued: false, failed: false,
  hitSet: new Set(), iframes: 0, stunDur: 0, gait: 0, lastSg: 1, stDelay: 0, swapDone: false, swungSound: false, dodgeDir: new V3(),
  combo: 0, comboT: 0, ghostHp: 100, gaitW: 0, bank: 0, prevYaw: Math.PI, visYaw: 0, seg: -1, swingId: 0, hurtBack: false, jy: 0, vy: 0, jumpVel: new V3(),
};
// knocked down or getting up: no control, no turning
const isDown = () => P.state === 'dead' || P.state === 'down' || P.state === 'getup';

// ============================================================ the Thornbeak (original creature)
const PALETTES = [
  { plume: 0x3c4048, rust: 0x7a3d22, belly: 0x8a6a4a, name: 'THORNBEAK' },
  { plume: 0x5a5146, rust: 0xa0742e, belly: 0xa08868, name: 'ASHEN THORNBEAK' },
  { plume: 0x1d1a1c, rust: 0x8e1c18, belly: 0x5a3a30, name: 'BLOODCREST THORNBEAK' },
];
// glossy, oily plumage with a cold blue sheen; lacquered beak, thorns and talons
// ---- the Thornbeak's surfaces: procedural detail textures, projected from three sides like the hero's (no UVs)
// feathers: overlapping vanes in staggered rows, each with a central shaft and fine barbs angled off it
const featherTex = detailTex((x, s) => {
  x.fillStyle = 'rgb(96,96,96)'; x.fillRect(0, 0, s, s);
  const rows = 7, cols = 6, fh = s / rows * 1.9, fw = s / cols * 0.62;
  for (let r = rows; r >= -1; r--) for (let c = 0; c < cols; c++) {
    const cx = (c + (r % 2) * 0.5) / cols * s + rand(-4, 4), cy = r / rows * s + rand(-3, 3), v = rand(120, 160) | 0, a = rand(-0.12, 0.12);
    wrapDraw(x, s, (ox, oy) => {
      x.save(); x.translate(cx + ox, cy + oy); x.rotate(a);
      x.fillStyle = 'rgba(40,40,40,.5)'; x.beginPath(); x.ellipse(0, fh * 0.42, fw * 0.55, fh * 0.52, 0, 0, 7); x.fill();   // the shadow it casts on the one below
      x.fillStyle = `rgb(${v},${v},${v})`; x.beginPath(); x.ellipse(0, fh * 0.38, fw * 0.5, fh * 0.5, 0, 0, 7); x.fill();
      for (let k = 0; k < 16; k++) { const y = fh * (0.02 + k / 16 * 0.78); for (const sd of [-1, 1]) { // barbs
        x.strokeStyle = `rgba(${Math.random() < 0.5 ? '50,50,50' : '200,200,200'},.35)`; x.lineWidth = 0.9;
        x.beginPath(); x.moveTo(0, y); x.lineTo(sd * fw * 0.46, y + fh * 0.12); x.stroke(); } }
      x.strokeStyle = 'rgba(205,205,205,.7)'; x.lineWidth = 1.4; x.beginPath(); x.moveTo(0, -fh * 0.08); x.lineTo(0, fh * 0.82); x.stroke(); // the shaft
      x.restore();
    });
  }
});
// beak, thorns and talons: keratin in layers, growth streaks running its length, darker mottling
const beakTex = detailTex((x, s) => {
  x.fillStyle = 'rgb(128,128,128)'; x.fillRect(0, 0, s, s);
  for (let i = 0; i < 160; i++) { const px = rand(0, s), v = rand(90, 175) | 0, w = rand(0.6, 2.6); wrapDraw(x, s, (ox, oy) => { x.strokeStyle = `rgba(${v},${v},${v},.45)`; x.lineWidth = w; x.beginPath(); x.moveTo(px + ox, oy); x.bezierCurveTo(px + ox + rand(-4, 4), oy + s * 0.33, px + ox + rand(-4, 4), oy + s * 0.66, px + ox + rand(-3, 3), oy + s); x.stroke(); }); }
  for (let i = 0; i < 9; i++) { const py = rand(0, s); wrapDraw(x, s, (ox, oy) => { x.strokeStyle = 'rgba(60,60,60,.35)'; x.lineWidth = rand(1, 2.2); x.beginPath(); x.moveTo(ox, py + oy); x.bezierCurveTo(ox + s * 0.3, py + oy + rand(-6, 6), ox + s * 0.6, py + oy + rand(-6, 6), ox + s, py + oy); x.stroke(); }); } // growth rings
  for (let i = 0; i < 20; i++) { const px = rand(0, s), py = rand(0, s), r = rand(10, 34); wrapDraw(x, s, (ox, oy) => { const gr = x.createRadialGradient(px + ox, py + oy, 0, px + ox, py + oy, r); gr.addColorStop(0, 'rgba(70,70,70,.35)'); gr.addColorStop(1, 'rgba(70,70,70,0)'); x.fillStyle = gr; x.fillRect(px + ox - r, py + oy - r, 2 * r, 2 * r); }); }
});
// The lock-on highlight as a rim light: a warm glow only where the surface turns away from the viewer, along the
// silhouette, so the feathers keep their colour and texture (a flat emissive tint used to wash them out)
function rimHighlight(mat) {
  const hl = { value: 0 }; mat.userData.hl = hl; mat.userData.extraKey = 'rim';
  mat.userData.extraCompile = sh => {
    sh.uniforms.uHl = hl;
    sh.fragmentShader = 'uniform float uHl;\n' + sh.fragmentShader.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
      { float rim = 1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);
        totalEmissiveRadiance += vec3(1.0, 0.68, 0.28) * uHl * pow(rim, 7.0) * 0.07; } // just a hint of gold on the outline`);
  };
  return mat;
}
function beastMaterials(pal, vc) {
  const o = { vertexColors: vc };
  const T = (m, tex, sc, bump, str, rv) => triplanarDetail(m, tex, sc, bump, str, rv);
  return {
    // matte, dusty feathers: only a faint, warm sheen at grazing angles, no lacquer
    plume: rimHighlight(T(phys(pal.plume, 0.9, 0, { ...o, sheen: 0.25, sheenColor: 0x6a6258, sheenRoughness: 0.8, envMapIntensity: 0.4 }), featherTex, 5.5, 1.3, 0.6, 0.25)),
    rust: rimHighlight(T(phys(pal.rust, 0.9, 0, { ...o, sheen: 0.2, sheenColor: 0x6a5a4a, sheenRoughness: 0.8, envMapIntensity: 0.4 }), featherTex, 6, 1.3, 0.55, 0.25)),
    belly: rimHighlight(T(std(pal.belly, 0.95, 0, { ...o, envMapIntensity: 0.4 }), featherTex, 8, 0.8, 0.35, 0.2)),   // finer, softer down
    bone: T(std(0xb8ac94, 0.7, 0, { ...o, envMapIntensity: 0.5 }), beakTex, 9, 0.9, 0.45, 0.3),
    scale: T(std(0x4a3a28, 0.75, 0, { ...o, envMapIntensity: 0.5 }), leatherTex, 7, 1.3, 0.5, 0.3),            // scaly legs
    claw: T(std(0x1a130d, 0.55, 0, { ...o, envMapIntensity: 0.6 }), beakTex, 12, 0.9, 0.5, 0.3),
    eye: std(0x221100, 0.4, 0, { emissive: 0xffa21a, emissiveIntensity: 2.4 }),
  };
}
// The Blender-built model (tools/build_thornbeak.py → models/thornbeak.glb). Its named joints are
// driven by the same procedural animation as before; falls back to the primitive model if it fails to load.
let beastTemplate = null;
function buildBeast(scale, pal) {
  if (!beastTemplate) return buildBeastPrimitive(scale, pal);
  const M = beastMaterials(pal, true);
  const root = new THREE.Group();
  const model = beastTemplate.clone(true);
  root.add(model);
  const f = n => model.getObjectByName(n);
  const r = {
    root, M, body: f('Body'), n1: f('Neck1'), n2: f('Neck2'), head: f('Head'), jaw: f('Jaw'), tail: f('Tail'),
    lHip: f('HipL'), lKn: f('KneeL'), lAn: f('AnkleL'), rHip: f('HipR'), rKn: f('KneeR'), rAn: f('AnkleR'),
  };
  model.traverse(o => {
    if (!o.isMesh) return;
    o.material = M[(o.material.name || '').toLowerCase()] || M.plume;
    o.castShadow = true; o.receiveShadow = true;
  });
  root.scale.setScalar(scale);
  r.flashMats = [M.plume, M.rust, M.belly];
  return r;
}
function buildBeastPrimitive(scale, pal) {
  const M = beastMaterials(pal, false);
  const root = new THREE.Group();
  const r = { root, M };
  const body = new THREE.Group(); body.position.y = 1.2; root.add(body); r.body = body;
  mesh(sphere(0.8, 18, 14), M.plume, body, [0, 0, 0], [0, 0, 0], [0.95, 0.82, 1.3]);
  mesh(sphere(0.62, 16, 12), M.belly, body, [0, -0.2, 0.2], [0, 0, 0], [0.85, 0.7, 1.05]);
  for (let i = 0; i < 34; i++) {
    const th = rand(0, Math.PI * 2), ph = rand(-0.5, 1.2);
    const out = new V3(Math.cos(ph) * Math.sin(th) * 0.95, Math.sin(ph) * 0.82, Math.cos(ph) * Math.cos(th) * 1.3);
    const m = mesh(cone(0.13, rand(0.45, 0.7), 5), i % 3 ? M.plume : M.rust, body, [out.x * 0.85, out.y * 0.85, out.z * 0.85]);
    orient(m, out.clone().normalize().multiplyScalar(0.6).add(new V3(0, 0.1, -0.9)));
  }
  for (let i = 0; i < 6; i++) { // back thorns
    const z = lerp(0.7, -0.8, i / 5), y = 0.62 + Math.sin((i / 5) * Math.PI) * 0.12;
    orient(mesh(cone(0.07, 0.42 - Math.abs(i - 2.5) * 0.04, 6), M.bone, body, [0, y, z]), new V3(0, 1, -0.6));
  }
  for (const s of [1, -1]) { // stubby wings
    const w = mesh(sphere(0.3, 10, 8), M.rust, body, [s * 0.74, 0.12, 0.05], [0, 0, s * -0.35], [0.35, 0.8, 1.6]);
    for (let k = 0; k < 3; k++) orient(mesh(cone(0.08, 0.5, 5), M.plume, w, [0, -0.25, -0.25 - k * 0.2]), new V3(0, -0.4, -1));
  }
  const tail = new THREE.Group(); tail.position.set(0, 0.2, -0.95); body.add(tail); r.tail = tail;
  for (let i = -3; i <= 3; i++) {
    const dir = new V3(i * 0.3, 0.45 - Math.abs(i) * 0.06, -1).normalize();
    const len = 1.2 - Math.abs(i) * 0.1;
    const m = mesh(cone(0.12, len, 5), i % 2 ? M.plume : M.rust, tail, dir.clone().multiplyScalar(len / 2).toArray());
    orient(m, dir);
    mesh(cone(0.05, 0.2, 4), M.bone, m, [0, len / 2 + 0.05, 0]);
  }
  // neck chain
  const neckBase = new THREE.Group(); neckBase.position.set(0, 0.35, 0.95); body.add(neckBase);
  const n1 = new THREE.Group(); neckBase.add(n1); r.n1 = n1;
  mesh(capsule(0.21, 0.4), M.plume, n1, [0, 0.24, 0]);
  for (let i = 0; i < 9; i++) { // ruff
    const a = (i / 9) * Math.PI * 2;
    orient(mesh(cone(0.09, 0.42, 5), M.rust, n1, [Math.sin(a) * 0.2, 0.1, Math.cos(a) * 0.2]), new V3(Math.sin(a), -0.3, Math.cos(a) - 0.6));
  }
  const n2 = new THREE.Group(); n2.position.y = 0.5; n1.add(n2); r.n2 = n2;
  mesh(capsule(0.16, 0.36), M.plume, n2, [0, 0.2, 0]);
  const head = new THREE.Group(); head.position.y = 0.46; n2.add(head); r.head = head;
  mesh(sphere(0.25, 14, 12), M.plume, head, [0, 0.04, 0.04], [0, 0, 0], [0.9, 0.82, 1.15]);
  mesh(cone(0.13, 0.62, 8), M.bone, head, [0, 0.0, 0.5], [Math.PI / 2, 0, 0], [1, 1, 0.72]);
  mesh(cone(0.045, 0.16, 6), M.bone, head, [0, -0.05, 0.78], [Math.PI, 0, 0]); // hooked tip
  const jaw = new THREE.Group(); jaw.position.set(0, -0.08, 0.16); head.add(jaw); r.jaw = jaw;
  mesh(cone(0.09, 0.5, 7), M.bone, jaw, [0, -0.01, 0.27], [Math.PI / 2, 0, 0], [1, 1, 0.55]);
  for (const [x, y, z, l] of [[0, 0.2, -0.05, 0.45], [0.1, 0.16, -0.08, 0.32], [-0.1, 0.16, -0.08, 0.32]]) {
    const m = mesh(cone(0.05, l, 6), M.bone, head, [x, y, z]); orient(m, new V3(x * 2, 0.55, -1));
  }
  for (const s of [1, -1]) mesh(sphere(0.042, 8, 6), M.eye, head, [s * 0.17, 0.08, 0.17]).castShadow = false;
  // legs
  function leg(s) {
    const hip = new THREE.Group(); hip.position.set(s * 0.42, -0.28, -0.05); body.add(hip);
    mesh(capsule(0.21, 0.3), M.plume, hip, [0, -0.2, 0]);
    for (let i = 0; i < 5; i++) orient(mesh(cone(0.08, 0.35, 5), i % 2 ? M.rust : M.plume, hip, [s * 0.12, -0.25 - i * 0.03, rand(-0.12, 0.12)]), new V3(s * 0.4, -1, -0.3));
    const kn = new THREE.Group(); kn.position.y = -0.45; hip.add(kn);
    mesh(capsule(0.075, 0.42), M.scale, kn, [0, -0.27, 0]);
    orient(mesh(cone(0.04, 0.18, 5), M.claw, kn, [0, -0.15, -0.07]), new V3(0, -0.2, -1));
    const an = new THREE.Group(); an.position.y = -0.55; kn.add(an);
    for (const t of [-0.5, 0, 0.5]) {
      const toe = new THREE.Group(); toe.rotation.y = t; an.add(toe);
      mesh(capsule(0.045, 0.2), M.scale, toe, [0, -0.02, 0.14], [Math.PI / 2, 0, 0]);
      mesh(cone(0.04, 0.12, 5), M.claw, toe, [0, -0.04, 0.3], [Math.PI / 2 + 0.4, 0, 0]);
    }
    mesh(capsule(0.04, 0.1), M.scale, an, [0, -0.02, -0.1], [-Math.PI / 2, 0, 0]);
    return [hip, kn, an];
  }
  [r.lHip, r.lKn, r.lAn] = leg(1);
  [r.rHip, r.rKn, r.rAn] = leg(-1);
  root.scale.setScalar(scale);
  root.traverse(o => { if (o.isMesh) { o.castShadow = true; } });
  r.flashMats = [M.plume, M.rust, M.belly];
  return r;
}

const beasts = [];
class Beast {
  constructor(level, x, delay) {
    this.level = level;
    const pal = PALETTES[Math.min(PALETTES.length - 1, Math.floor((level - 1) / 2))];
    this.name = pal.name;
    this.s = 0.82 + Math.min(level, 6) * 0.03; // smaller than before: roughly chest-high to the hero
    this.rig = buildBeast(this.s, pal); this.rig.root.userData.occluder = true; scene.add(this.rig.root);
    this.pal = pal;
    this.pos = new V3(x, 0, -19.5); this.yaw = 0; this.vel = new V3();
    this.maxHp = Math.round(190 * (1 + 0.22 * (level - 1))); this.hp = this.maxHp; this.ghostHp = this.hp;
    this.dmgMul = 1 + 0.12 * (level - 1); this.aggr = Math.min(1.6, 1 + 0.1 * (level - 1));
    this.radius = 0.78 * this.s; this.state = 'wait'; this.t = -delay;
    this.cdir = Math.random() < 0.5 ? 1 : -1; this.think = 1; this.pecks = 1; this.pw = 0.38; this.hitDone = false;
    this.gait = rand(0, 6); this.lastSg = 1; this.iframes = 0; this.hitChain = 0; this.lastHit = -10;
    this.flash = 0; this.lookOff = 0; this.lookT = 0; this.seed = rand(0, 100); this.stagDur = 0.3; this.stagRoll = 0;
    this.pitch = rand(0.9, 1.1) - level * 0.015; this.dead = false; this.deadT = 0;
    this.lungeDir = new V3(); this.fwd = new V3(0, 0, 1);
    // how well it reads the hero's wind-ups (medieval-sim's `skill`): rare at first, a real threat by round six
    this.skill = Math.min(0.45, 0.04 + 0.07 * (level - 1)); this.reacted = -1;
    this.rig.root.position.copy(this.pos);
  }
  setState(s) { this.state = s; this.t = 0; this.hitDone = false; }
  forward() { return this.fwd.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)); }
  takeHit(dmg, dir, heavy, flank = false) {
    if (this.dead) return;
    this.hp -= dmg; this.flash = 0.12;
    const hp = this.pos.clone().add(new V3(0, 1.25 * this.s, 0)).addScaledVector(dir, -0.5 * this.s);
    popText(hp, String(dmg), heavy ? 'crit' : '');
    bloodBurst(hp, dir, heavy ? 34 : 20);
    feathers(hp, heavy ? 6 : 3, [this.pal.plume >> 16 & 255, this.pal.plume >> 8 & 255, this.pal.plume & 255].map(v => v / 255 * 0.6));
    hitStop = heavy ? 0.12 : 0.07; shake = Math.max(shake, heavy ? 0.55 : 0.3); SFX.hit(heavy);
    if (this.hp <= 0) { this.die(dir); return; }
    this.hitChain = time - this.lastHit < 1.7 ? this.hitChain + 1 : 1; this.lastHit = time;
    if (this.state === 'lunge' && !heavy && !flank) return; // hyper-armour mid-charge, except against a cut from behind
    if (this.hitChain >= 3 && !heavy && !flank && Math.random() < 0.5 * this.aggr) { // breaks the combo with a leap back
      this.setState('hop'); this.iframes = 0.4; this.vel.copy(dir).multiplyScalar(7.5); SFX.squawk(this.pitch * 1.1);
      dust(this.pos, 8, 0.6, 1.4); return;
    }
    this.setState('stagger'); this.stagDur = heavy ? 0.6 : flank ? 0.5 : 0.34; this.stagRoll = rand(-0.25, 0.25);
    this.vel.addScaledVector(dir, heavy ? 5.5 : 2.6);
    if (Math.random() < 0.55) SFX.squawk(this.pitch);
  }
  onBlocked(heavy) {
    if (heavy) { this.setState('lungeRec'); this.vel.multiplyScalar(-0.3); }
    else { this.setState('stagger'); this.stagDur = 0.42; this.stagRoll = rand(-0.2, 0.2); this.vel.copy(this.forward()).multiplyScalar(-2.5); }
  }
  die(dir) {
    this.dead = true; this.hp = 0; this.setState('dead'); this.vel.copy(dir).multiplyScalar(4);
    this.dieRoll = Math.random() < 0.5 ? 1.4 : -1.4;
    SFX.screech(this.pitch * 0.8); slowMo = 0.9;
    setTimeout(() => { SFX.thud(); dust(this.pos, 22, 1.2, 1.6); addDecal(this.pos.x, this.pos.z, 1.3); }, 520);
    onBeastDeath();
  }
  decide(dist) {
    const r = Math.random();
    if (dist > 4.2 && r < 0.42 * this.aggr) { this.setState('lungeWind'); SFX.screech(this.pitch); }
    else this.setState('approach');
  }
  startPeck(n, wind = 0.38) { this.pecks = n; this.pw = wind / Math.sqrt(this.aggr); this.setState('peckWind'); }
  update(dt) {
    this.t += dt; this.iframes = Math.max(0, this.iframes - dt); this.flash = Math.max(0, this.flash - dt);
    const toP = tmpV.set(P.pos.x - this.pos.x, 0, P.pos.z - this.pos.z);
    const dist = toP.length(); const yawP = Math.atan2(toP.x, toP.z);
    const dirP = dist > 0.001 ? toP.clone().divideScalar(dist) : new V3(0, 0, 1);
    const pDead = P.state === 'dead';
    const want = new V3(); let face = yawP, faceK = 6, velK = 6;
    const fwd = this.forward().clone();
    const facingErr = Math.abs(angWrap(yawP - this.yaw));
    // reading the hero (after medieval-sim's fight()): every swing aimed at it gets one roll against its skill, made
    // during the wind-up; on a success it springs aside and back, often pecking straight back in as it lands
    if ((this.state === 'circle' || this.state === 'approach') && P.state === 'attack' && P.t < P.times.w && this.reacted !== P.swingId && dist < 3.4) {
      this.reacted = P.swingId;
      if (Math.abs(angWrap(yawTo(P.pos, this.pos) - P.yaw)) < 0.9 && Math.random() < this.skill) {
        const side = Math.random() < 0.5 ? 1 : -1;
        this.setState('hop'); this.iframes = 0.3;
        this.vel.set(-dirP.z * side, 0, dirP.x * side).multiplyScalar(4.5).addScaledVector(dirP, -5);
        SFX.squawk(this.pitch * 1.15); dust(this.pos, 6, 0.5, 1.1);
      }
    }
    switch (this.state) {
      case 'wait': want.set(0, 0, 0); face = 0; if (this.t > 0) { this.setState('enter'); } break;
      case 'enter': want.copy(fwd).multiplyScalar(3.8); face = this.pos.z < -16 ? 0 : yawP;
        if (this.pos.z > -13.5 || this.t > 3) { this.setState('circle'); this.think = rand(0.6, 1.4); SFX.screech(this.pitch); } break;
      case 'circle': {
        const tang = new V3(-dirP.z, 0, dirP.x).multiplyScalar(this.cdir * 2.4);
        want.copy(dirP).multiplyScalar((dist - 5) * 1.3).add(tang);
        if (want.length() > 3.6) want.setLength(3.6);
        if (pDead) { this.setState('taunt'); break; }
        if (this.t > this.think) this.decide(dist);
        break;
      }
      case 'approach':
        want.copy(dirP).multiplyScalar(4.8 * Math.min(1.25, this.aggr));
        if (dist < 2.5 * this.s) this.startPeck(Math.random() < 0.38 * this.aggr ? 2 : 1);
        else if (this.t > 3.5 || pDead) this.setState('circle');
        break;
      case 'peckWind': faceK = 12; velK = 10;
        if (this.t >= this.pw) { this.setState('peck'); SFX.snap(); }
        break;
      case 'peck': faceK = 2; velK = 20; want.copy(fwd).multiplyScalar(3);
        if (!this.hitDone && dist < 2.55 * this.s && facingErr < 0.65) { this.hitDone = true; hitPlayer(this, Math.round(10 * this.dmgMul * rand(0.9, 1.1)), false); }
        if (this.t >= 0.14 && this.state === 'peck') this.setState('peckRec');
        break;
      case 'peckRec': faceK = 3;
        if (this.t >= 0.42) {
          if (this.pecks > 1) { this.pecks--; this.pw = 0.2; this.setState('peckWind'); }
          else { this.setState(Math.random() < 0.5 ? 'backoff' : 'circle'); this.think = rand(0.5, 1.4) / this.aggr; this.cdir = Math.random() < 0.5 ? 1 : -1; }
        }
        break;
      case 'lungeWind': faceK = 9; want.copy(dirP).multiplyScalar(-0.6);
        if (this.t > 0.15 && Math.random() < dt * 20) dust(this.pos, 1, 0.6, 0.6);
        if (this.t >= 0.72 / Math.sqrt(this.aggr)) { this.setState('lunge'); this.lungeDir.copy(fwd); }
        break;
      case 'lunge': faceK = 1.2; velK = 25; want.copy(this.lungeDir).multiplyScalar(12.5);
        if (Math.random() < dt * 40) dust(this.pos, 1, 0.5, 1.2);
        if (!this.hitDone && dist < (this.radius + 0.9) && facingErr < 1.0) {
          this.hitDone = true;
          if (hitPlayer(this, Math.round(21 * this.dmgMul * rand(0.9, 1.1)), true) && this.state === 'lunge') { this.setState('lungeRec'); this.vel.multiplyScalar(0.25); }
        }
        if (this.state === 'lunge' && (this.t > 0.55 || this.pos.length() > ARENA_R - 0.3)) this.setState('lungeRec');
        break;
      case 'lungeRec': faceK = 1; velK = 3;
        if (this.t > 0.9) { this.setState('circle'); this.think = rand(0.8, 1.6); }
        break;
      case 'backoff': want.copy(dirP).multiplyScalar(-3.3);
        if (this.t > 0.7) { this.setState('circle'); }
        break;
      case 'stagger': faceK = 1; velK = 5;
        if (this.t >= this.stagDur) {
          if (this.hitChain >= 2 && Math.random() < 0.35 * this.aggr && dist < 3) this.startPeck(1, 0.22);
          else { this.setState('circle'); this.think = rand(0.3, 1.0); }
        }
        break;
      case 'hop': faceK = 8; velK = 3;
        if (this.t > 0.45) { if (Math.random() < 0.5 && dist < 4) this.startPeck(1, 0.26); else { this.setState('circle'); this.think = rand(0.3, 0.9); } }
        break;
      case 'taunt': {
        const tang = new V3(-dirP.z, 0, dirP.x).multiplyScalar(this.cdir * 1.2);
        want.copy(dirP).multiplyScalar((dist - 3.5) * 0.8).add(tang);
        if (Math.random() < dt * 0.4) SFX.squawk(this.pitch);
        break;
      }
      case 'dead': faceK = 0; velK = 3; this.deadT += dt; break;
    }
    if (this.state !== 'hop' && this.state !== 'stagger' && this.state !== 'lungeRec' && this.state !== 'dead' || velK > 4) {
      this.vel.x = damp(this.vel.x, want.x, velK, dt); this.vel.z = damp(this.vel.z, want.z, velK, dt);
    } else { this.vel.x = damp(this.vel.x, 0, velK, dt); this.vel.z = damp(this.vel.z, 0, velK, dt); }
    if (faceK > 0) this.yaw = dampAng(this.yaw, face, faceK, dt);
    this.pos.addScaledVector(this.vel, dt);
    if (this.state !== 'wait' && this.state !== 'enter') {
      const l = Math.hypot(this.pos.x, this.pos.z);
      if (l > ARENA_R - this.radius * 0.6) { const k = (ARENA_R - this.radius * 0.6) / l; this.pos.x *= k; this.pos.z *= k; }
    }
    this.animate(dt, dist, yawP);
  }
  animate(dt, dist, yawP) {
    const R = this.rig, st = this.state, t = this.t;
    const speed = Math.hypot(this.vel.x, this.vel.z) / this.s;
    const T = { by: 1.2, bx: 0, bz: 0, n1: 0.5, n2: -0.2, hx: -0.3, hy: 0, jaw: 0.05, lh: -0.5, lk: 1.0, la: -0.5, rh: -0.5, rk: 1.0, ra: -0.5, ty: 0, tx: 0.1 };
    let k = 12;
    if (speed > 0.25 && st !== 'dead' && st !== 'hop') {
      const amp = clamp(speed / 3.5, 0, 1.35);
      this.gait += dt * (3 + speed * 1.5);
      const s = Math.sin(this.gait), c = Math.cos(this.gait);
      T.lh += s * 0.65 * amp; T.rh -= s * 0.65 * amp;
      T.lk += Math.max(0, c) * 0.85 * amp; T.rk += Math.max(0, -c) * 0.85 * amp;
      T.la -= Math.max(0, c) * 0.4 * amp; T.ra -= Math.max(0, -c) * 0.4 * amp;
      T.by += Math.abs(c) * 0.08 * amp - 0.05 * amp; T.bz = s * 0.06 * amp; T.bx = 0.12 * amp;
      T.n1 += Math.sin(this.gait * 2) * 0.12 * amp + 0.15 * amp;
      const sg = Math.sign(s); if (sg !== this.lastSg) { this.lastSg = sg; if (dist < 22) SFX.step(true); if (speed > 4) dust(this.pos, 2, 0.4); }
    } else {
      T.by += Math.sin(time * 2.2 + this.seed) * 0.012;
      T.n1 += Math.sin(time * 1.5 + this.seed) * 0.04;
    }
    this.lookT -= dt;
    if (this.lookT <= 0) { this.lookT = rand(0.25, 0.9); this.lookOff = rand(-0.3, 0.3); }
    T.hy = clamp(angWrap(yawP - this.yaw), -0.7, 0.7) + this.lookOff;
    T.ty = Math.sin(time * 1.7 + this.seed) * 0.2;
    switch (st) {
      case 'peckWind': { const u = ease(Math.min(1, t / this.pw)); T.n1 = lerp(0.5, -0.3, u); T.n2 = lerp(-0.2, -0.55, u); T.hx = lerp(-0.3, 0.4, u); T.jaw = 0.55 * u; T.bx = -0.14 * u; T.by -= 0.06 * u; T.hy = 0; T.tx = 0.4 * u; k = 18; break; }
      case 'peck': T.n1 = 1.5; T.n2 = 0.4; T.hx = -0.7; T.jaw = 0.08; T.bx = 0.38; T.by = 1.1; T.hy = 0; k = 45; break;
      case 'peckRec': { const u = ease(Math.min(1, t / 0.42)); T.n1 = lerp(1.3, 0.5, u); T.n2 = lerp(0.3, -0.2, u); T.hx = lerp(-0.6, -0.3, u); T.bx = lerp(0.3, 0, u); T.hy *= u; k = 14; break; }
      case 'lungeWind': T.by = 0.98; T.bx = 0.32; T.n1 = 1.0; T.n2 = 0.1; T.hx = -0.6; T.jaw = 0.6 + Math.sin(t * 45) * 0.12; T.hy = 0;
        T.lh = -0.95; T.rh = -0.95; T.lk = 1.65; T.rk = 1.65; T.la = -0.8; T.ra = -0.8; T.tx = 0.6; T.ty = Math.sin(t * 32) * 0.35; k = 14; break;
      case 'lunge': T.bx = 0.42; T.n1 = 1.15; T.n2 = 0.0; T.hx = -0.7; T.jaw = 0.6; T.hy = 0; T.tx = 0.5; k = 20; break;
      case 'lungeRec': { const u = Math.min(1, t / 0.9); T.bx = lerp(0.3, 0, u); T.n1 = lerp(1.2, 0.6, u); T.jaw = 0.3 * (1 - u); break; }
      case 'stagger': T.bx = -0.32; T.bz = this.stagRoll; T.n1 = -0.2; T.n2 = -0.55; T.hx = 0.55; T.jaw = 0.6; T.hy = this.stagRoll * 2; k = 22; break;
      case 'hop': { const u = Math.min(1, t / 0.45); T.lk = 1.8; T.rk = 1.8; T.lh = -1.0; T.rh = -1.0; T.by = 1.2 + Math.sin(u * Math.PI) * 0.75; T.bx = -0.25; T.n1 = 0.1; T.jaw = 0.4; k = 18;
        if (u >= 1 && !this.landed) { this.landed = true; dust(this.pos, 10, 0.8, 1.2); SFX.step(true); } break; }
      case 'taunt': T.jaw = 0.25 + Math.sin(time * 9) * 0.2; T.n1 = 0.2 + Math.sin(time * 3) * 0.2; break;
      case 'dead': T.by = 0.72; T.n1 = 1.2; T.n2 = 0.7; T.hx = 0.4; T.jaw = 0.55; T.lh = -1.4; T.rh = -1.15; T.lk = 0.3; T.rk = 0.45; T.la = 0.2; T.ra = 0.2; T.hy = 0; T.ty = 0; k = 5; break;
    }
    if (st !== 'hop') this.landed = false;
    const set = (o, x, y, z) => { o.rotation.x = damp(o.rotation.x, x, k, dt); o.rotation.y = damp(o.rotation.y, y, k, dt); o.rotation.z = damp(o.rotation.z, z, k, dt); };
    R.body.position.y = damp(R.body.position.y, T.by, k, dt);
    set(R.body, T.bx, 0, T.bz);
    set(R.n1, T.n1, T.hy * 0.4, 0); set(R.n2, T.n2, T.hy * 0.3, 0); set(R.head, T.hx, T.hy * 0.4, 0);
    set(R.jaw, T.jaw, 0, 0); set(R.tail, T.tx, T.ty, 0);
    set(R.lHip, T.lh, 0, 0); set(R.lKn, T.lk, 0, 0); set(R.lAn, T.la, 0, 0);
    set(R.rHip, T.rh, 0, 0); set(R.rKn, T.rk, 0, 0); set(R.rAn, T.ra, 0, 0);
    R.root.position.copy(this.pos); R.root.position.y = groundH(this.pos.x, this.pos.z);
    R.root.rotation.y = this.yaw;
    if (st === 'dead') { R.root.rotation.z = damp(R.root.rotation.z, this.dieRoll, 4, dt); R.root.position.y = groundH(this.pos.x, this.pos.z) + 0.55 * this.s; }
    const f = this.flash > 0 ? this.flash / 0.12 : 0;
    // focus highlight (as in medieval-sim): the locked beast glows a soft, breathing gold; the one you'd lock next, fainter
    this.hlv = damp(this.hlv || 0, this.hl || 0, 10, dt);
    const h = this.hlv * (0.7 + 0.3 * Math.sin(time * 6));
    for (const m of R.flashMats) { m.emissive.setRGB(0.6 * f, 0.08 * f, 0.04 * f); if (m.userData.hl) m.userData.hl.value = h; } // hit flash; lock-on rim
    const tele = st === 'lungeWind' || st === 'peckWind' ? 1 : 0;
    R.M.eye.emissiveIntensity = damp(R.M.eye.emissiveIntensity, st === 'dead' ? 0 : 2.4 + tele * 5, 10, dt);
  }
  dispose() { scene.remove(this.rig.root); }
}

// ============================================================ combat glue
// Lock-on with the sword drawn: off by default on desktop (hold LMB / E, or press Tab, to lock); on by default on touch.
let hitStop = 0, slowMo = 0, shake = 0, time = 0, lockOn = TOUCH;
const vignette = document.getElementById('vignette');
let vignetteA = 0;

// Lock-on (after medieval-sim's acquireLock): the lock is sticky. It stays on one beast until that beast dies or gets
// out of range, instead of jumping to whichever beast is nearest this frame. A new lock takes the beast roughly in front,
// nearest first (score = distance × (2.2 − facing)). A quick flick of the mouse switches to the next beast on that side.
const LOCK_RANGE = 15;
let lockTarget = null, flickX = 0, flickCd = 0;
const lockable = e => e && !e.dead && e.state !== 'wait' && Math.hypot(e.pos.x - P.pos.x, e.pos.z - P.pos.z) < LOCK_RANGE;
function acquireLock() {
  let best = null, bs = 1e9;
  const fx = Math.sin(P.yaw), fz = Math.cos(P.yaw);
  for (const e of beasts) {
    if (!lockable(e)) continue;
    const dx = e.pos.x - P.pos.x, dz = e.pos.z - P.pos.z, d = Math.hypot(dx, dz) || 1e-3;
    const s = d * (2.2 - (dx * fx + dz * fz) / d);
    if (s < bs) { bs = s; best = e; }
  }
  return best;
}
function currentTarget() {
  if (!P.drawn || !(lockOn || actionHeld() || touch.portrait) || P.state === 'dead') { lockTarget = null; return null; }
  if (!lockable(lockTarget)) lockTarget = acquireLock();
  return lockTarget;
}
// side > 0: the next beast to the right of the current one (as seen from the hero), side < 0: to the left
function switchTarget(side) {
  const cur = currentTarget(); if (!cur) return false;
  const a0 = yawTo(P.pos, cur.pos);
  let best = null, ba = 1e9;
  for (const e of beasts) {
    if (e === cur || !lockable(e)) continue;
    const da = angWrap(yawTo(P.pos, e.pos) - a0) * -side; // yaw decreases to the right
    if (da > 0.05 && da < ba) { ba = da; best = e; }
  }
  if (!best) return false;
  lockTarget = best; SFX.lockSwitch?.();
  return true;
}

function hitPlayer(e, dmg, heavy) {
  if (P.state === 'dead' || P.iframes > 0) return false;
  const angTo = yawTo(P.pos, e.pos);
  const facing = Math.abs(angWrap(angTo - P.yaw)) < 1.25;
  let guardBroken = false;
  const dir = new V3(P.pos.x - e.pos.x, 0, P.pos.z - e.pos.z).normalize();
  hero.root.updateMatrixWorld(true);
  if (P.state === 'block' && facing) {
    const cost = heavy ? 38 : 16;
    const sp = hero.swordMid.getWorldPosition(new V3());
    if (P.st >= cost) {
      P.st -= cost; P.stDelay = 0.8; SFX.block(); sparks(sp, 22); shake = Math.max(shake, 0.18);
      P.vel.copy(dir).multiplyScalar(heavy ? 5 : 2); hitStop = 0.06; popText(sp, 'PARRY', 'block');
      e.onBlocked(heavy); return true;
    }
    P.st = 0; SFX.block(); sparks(sp, 12); dmg = Math.round(dmg * 0.6); heavy = true; popText(sp, 'GUARD BROKEN', 'block');
    guardBroken = true;
  }
  P.hp -= dmg;
  const hp = P.pos.clone().add(new V3(0, 1.35, 0));
  popText(hp, String(dmg), 'player');
  bloodBurst(hp, dir, 14);
  shake = Math.max(shake, heavy ? 0.6 : 0.35); hitStop = 0.06; vignetteA = 1;
  P.pain = Math.min(1.6, (P.pain || 0) + (heavy ? 1.2 : 0.8)); P.painSeed = rand(0, 10);
  P.combo = 0;
  if (P.hp <= 0) { P.hp = 0; P.state = 'dead'; P.t = 0; SFX.scream(); P.pain = 2; P.vel.copy(dir).multiplyScalar(3); onPlayerDeath(); return true; }
  trail.samples.length = 0; hero.bladeMat.emissive.setRGB(0, 0, 0);
  // a charge that lands clean knocks him flat on his back (Gothic's knock-down): he lies there until he gets up
  // (Space, attack or W after a moment, or on his own), untouchable while he is down and for a moment after
  if (e.state === 'lunge' && !guardBroken) {
    P.state = 'down'; P.t = 0; P.iframes = 0.5; P.vel.copy(dir).multiplyScalar(6.5); SFX.knockdown(); dust(P.pos, 10, 0.6, 1.2);
    return true;
  }
  SFX.hurt(heavy);
  P.state = 'hurt'; P.t = 0; P.stunDur = heavy ? 0.75 : 0.36; P.hurtBack = !facing; // hit from behind: pitched forward
  P.vel.copy(dir).multiplyScalar(heavy ? 7.5 : 3);
  return true;
}

function checkPlayerHits() {
  for (const e of beasts) {
    if (e.dead || P.hitSet.has(e) || e.state === 'wait') continue;
    const dx = e.pos.x - P.pos.x, dz = e.pos.z - P.pos.z, d = Math.hypot(dx, dz);
    if (d > 1.55 + e.radius) continue;
    const ang = Math.abs(angWrap(Math.atan2(dx, dz) - P.yaw));
    if (ang > P.swing.arc + 0.3 && !(d < e.radius + 0.5 && ang < 1.7)) continue;
    P.hitSet.add(e);
    if (e.iframes > 0) { SFX.whiff(); continue; }
    const heavy = P.swingType === 'heavy';
    // a cut from behind (the hero is in the beast's back half) bites deeper and always staggers it
    const bf = e.forward(), flank = -(bf.x * dx + bf.z * dz) / Math.max(d, 1e-3) < -0.35;
    const dmg = Math.round(17 * P.swing.dmg * (1 + P.step * 0.12) * (flank ? 1.35 : 1) * rand(0.92, 1.08));
    P.combo++; P.comboT = 2.2;
    if (flank) popText(e.pos.clone().add(new V3(0, 1.9 * e.s, 0)), 'FROM BEHIND', 'timing');
    e.takeHit(dmg, new V3(dx, 0, dz).normalize(), heavy, flank);
  }
}

function startAttack(step, lf, rt, target) {
  let type = COMBO[step];
  if (step < 3) { if (lf) type = 'rl'; else if (rt) type = 'lr'; }
  const sw = SWINGS[type];
  Object.assign(P, { state: 'attack', t: 0, step, swing: sw, swingType: type, queued: false, failed: false, swungSound: false });
  P.swingId++; P.queued = null; P.chainGrace = 0;
  P.hitSet.clear();
  const sp = Math.max(0.72, Math.pow(0.93, step)) * (sw.slow || 1);
  P.times = { w: 0.21 * sp * (sw.wMul || 1), a: 0.11 * sp * (sw.aMul || 1), r: 0.42 * sp };
  P.seg = -1;
  P.st = Math.max(0, P.st - (7 + step * 2)); P.stDelay = 0.6;
  if (target) P.yaw = dampAng(P.yaw, yawTo(P.pos, target.pos), 30, 0.05);
}

// ============================================================ player update
function updatePlayer(dt) {
  const target = currentTarget();
  P.visYaw = 0;
  P.iframes = Math.max(0, P.iframes - dt); P.stDelay -= dt;
  P.comboT -= dt; if (P.comboT <= 0) P.combo = 0;
  flickCd -= dt; flickX *= Math.exp(-10 * dt); // a flick has to be quick, slow drift doesn't add up
  P.chainGrace = (P.chainGrace || 0) - dt;
  const js = touch.stick; // the on-screen joystick (phones), x/y in -1..1, y < 0 = forward
  // action key (left mouse or E, as in medieval-sim): while it is held with the sword out, W A D strike forward / left /
  // right and S guards, instead of moving
  const act = actionHeld() && (P.drawn || P.state === 'draw');
  const kf = !act && (keys.KeyW || keys.ArrowUp), kb = !act && (keys.KeyS || keys.ArrowDown);
  const kl = !act && (keys.KeyA || keys.ArrowLeft), kr = !act && (keys.KeyD || keys.ArrowRight);
  const fw = kf || js.y < -0.5, bw = kb || js.y > 0.5, lf = kl || js.x < -0.5, rt = kr || js.x > 0.5;
  const wantAttack = pressed.has('Attack') || pressed.has('KeyJ') || pressed.has('AtkF') || pressed.has('AtkL') || pressed.has('AtkR');
  const swL = pressed.has('AtkL') || (lf && !pressed.has('AtkF') && !pressed.has('AtkR')), swR = pressed.has('AtkR') || (rt && !pressed.has('AtkF') && !pressed.has('AtkL'));
  const wantBlock = mouseR || keys.KeyK || touch.parry || (act && (keys.KeyS || keys.ArrowDown));
  const wantDraw = pressed.has('KeyF') || pressed.has('Digit1') || pressed.has('Draw');
  const wantDodge = pressed.has('Space');
  const sprint = keys.ShiftLeft || keys.ShiftRight || Math.hypot(js.x, js.y) > 0.95;
  const canAct = game.state === 'play' || game.state === 'between';
  let tp = null, k = 14;
  const fwdV = new V3(Math.sin(P.yaw), 0, Math.cos(P.yaw));
  const rightV = new V3(-Math.cos(P.yaw), 0, Math.sin(P.yaw));
  let desired = new V3(), velK = 12, moving = false;

  const startDodge = () => {
    P.state = 'dodge'; P.t = 0; P.st -= 18; P.stDelay = 0.6; P.iframes = 0.28;
    const dirx = (target && (lf || rt)) ? rightV.clone().multiplyScalar(rt ? 1 : -1) : fwdV.clone().multiplyScalar(-1);
    P.dodgeDir.copy(dirx); SFX.dodge(); dust(P.pos, 5, 0.3, 0.8); trail.samples.length = 0;
  };
  const startDraw = () => { P.state = 'draw'; P.t = 0; P.swapDone = false; };
  // a jump: a ballistic hop (gravity 14 m/s²) that keeps the run-up's momentum, with a little steering in the air
  const startJump = fwd => {
    P.state = 'jump'; P.t = 0; P.vy = 4.9; P.jumpVel.set(P.vel.x, 0, P.vel.z);
    if (fwd && P.jumpVel.length() < 2) P.jumpVel.addScaledVector(fwdV, 2);
    if (P.drawn) { P.st -= 8; P.stDelay = 0.5; }
    SFX.dodge(); dust(P.pos, 4, 0.3, 0.6); trail.samples.length = 0;
  };

  switch (P.state) {
    case 'idle':
    case 'block': {
      if (!canAct) { tp = P.drawn ? POSE.stance : POSE.relaxed; break; }
      if (wantDraw) { startDraw(); break; }
      if (wantAttack) {
        if (!P.drawn) { startDraw(); break; }
        // a strike right after the last one finished still chains (a forgiving late window)
        const late = P.chainGrace > 0 && P.lastStep < COMBO.length - 1;
        if (P.st >= 6) { startAttack(late ? P.lastStep + 1 : 0, swL, swR, target); if (late) popText(hero.swordTip.getWorldPosition(new V3()), 'GOOD', 'timing'); break; }
      }
      // Space: locked on, a step back (with a moment of invulnerability); otherwise a jump
      if (wantDodge && target && P.st >= 18) { startDodge(); break; }
      if (wantDodge && !target && P.jy <= 0 && (!P.drawn || P.st >= 8)) { startJump(fw); break; }
      P.state = wantBlock && P.drawn ? 'block' : 'idle';
      let turn = 0, f = 0, s = 0;
      if (js.active) { // analog: how far the stick is pushed sets the speed
        const dz = v => (Math.abs(v) < 0.15 ? 0 : v);
        f = -dz(js.y) * (js.y > 0 ? 0.65 : 1);
        if (target) s = dz(js.x); else turn = -dz(js.x) * 0.8;
      } else {
        if (fw) f += 1; if (bw) f -= 0.65;
        if (target) { if (lf) s -= 1; if (rt) s += 1; } else { if (lf) turn += 1; if (rt) turn -= 1; }
      }
      P.yaw += turn * 2.9 * dt;
      if (target) P.yaw = dampAng(P.yaw, yawTo(P.pos, target.pos), 9, dt);
      let speed = P.drawn ? (sprint ? 4.8 : 3.5) : (sprint ? 6.8 : 4.4);
      if (P.state === 'block') speed = 1.3;
      desired.addScaledVector(fwdV, f).addScaledVector(rightV, s * 0.9);
      if (desired.length() > 1) desired.normalize();
      desired.multiplyScalar(speed);
      if (P.state === 'block') { tp = POSE.block; k = 22; }
      else tp = P.drawn ? POSE.stance : POSE.relaxed;
      moving = true;
      break;
    }
    case 'draw': {
      P.t += dt;
      if (!P.swapDone && P.t > 0.26) { P.swapDone = true; P.drawn = !P.drawn; setSwordInHand(P.drawn); (P.drawn ? SFX.draw : SFX.sheath)(); }
      tp = P.t < 0.32 ? POSE.draw : (P.drawn ? POSE.stance : POSE.relaxed); k = 16;
      if (fw) desired.copy(fwdV).multiplyScalar(2.2);
      if (lf && !target) P.yaw += 2 * dt; if (rt && !target) P.yaw -= 2 * dt;
      moving = true;
      if (P.t > 0.55) P.state = 'idle';
      break;
    }
    case 'attack': {
      P.t += dt;
      const { w, a, r } = P.times, tot = w + a + r, winStart = w + a + 0.05;
      // Chaining: the next strike has to wait until this one has landed. The window opens just after the cut (when the
      // blade glints) and runs to the end of the recovery, plus a short grace after it (`chainGrace` in idle). A press up
      // to 70 ms early is still taken (human timing), and fires as the window opens. Anything earlier, so mashing too,
      // breaks the chain.
      if (wantAttack && P.step < COMBO.length - 1 && !P.failed) {
        if (P.t < winStart - 0.07) { P.failed = true; P.queued = null; popText(hero.swordTip.getWorldPosition(new V3()), 'TOO EARLY', 'timing'); }
        else P.queued = { l: swL, r: swR, at: P.t };
      }
      if (P.queued && !P.failed && P.t >= winStart && P.st >= 4) {
        const q = P.queued, late = (P.t - winStart) / (tot - winStart);
        popText(hero.swordTip.getWorldPosition(new V3()), late < 0.35 ? 'PERFECT' : 'GOOD', 'timing');
        startAttack(P.step + 1, q.l, q.r, target);
        break;
      }
      if (wantDodge && P.t > w + a && target && P.st >= 18) { startDodge(); hero.bladeMat.emissive.setRGB(0, 0, 0); break; }
      if (wantDodge && P.t > w + a && !target && P.st >= 8) { startJump(fw); hero.bladeMat.emissive.setRGB(0, 0, 0); break; }
      if (!P.swungSound && P.t >= w * 0.7) { SFX.swing(P.step); P.swungSound = true; }
      if (P.t < w && target) P.yaw = dampAng(P.yaw, yawTo(P.pos, target.pos), 10, dt);
      else if (P.t < w) { if (lf) P.yaw += 1.2 * dt; if (rt) P.yaw -= 1.2 * dt; }
      let v = 0;
      if (P.t >= w * 0.5 && P.t < w + a) v = P.swing.lunge * 2.6; else if (P.t < w + a + r * 0.3) v = P.swing.lunge * 0.5;
      desired.copy(fwdV).multiplyScalar(v); velK = 20;
      const sw = P.swing, seq = sw.seq, W = POSE[sw.w], base = POSE.stance, last = POSE[seq[seq.length - 1]];
      if (P.t < w) tp = blend(base, W, easeOut(P.t / w));                       // quick wind-up that hangs for an instant
      else if (P.t < w + a + 0.025) {
        const u = Math.min(0.9999, (P.t - w) / a) * seq.length, i = Math.floor(u);
        const cutting = !sw.cuts || sw.cuts.includes(i);
        if (i !== P.seg) { P.seg = i; if (i > 0 && cutting && !sw.once) { P.hitSet.clear(); SFX.swing(P.step); } } // each cut of a weaving strike can land
        if (cutting) checkPlayerHits();
        tp = blend(i ? POSE[seq[i - 1]] : W, POSE[seq[i]], cutting ? easeIn(u - i) : ease(u - i)); // cuts accelerate into the target
      } else {
        const x = (P.t - w - a) / r;                                              // follow through past the end of the cut, then recover
        tp = x < 0.3 ? blend(seq.length > 1 ? POSE[seq[seq.length - 2]] : W, last, 1 + 0.07 * Math.sin(Math.PI * x / 0.3))
          : blend(last, base, ease(clamp((x - 0.3) / 0.7, 0, 1)));
      }
      tp = blend(tp, tp, 0); tp.hipR[1] += tp.spine[1] * 0.26; tp.spine[1] *= 0.82; // the hips turn into the blow, not just the chest
      if (sw.spin) P.visYaw = -Math.PI * 2 * ease(clamp((P.t - w * 0.45) / (w * 0.55 + a * 0.85), 0, 1)); // the whole body goes round
      k = 30;
      const inWin = P.step < COMBO.length - 1 && !P.failed && P.t >= winStart - 0.07;
      const g = inWin ? 0.6 + 0.4 * Math.sin(P.t * 40) : 0;
      hero.bladeMat.emissive.setRGB(0.9 * g, 0.55 * g, 0.2 * g);
      if (P.t >= tot) { P.state = 'idle'; hero.bladeMat.emissive.setRGB(0, 0, 0); if (!P.failed) { P.chainGrace = 0.3; P.lastStep = P.step; } }
      break;
    }
    case 'jump': {
      P.t += dt; P.vy -= 14 * dt; P.jy += P.vy * dt;
      desired.copy(P.jumpVel); velK = 1.2;
      if (fw) desired.addScaledVector(fwdV, 1.5); if (bw) desired.addScaledVector(fwdV, -1);
      if (!target) { if (lf) P.yaw += 1.6 * dt; if (rt) P.yaw -= 1.6 * dt; }
      tp = P.vy > 0 ? POSE.jumpUp : POSE.jumpDown; k = 12;
      if (P.jy <= 0 && P.vy < 0) { P.jy = 0; P.vy = 0; P.state = 'land'; P.t = 0; SFX.step(true); dust(P.pos, 6, 0.4, 0.8); }
      break;
    }
    case 'land': { // knees soak up the landing
      P.t += dt; tp = POSE.dodge; k = 20; velK = 8;
      if (fw) desired.copy(fwdV).multiplyScalar(2);
      if (P.t > 0.14) P.state = 'idle';
      break;
    }
    case 'dodge': {
      P.t += dt; const u = P.t / 0.36;
      desired.copy(P.dodgeDir).multiplyScalar(7.5 * (1 - u)); velK = 30;
      tp = POSE.dodge; k = 20;
      if (P.t > 0.36) P.state = 'idle';
      break;
    }
    case 'hurt': {
      P.t += dt; tp = P.hurtBack ? POSE.hurtB : POSE.hurt; k = 18; velK = 5;
      if (P.t > P.stunDur) P.state = 'idle';
      break;
    }
    case 'down': { // flat on his back in the sand
      P.t += dt; tp = POSE.down; k = 9; velK = 4;
      hero.root.rotation.x = damp(hero.root.rotation.x, -1.45, 9, dt);
      hero.root.position.y = damp(hero.root.position.y, groundH(P.pos.x, P.pos.z) + 0.12, 9, dt);
      P.iframes = Math.max(P.iframes, 0.5);
      if (P.t > 2.4 || (P.t > 0.7 && (wantDodge || wantAttack || fw))) { P.state = 'getup'; P.t = 0; SFX.dodge(); dust(P.pos, 6, 0.4, 0.8); }
      break;
    }
    case 'getup': { // rolls up onto his feet, still crouched, then back on guard
      P.t += dt; tp = POSE.dodge; k = 12; velK = 10;
      hero.root.rotation.x = damp(hero.root.rotation.x, 0, 11, dt);
      hero.root.position.y = damp(hero.root.position.y, groundH(P.pos.x, P.pos.z), 11, dt);
      P.iframes = Math.max(P.iframes, 0.3);
      if (P.t > 0.5) { P.state = 'idle'; hero.root.rotation.x = 0; }
      break;
    }
    case 'dead': {
      P.t += dt; tp = POSE.dead; k = 6; velK = 3;
      hero.root.rotation.x = damp(hero.root.rotation.x, -1.45, 5, dt);
      hero.root.position.y = damp(hero.root.position.y, groundH(P.pos.x, P.pos.z) + 0.12, 5, dt);
      break;
    }
  }
  if (!tp) tp = P.drawn ? POSE.stance : POSE.relaxed;

  // ---- locomotion, layered on top of the upper-body pose
  P.vel.x = damp(P.vel.x, desired.x, velK, dt); P.vel.z = damp(P.vel.z, desired.z, velK, dt);
  const spd = Math.hypot(P.vel.x, P.vel.z);
  tp = blend(tp, tp, 0);
  P.gaitW = damp(P.gaitW, moving && spd > 0.3 ? 1 : 0, 9, dt); // the cycle eases in and out instead of snapping on
  const gw = P.gaitW;
  if (gw > 0.02) {
    const a = Math.min(1.2, spd / 4.2) * gw, run = clamp((spd - 4) / 2.5, 0, 1) * gw;
    P.gait += dt * (4 + spd * 1.7);
    const s = Math.sin(P.gait), c = Math.cos(P.gait);
    const fdot = spd > 0.05 ? (P.vel.x * fwdV.x + P.vel.z * fwdV.z) / spd : 1, sdot = spd > 0.05 ? (P.vel.x * rightV.x + P.vel.z * rightV.z) / spd : 0;
    const dir = fdot < -0.3 ? -1 : 1, fa = Math.max(0.3, Math.abs(fdot));
    // legs: swing from the hip; the knee folds only on the leg travelling forward and folds deeper at a run
    tp.lHip[0] = tp.lHip[0] * (1 - 0.75 * gw) - s * 0.7 * a * dir * fa; tp.rHip[0] = tp.rHip[0] * (1 - 0.75 * gw) + s * 0.7 * a * dir * fa;
    tp.lKn[0] = lerp(tp.lKn[0], 0.12 + Math.max(0, c * dir) * (1.1 + run * 0.5) * a, gw); tp.rKn[0] = lerp(tp.rKn[0], 0.12 + Math.max(0, -c * dir) * (1.1 + run * 0.5) * a, gw);
    // side-stepping: the legs open and close across the body instead of scissoring forward
    tp.lHip[2] += s * 0.24 * sdot * a; tp.rHip[2] += s * 0.24 * sdot * a;
    // pelvis and chest: the hips twist with the stride and dip over the swinging leg, the chest counter-rotates, the head stays level
    tp.hipR[1] += s * 0.13 * a * dir * fa; tp.hipR[2] += c * 0.03 * a;
    tp.spine[1] -= s * 0.2 * a * dir * fa; tp.spine[2] -= c * 0.035 * a; tp.neck[1] += s * 0.07 * a * dir * fa; tp.neck[2] += c * 0.02 * a;
    tp.hy += (-Math.abs(c) * 0.05 + 0.02) * a;
    tp.spine[0] += (P.drawn ? 0.05 : 0.08) * a + run * 0.13; tp.neck[0] -= run * 0.1;
    if (P.state === 'idle') {
      if (!P.drawn) { // free arms swing opposite the legs, elbows folding as each arm comes forward — pumping when running
        tp.lSh[0] = lerp(tp.lSh[0], s * (0.55 + run * 0.35) * a * dir, gw); tp.rSh[0] = lerp(tp.rSh[0], -s * (0.55 + run * 0.35) * a * dir, gw);
        tp.lEl[0] = lerp(tp.lEl[0], -0.25 - Math.max(0, -s * dir) * 0.5 * a - run * 0.7, gw); tp.rEl[0] = lerp(tp.rEl[0], -0.25 - Math.max(0, s * dir) * 0.5 * a - run * 0.7, gw);
      } else { // on guard: the free hand balances the stride and the blade bobs with each step
        tp.lSh[0] += s * 0.2 * a * dir; tp.lEl[0] -= Math.max(0, -s * dir) * 0.2 * a; tp.rSh[0] -= s * 0.06 * a; tp.rHa[0] += c * 0.06 * a;
      }
    }
    const sg = Math.sign(s); if (sg !== P.lastSg) { P.lastSg = sg; SFX.step(false); if (spd > 5) dust(P.pos, 1, 0.2, 0.5); }
  }
  // lean into acceleration and braking, and bank into turns
  if (P.state === 'idle' || P.state === 'block') tp.spine[0] += clamp(((desired.x - P.vel.x) * fwdV.x + (desired.z - P.vel.z) * fwdV.z) * 0.022, -0.1, 0.14);
  P.bank = damp(P.bank, clamp(angWrap(P.yaw - P.prevYaw) / Math.max(dt, 1e-3) * 0.045, -0.14, 0.14), 6, dt); P.prevYaw = P.yaw;
  tp.spine[2] -= P.bank; tp.neck[2] += P.bank * 0.5;
  // ---- always alive: breathing lifts the chest and shoulders
  const br = Math.sin(time * 1.9);
  tp.spine[0] += br * 0.022; tp.neck[0] -= br * 0.014; tp.lSh[2] += br * 0.018; tp.rSh[2] -= br * 0.018; tp.hy += br * 0.004;
  // ---- standing still: weight drifts from foot to foot, the head looks about, and on guard the blade never quite rests
  const iw = (1 - gw) * (P.state === 'idle' ? 1 : P.state === 'block' ? 0.4 : 0);
  if (iw > 0.02) {
    const ws = Math.sin(time * 0.55 + Math.sin(time * 0.21) * 1.5);
    tp.hipR[2] += ws * 0.045 * iw; tp.spine[2] -= ws * 0.055 * iw; tp.neck[2] += ws * 0.02 * iw; tp.hy -= Math.abs(ws) * 0.008 * iw;
    tp.lKn[0] += Math.max(0, ws) * 0.1 * iw; tp.rKn[0] += Math.max(0, -ws) * 0.1 * iw;
    if (!target) { tp.neck[1] += (Math.sin(time * 0.31) * 0.16 + Math.sin(time * 0.83 + 1) * 0.06) * iw; tp.neck[0] += Math.sin(time * 0.23 + 2) * 0.04 * iw; }
    if (P.drawn) { // light on his feet, point circling
      tp.hy += Math.sin(time * 3.2) * 0.01 * iw; tp.lKn[0] += (0.04 + Math.sin(time * 3.2) * 0.03) * iw; tp.rKn[0] += (0.04 + Math.sin(time * 3.2) * 0.03) * iw;
      tp.rSh[0] += Math.sin(time * 1.7) * 0.035 * iw; tp.rHa[0] += Math.sin(time * 2.3 + 0.5) * 0.06 * iw; tp.rHa[1] += Math.cos(time * 2.3 + 0.5) * 0.05 * iw;
      tp.lSh[0] += Math.sin(time * 1.3 + 2) * 0.04 * iw; tp.spine[1] += Math.sin(time * 0.9) * 0.025 * iw;
    } else { // at ease: arms hang and sway, shoulders settle
      tp.lSh[0] += Math.sin(time * 0.9) * 0.03 * iw; tp.rSh[0] += Math.sin(time * 0.9 + 1.3) * 0.03 * iw;
      tp.lEl[0] -= (0.04 + Math.sin(time * 0.7 + 0.5) * 0.03) * iw; tp.rEl[0] -= (0.04 + Math.sin(time * 0.7 + 2.1) * 0.03) * iw;
    }
  }
  // pain: after a hit he writhes (twisting, doubling over, clutching the wound) and it fades over a second or so;
  // when he dies he thrashes on the ground before going still
  if (P.pain > 0.01) {
    const dead = P.state === 'dead', busy = P.state === 'attack' || P.state === 'block' || P.state === 'dodge';
    const pn = Math.min(1, P.pain) * (busy ? 0.3 : 1), w = time * (dead ? 8 : 11) + P.painSeed;
    tp.spine[0] += (0.2 + Math.sin(w * 0.7) * 0.14) * pn;       // doubles over
    tp.spine[1] += Math.sin(w) * 0.35 * pn;                      // twists
    tp.spine[2] += Math.sin(w * 1.3 + 1) * 0.22 * pn;            // bends to the side
    tp.neck[0] += Math.sin(w * 1.7) * 0.28 * pn; tp.neck[1] += Math.sin(w * 0.9 + 2) * 0.35 * pn;
    if (!busy) { tp.lSh[0] -= (0.5 + Math.sin(w * 1.1) * 0.25) * pn; tp.lSh[2] -= 0.35 * pn; tp.lEl[0] -= 1.2 * pn; } // clutches the wound
    tp.lKn[0] += Math.max(0, Math.sin(w * 0.8)) * 0.4 * pn; tp.rKn[0] += Math.max(0, -Math.sin(w * 0.8)) * 0.4 * pn;
    if (dead) { // kicking and clawing at the sand
      tp.lHip[0] -= Math.sin(w * 1.2) * 0.7 * pn; tp.rHip[0] += Math.sin(w * 1.2 + 0.8) * 0.7 * pn;
      tp.lKn[0] += Math.abs(Math.sin(w * 1.2)) * 0.6 * pn; tp.rKn[0] += Math.abs(Math.sin(w * 1.2 + 0.8)) * 0.6 * pn;
      tp.rSh[0] += Math.sin(w * 0.9) * 0.8 * pn; tp.rEl[0] -= Math.abs(Math.sin(w * 1.4)) * 0.8 * pn;
      hero.root.rotation.z = Math.sin(w * 0.6) * 0.18 * pn;
    } else tp.hy -= 0.05 * pn;
    k = Math.max(k, 14 * pn);
    P.pain = Math.max(0, P.pain - dt * (dead ? 0.5 : 1.1));
  } else if (P.state === 'dead') hero.root.rotation.z = damp(hero.root.rotation.z, 0, 3, dt);
  applyHero(tp, k, dt);

  if (P.state !== 'block' && P.state !== 'attack' && P.state !== 'dodge' && P.stDelay <= 0) P.st = Math.min(P.maxSt, P.st + 32 * dt);
  if (P.state === 'block') P.st = Math.min(P.maxSt, P.st + 6 * dt);

  P.pos.addScaledVector(P.vel, dt);
  const l = Math.hypot(P.pos.x, P.pos.z);
  if (l > ARENA_R) { P.pos.x *= ARENA_R / l; P.pos.z *= ARENA_R / l; }
  hero.root.position.x = P.pos.x; hero.root.position.z = P.pos.z;
  // knocked out of a jump (hit in the air): he still falls back down
  if (P.state !== 'jump' && P.jy > 0) { P.vy -= 14 * dt; P.jy = Math.max(0, P.jy + P.vy * dt); if (P.jy === 0) P.vy = 0; }
  if (!isDown()) { hero.root.position.y = groundH(P.pos.x, P.pos.z) + P.jy; hero.root.rotation.x = 0; hero.root.rotation.z = 0; }
  hero.root.rotation.y = P.yaw + P.visYaw;
  hero.root.updateMatrixWorld(true);
  if (P.state === 'attack') {
    const { w, a } = P.times;
    if (P.t > w * 0.55 && P.t < w + a + 0.07) trail.push(hero.swordBase.getWorldPosition(new V3()), hero.swordTip.getWorldPosition(new V3()), P.swingType === 'heavy' ? 1.4 : 1);
  }
}

function separate() {
  const all = beasts.filter(e => !e.dead && e.state !== 'wait');
  for (const e of all) {
    const dx = e.pos.x - P.pos.x, dz = e.pos.z - P.pos.z, d = Math.hypot(dx, dz), min = e.radius + 0.4;
    if (d < min && d > 0.0001 && P.state !== 'dead') {
      const push = min - d, nx = dx / d, nz = dz / d;
      P.pos.x -= nx * push * 0.65; P.pos.z -= nz * push * 0.65;
      e.pos.x += nx * push * 0.35; e.pos.z += nz * push * 0.35;
    }
  }
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
    const a = all[i], b = all[j];
    const dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z, d = Math.hypot(dx, dz), min = a.radius + b.radius;
    if (d < min && d > 0.0001) { const p = (min - d) / 2, nx = dx / d, nz = dz / d; a.pos.x -= nx * p; a.pos.z -= nz * p; b.pos.x += nx * p; b.pos.z += nz * p; }
  }
}

// ============================================================ rounds
const game = { state: 'title', round: 0, betweenT: 0, deadT: 0 };
const $ = id => document.getElementById(id);
function showMsg(text, sub = '', dur = 2.2) {
  $('msg').textContent = text; $('msg').style.opacity = 1;
  $('sub').textContent = sub; $('sub').style.opacity = sub ? 1 : 0;
  clearTimeout(showMsg.t); showMsg.t = setTimeout(() => { $('msg').style.opacity = 0; $('sub').style.opacity = 0; }, dur * 1000);
}
function startRound(n) {
  game.round = n; game.state = 'play';
  for (const e of beasts) e.dispose();
  beasts.length = 0;
  const count = n >= 5 ? 3 : n >= 3 ? 2 : 1;
  for (let i = 0; i < count; i++) beasts.push(new Beast(n, (i - (count - 1) / 2) * 0.6, 1.2 + i * 2.4));
  $('round').textContent = 'ROUND ' + toRoman(n);
  showMsg('ROUND ' + toRoman(n), count > 1 ? `${count} beasts enter the stockade` : 'a beast enters the stockade');
  SFX.gong();
}
function onBeastDeath() {
  if (beasts.every(e => e.dead) && game.state === 'play') {
    game.state = 'between'; game.betweenT = 4.2;
    setTimeout(() => showMsg('VICTORY', 'catch your breath', 3), 600);
  }
}
function onPlayerDeath() {
  game.state = 'dead'; game.deadT = 0;
  SFX.thud();
  setTimeout(() => {
    showOverlay(`<div class="logo small"><img class="emblem" src="icon-512.png" alt=""></div><h1>YOU HAVE FALLEN</h1><div class="tag">REACHED ROUND ${toRoman(game.round)}</div>
      <p>Watch the eyes: they flare before every strike. Parry the pecks, step back from the charge, then punish the recovery.</p>
      <button id="startBtn">FIGHT AGAIN</button>`);
  }, 2200);
}
function resetGame() {
  Object.assign(P, { hp: P.maxHp, st: P.maxSt, state: 'idle', t: 0, combo: 0, ghostHp: P.maxHp, iframes: 0, pain: 0, jy: 0, vy: 0 });
  P.pos.set(0, 0, 7); P.vel.set(0, 0, 0); P.yaw = Math.PI;
  hero.root.rotation.x = 0; hero.root.position.y = 0;
  for (const d of decals) d.visible = false;
  startRound(1);
}
function toRoman(n) { const r = [[10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']]; let s = ''; for (const [v, c] of r) while (n >= v) { s += c; n -= v; } return s; }

function showOverlay(html) {
  $('panel').innerHTML = html; $('overlay').classList.remove('hidden');
  if (document.pointerLockElement) document.exitPointerLock();
  $('startBtn').onclick = begin;
}
function begin() {
  initAudio();
  goFullscreen();
  $('overlay').classList.add('hidden');
  resetGame();
  lockPointer();
}
$('startBtn').onclick = begin;

// ============================================================ pause menu
// res: 'auto' (adapts to the frame rate) or a fixed share of the full resolution. Phones start without light shafts.
const settings = { sens: 1, sound: 0.6, bright: 1, weather: 'dynamic', res: 'auto', perf: false, shafts: !TOUCH };
try { Object.assign(settings, JSON.parse(localStorage.getItem('arena-settings') || '{}')); } catch (e) { /* storage unavailable */ }
// brightness (like medieval-sim's): scales the tone-mapping exposure, so it lifts the gloom without washing out the sky
const applyBright = () => Daylight.update(); // brightness scales the exposure, which the time of day also sets
applyBright();
const saveSettings = () => { try { localStorage.setItem('arena-settings', JSON.stringify({ ...settings, music: Music.volume, lockOn, lockV: 2 })); } catch (e) { /* ignore */ } };
try { const st = JSON.parse(localStorage.getItem('arena-settings') || '{}'); if (typeof st.lockOn === 'boolean' && st.lockV === 2) lockOn = st.lockOn; /* older saves stored the old always-on default */ if (typeof st.music === 'number') Music.setVolume(st.music); } catch (e) { /* ignore */ }
let paused = false, resumeGuard = 0;
const canPause = () => (game.state === 'play' || game.state === 'between') && $('overlay').classList.contains('hidden');
function pauseGame() {
  if (paused || !canPause()) return;
  paused = true;
  for (const k in keys) keys[k] = false; mouseR = false; mouseL = false; touch.reset?.();
  $('optMusic').value = Music.volume; $('optSound').value = settings.sound; $('optSens').value = settings.sens; $('optLock').checked = lockOn;
  $('optBright').value = settings.bright; $('optWeather').value = settings.weather; $('optShafts').checked = settings.shafts !== false;
  $('optRes').value = String(settings.res); $('optPerf').checked = !!settings.perf;
  $('pause').classList.remove('hidden');
  if (document.pointerLockElement) document.exitPointerLock();
  Music.duck(true);
}
function resumeGame() {
  if (!paused) return;
  paused = false; resumeGuard = performance.now();
  $('pause').classList.add('hidden');
  Music.duck(false);
  last = performance.now();
  lockPointer();
}
// build stamp (version.js), shown on the loading, title and pause screens so you can tell which version is deployed
{ // shown in the player's own time zone
  const d = new Date(BUILD.date);
  $('build').textContent = `BUILD ${BUILD.build} · ${isNaN(d) ? BUILD.date : d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
}
$('resumeBtn').onclick = resumeGame;
$('ctlBtn').onclick = () => $('pctl').classList.toggle('open');
$('restartBtn').onclick = () => { resumeGame(); resetGame(); };
$('optMusic').oninput = e => { Music.setVolume(+e.target.value); saveSettings(); };
$('optSound').oninput = e => { settings.sound = +e.target.value; if (master) master.gain.value = settings.sound; saveSettings(); };
$('optSens').oninput = e => { settings.sens = +e.target.value; saveSettings(); };
$('optLock').onchange = e => { lockOn = e.target.checked; saveSettings(); };
$('optBright').oninput = e => { settings.bright = +e.target.value; applyBright(); saveSettings(); };
$('optWeather').onchange = e => { settings.weather = e.target.value; saveSettings(); };
$('optShafts').onchange = e => { settings.shafts = e.target.checked; saveSettings(); };
$('optRes').onchange = e => { settings.res = e.target.value === 'auto' ? 'auto' : +e.target.value; applyResSetting(); saveSettings(); };
$('optPerf').onchange = e => { settings.perf = e.target.checked; perfEl.style.display = settings.perf ? 'block' : 'none'; saveSettings(); };
// losing pointer lock (the browser eats the first Esc press) or the window losing focus pauses the game
document.addEventListener('pointerlockchange', () => {
  if (!document.pointerLockElement && performance.now() - resumeGuard > 300) pauseGame();
});
addEventListener('blur', () => pauseGame());
// a hidden tab goes silent (medieval-sim does the same), so two open tabs never play over each other
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { pauseGame(); AC?.suspend(); } else AC?.resume();
});

// ============================================================ input
const keys = {}; const pressed = new Set(); let mouseR = false;
// The action key (medieval-sim's modern scheme): left mouse or E. Holding it locks on to the beast in front; with the
// sword out, W / A / D then strike forward / left / right (press again to chain) and S guards. Pressing it while a
// direction is already held strikes at once. A quick click on its own also strikes forward.
let mouseL = false, actT = 0, actUsed = false;
const actionHeld = () => mouseL || !!keys.KeyE;
const ACT_DIRS = { KeyW: 'AtkF', ArrowUp: 'AtkF', KeyA: 'AtkL', ArrowLeft: 'AtkL', KeyD: 'AtkR', ArrowRight: 'AtkR' };
function actionPress() {
  if (actionHeld()) return; // the other action input is already down
  actT = performance.now(); actUsed = false;
  const held = Object.keys(ACT_DIRS).find(k => keys[k]);
  if (held) { pressed.add(ACT_DIRS[held]); actUsed = true; }
}
function actionRelease() {
  if (actionHeld()) return;
  if (!actUsed && performance.now() - actT < 250 && !(keys.KeyS || keys.ArrowDown)) pressed.add('Attack');
}
// Ctrl draws the sword, and browsers never let a page block Ctrl+W: ask before the tab closes mid-fight
addEventListener('beforeunload', e => { if (game.state === 'play' || game.state === 'between') { e.preventDefault(); e.returnValue = ''; } });
addEventListener('keydown', e => {
  if (['Tab', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
  if (e.ctrlKey && game.state !== 'title' && !paused) e.preventDefault(); // Ctrl+S, Ctrl+D… (Ctrl+W can't be stopped)
  if (!keys[e.code]) {
    pressed.add(e.code);
    if (e.code === 'KeyE' && !paused) actionPress();
    if (ACT_DIRS[e.code] && actionHeld() && (P.drawn || P.state === 'draw')) { pressed.add(ACT_DIRS[e.code]); actUsed = true; }
    if (e.code === 'KeyS' && actionHeld()) actUsed = true;
    if (e.code === 'ControlLeft' || e.code === 'ControlRight') pressed.add('Draw');
  }
  keys[e.code] = true;
  if (e.code === 'Escape') { if (paused) resumeGame(); else pauseGame(); return; }
  if (paused) return;
  if (e.code === 'Tab') lockOn = !lockOn;
  if (e.code === 'KeyH') { const on = getComputedStyle($('help')).display !== 'none'; document.body.classList.toggle('helpOn', !on); document.body.classList.toggle('helpOff', on); }
  if (e.code === 'KeyM' && master) master.gain.value = master.gain.value > 0 ? 0 : settings.sound;
  if (e.code === 'KeyN') Music.toggle();
});
addEventListener('keyup', e => { keys[e.code] = false; if (e.code === 'KeyE') actionRelease(); });
addEventListener('blur', () => { for (const k in keys) keys[k] = false; mouseR = false; mouseL = false; });
renderer.domElement.addEventListener('mousedown', e => {
  if (game.state === 'title' || paused) return;
  if (document.pointerLockElement !== renderer.domElement) lockPointer();
  if (e.button === 0) { actionPress(); mouseL = true; }
  if (e.button === 2) mouseR = true;
  if (e.button === 1) { lockOn = !lockOn; e.preventDefault(); }
});
addEventListener('mouseup', e => { if (e.button === 2) mouseR = false; if (e.button === 0 && mouseL) { mouseL = false; actionRelease(); } });
addEventListener('contextmenu', e => e.preventDefault());
let camYaw = Math.PI, camPitch = 0.3, camDist = 4.8, lookBack = false;
addEventListener('mousemove', e => {
  if (document.pointerLockElement !== renderer.domElement) return;
  const mx = e.movementX, my = e.movementY;
  if (Math.abs(mx) > 300 || Math.abs(my) > 300) return; // Chrome on Windows sometimes reports huge bogus jumps under pointer lock
  look(mx, my);
});
// mouse (and the touch look-pad): turns the hero and tilts the camera; locked on, a quick sideways flick switches beast
function look(mx, my) {
  if (currentTarget()) { // locked on: the mouse doesn't turn the hero, but a quick flick switches target
    flickX += mx * settings.sens;
    if (Math.abs(flickX) > 140 && flickCd <= 0) { if (switchTarget(Math.sign(flickX))) flickCd = 0.35; flickX = 0; }
  } else if (!isDown() && P.state !== 'attack') P.yaw -= mx * 0.0024 * settings.sens;
  camPitch = clamp(camPitch + my * 0.0018 * settings.sens, -0.75, 0.85);
}
// raw (unaccelerated) mouse deltas where the browser supports them, so turning doesn't depend on OS mouse acceleration
function lockPointer() {
  const el = renderer.domElement;
  try { const r = el.requestPointerLock?.({ unadjustedMovement: true }); if (r && r.catch) r.catch(() => el.requestPointerLock?.()?.catch?.(() => {})); }
  catch (e) { try { el.requestPointerLock?.(); } catch (e2) { /* not allowed right now */ } }
}
addEventListener('wheel', e => { camDist = clamp(camDist + Math.sign(e.deltaY) * 0.4, 2.8, 9); }, { passive: true });

// ---- touch controls: a floating joystick under the left thumb, a look-pad for the right thumb (drag turns the hero and
// tilts the camera; locked on, a quick sideways flick switches beast), and buttons for strike, parry, step back, draw,
// lock-on and pause. They show on phones and tablets, and on any device the moment it is touched.
//
// Held upright (portrait) the controls are simplified for thumbs: the joystick lives in the lower-left quarter, and the
// rest of the screen is one gesture area. Tap = strike (tap again as the blade glints to chain), touch and hold = guard
// (the parry), swipe left / right = a side cut, swipe down = step back (and get up after a knock-down). The sword draws
// itself on the first strike and lock-on is always on; a small button cycles the target.
const touch = { stick: { x: 0, y: 0, active: false }, parry: false, enabled: false, portrait: false };
(function touchControls() {
  const pad = $('tpad'), stick = $('stick'), knob = $('knob'), ring = $('gest'), R = 55;
  let stickId = null, lookId = null, sx = 0, sy = 0, lx = 0, ly = 0;
  let gId = null, gx = 0, gy = 0, gt = 0, gHold = null, gDone = false, gBlock = false;
  function enable() { if (touch.enabled) return; touch.enabled = true; document.body.classList.add('touch'); orient(); }
  function orient() {
    touch.portrait = touch.enabled && innerHeight > innerWidth;
    document.body.classList.toggle('portrait', touch.portrait);
  }
  addEventListener('resize', orient);
  if (TOUCH) enable();
  addEventListener('touchstart', enable, { passive: true, capture: true });
  const playing = () => !paused && game.state !== 'title';
  const buzz = ms => { try { navigator.vibrate?.(ms); } catch (e) { /* no haptics */ } };
  // tap vs hold is judged by the touch events' own timestamps, so a slow frame on the phone can't turn a tap into a guard
  function gestStart(t, ts) {
    gId = t.identifier; gx = t.clientX; gy = t.clientY; gt = ts; gDone = false; gBlock = false;
    ring.style.left = gx + 'px'; ring.style.top = gy + 'px'; ring.className = 'on';
    clearTimeout(gHold);
    gHold = setTimeout(() => { // still pressing, hardly moved: guard
      if (gId === null || gDone || !playing()) return;
      gBlock = true; touch.parry = true; ring.className = 'on guard'; buzz(12);
    }, 180);
  }
  function gestMove(t) {
    const dx = t.clientX - gx, dy = t.clientY - gy;
    if (gDone || gBlock || Math.hypot(dx, dy) < 38) return;
    gDone = true; clearTimeout(gHold); ring.className = 'on swipe';
    if (!playing()) return;
    if (Math.abs(dx) > Math.abs(dy)) pressed.add(dx < 0 ? 'AtkL' : 'AtkR'); // side cut
    else if (dy > 0) pressed.add('Space');                                 // step back / get up
    else pressed.add('Attack');                                            // swipe up: a strike, like a tap
  }
  function gestEnd(ts) {
    clearTimeout(gHold);
    if (gBlock) touch.parry = false;
    if (!gDone && (!gBlock || ts - gt < 180) && playing()) pressed.add('Attack'); // tap
    gId = null; ring.className = '';
  }
  pad.addEventListener('touchstart', e => {
    e.preventDefault();
    for (const t of e.changedTouches) {
      const stickZone = touch.portrait ? t.clientX < innerWidth * 0.5 && t.clientY > innerHeight * 0.5 : t.clientX < innerWidth * 0.45;
      if (touch.portrait && !stickZone) { if (gId === null) gestStart(t, e.timeStamp); continue; }
      if (stickZone && stickId === null) {
        stickId = t.identifier; sx = t.clientX; sy = t.clientY;
        stick.style.left = sx + 'px'; stick.style.top = sy + 'px'; stick.classList.add('on');
        knob.style.transform = ''; touch.stick.active = true; touch.stick.x = touch.stick.y = 0;
      } else if (lookId === null) { lookId = t.identifier; lx = t.clientX; ly = t.clientY; }
    }
  }, { passive: false });
  pad.addEventListener('touchmove', e => {
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (t.identifier === stickId) {
        let dx = t.clientX - sx, dy = t.clientY - sy; const l = Math.hypot(dx, dy);
        if (l > R) { dx *= R / l; dy *= R / l; }
        knob.style.transform = `translate(${dx}px,${dy}px)`;
        touch.stick.x = dx / R; touch.stick.y = dy / R;
      } else if (t.identifier === lookId) {
        if (playing()) look((t.clientX - lx) * 2.2, (t.clientY - ly) * 1.6);
        lx = t.clientX; ly = t.clientY;
      } else if (t.identifier === gId) gestMove(t);
    }
  }, { passive: false });
  const end = e => {
    for (const t of e.changedTouches) {
      if (t.identifier === stickId) { stickId = null; stick.classList.remove('on'); Object.assign(touch.stick, { x: 0, y: 0, active: false }); }
      if (t.identifier === lookId) lookId = null;
      if (t.identifier === gId) gestEnd(e.timeStamp);
    }
  };
  pad.addEventListener('touchend', end); pad.addEventListener('touchcancel', end);
  // buttons: tap actions go through the same `pressed` set as the keyboard; parry is held
  const btn = (id, down, up) => {
    const el = $(id);
    el.addEventListener('touchstart', e => { e.preventDefault(); e.stopPropagation(); el.classList.add('down'); if (playing() || id === 'bPause') down(); }, { passive: false });
    const rel = e => { e.preventDefault(); el.classList.remove('down'); up?.(); };
    el.addEventListener('touchend', rel); el.addEventListener('touchcancel', rel);
  };
  btn('bAtk', () => pressed.add('Attack'));
  btn('bDodge', () => pressed.add('Space'));
  btn('bDraw', () => pressed.add('KeyF'));
  btn('bParry', () => { touch.parry = true; }, () => { touch.parry = false; });
  btn('bLock', () => { lockOn = !lockOn; saveSettings(); });
  btn('bPause', () => { if (paused) resumeGame(); else pauseGame(); });
  btn('bTarget', () => { if (!switchTarget(1)) switchTarget(-1); });
  touch.reset = () => {
    stickId = lookId = gId = null; clearTimeout(gHold); ring.className = '';
    stick.classList.remove('on'); Object.assign(touch.stick, { x: 0, y: 0, active: false }); touch.parry = false;
  };
})();
// on a phone, going full screen gives the arena the whole display (either way up)
function goFullscreen() {
  if (!touch.enabled || document.fullscreenElement) return;
  const el = document.documentElement;
  try { el.requestFullscreen?.({ navigationUI: 'hide' })?.catch(() => {}); } catch (e) { /* not allowed */ }
}

// ============================================================ camera / hud / pops
const pops = [];
function popText(p, text, cls) {
  const el = document.createElement('div'); el.className = 'pop ' + cls; el.textContent = text;
  $('pops').appendChild(el); pops.push({ el, p: p.clone().add(new V3(rand(-0.2, 0.2), 0, rand(-0.2, 0.2))), t: 0 });
}
function updatePops(dt) {
  for (let i = pops.length - 1; i >= 0; i--) {
    const o = pops[i]; o.t += dt; o.p.y += dt * 0.9;
    const v = o.p.clone().project(camera);
    const x = (v.x * 0.5 + 0.5) * innerWidth, y = (-v.y * 0.5 + 0.5) * innerHeight;
    const sc = o.t < 0.1 ? 1.5 - o.t * 5 : 1;
    o.el.style.transform = `translate(${x}px,${y}px) translate(-50%,-50%) scale(${sc})`;
    o.el.style.opacity = v.z < 1 ? Math.max(0, 1 - Math.max(0, o.t - 0.5) / 0.5) : 0;
    if (o.t > 1) { o.el.remove(); pops.splice(i, 1); }
  }
}
const camLook = new V3(0, 1.5, 0);
function updateCamera(dt) {
  if (game.state === 'title') {
    const a = time * 0.08;
    camera.position.set(Math.sin(a) * 15, 8.5, Math.cos(a) * 15);
    camera.lookAt(0, 3.5, 0);
    return;
  }
  const target = currentTarget();
  // hold R to look back over your shoulder (medieval-sim's look-back); the view snaps round and snaps back
  const back = !!keys.KeyR && !target && !isDown(), wantYaw = P.yaw + (back ? Math.PI : 0), snap = back !== lookBack;
  lookBack = back;
  camYaw = snap ? wantYaw : dampAng(camYaw, wantYaw, target ? 7 : 5, dt);
  const hor = camDist * Math.cos(camPitch), h = 1.55 + camDist * Math.sin(camPitch) + P.jy * 0.5; // the camera rises a little with a jump
  const cp = new V3(P.pos.x - Math.sin(camYaw) * hor, h, P.pos.z - Math.cos(camYaw) * hor);
  const rl = Math.hypot(cp.x, cp.z);
  if (rl > 18.0) { cp.x *= 18.0 / rl; cp.z *= 18.0 / rl; }
  cp.y = Math.max(cp.y, groundH(cp.x, cp.z) + 0.4); // below level the camera hugs the ground and tilts its gaze up instead
  const gazeUp = clamp((0.12 - camPitch) * 1.9, 0, 1.38);
  const look = new V3(P.pos.x, 1.45 + P.jy * 0.6, P.pos.z).addScaledVector(new V3(Math.sin(camYaw), 0, Math.cos(camYaw)), 1.2);
  if (target) look.lerp(new V3(target.pos.x, 1.2, target.pos.z), 0.22 * (1 - gazeUp / 1.38));
  look.y += Math.tan(gazeUp) * (hor + 1.2);
  if (snap) { camLook.copy(look); camera.position.copy(cp); }
  camLook.lerp(look, 1 - Math.exp(-10 * dt));
  camera.position.lerp(cp, 1 - Math.exp(-14 * dt));
  if (shake > 0) { camera.position.add(new V3(rand(-1, 1), rand(-1, 1), rand(-1, 1)).multiplyScalar(shake * 0.12)); shake = Math.max(0, shake - dt * 2.2); }
  camera.lookAt(camLook);
  if (window.__dbgCam) { camera.position.copy(window.__dbgCam.pos); camera.lookAt(window.__dbgCam.target); } // debug: a fixed view
}
// Gothic-style bars, drawn here rather than taken from Gothic: a frame of dark, worn iron with tapered, riveted ends
// and a sunken channel, and fills of grainy, bevelled colour like Gothic's bar textures. The frame is a CSS
// border-image (the ends keep their shape at any width), and the fills are cut off by clip-path instead of squeezed,
// so their grain doesn't smear as the bar drops.
(function barSkins() {
  const cv = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return [c, c.getContext('2d')]; };
  const W = 256, H = 44, [fc, f] = cv(W, H);
  const shape = () => { f.beginPath(); f.moveTo(2, 22); f.lineTo(20, 3); f.lineTo(W - 20, 3); f.lineTo(W - 2, 22); f.lineTo(W - 20, 41); f.lineTo(20, 41); f.closePath(); };
  shape(); f.save(); f.clip();
  const mg = f.createLinearGradient(0, 3, 0, 41);
  mg.addColorStop(0, '#9b9384'); mg.addColorStop(0.18, '#6d665a'); mg.addColorStop(0.55, '#47413a'); mg.addColorStop(1, '#221d18');
  f.fillStyle = mg; f.fillRect(0, 0, W, H);
  for (let i = 0; i < 900; i++) { f.fillStyle = `rgba(${Math.random() < 0.5 ? '0,0,0' : '255,240,220'},${rand(0.04, 0.16)})`; f.fillRect(rand(0, W), rand(0, H), rand(1, 3), rand(1, 2)); } // pitting
  for (let i = 0; i < 26; i++) { f.strokeStyle = `rgba(20,14,10,${rand(0.15, 0.4)})`; f.lineWidth = rand(0.5, 1.2); const x = rand(0, W), y = rand(3, 41); f.beginPath(); f.moveTo(x, y); f.lineTo(x + rand(-14, 14), y + rand(-2, 2)); f.stroke(); } // scratches
  for (let i = 0; i < 10; i++) { const x = rand(0, W), gr = f.createRadialGradient(x, 30, 0, x, 30, rand(6, 16)); gr.addColorStop(0, 'rgba(110,52,22,.35)'); gr.addColorStop(1, 'rgba(110,52,22,0)'); f.fillStyle = gr; f.fillRect(x - 16, 14, 32, 30); } // rust
  // the sunken channel the fill sits in
  f.fillStyle = '#0d0806'; f.fillRect(24, 10, W - 48, 24);
  const ch = f.createLinearGradient(0, 10, 0, 34); ch.addColorStop(0, 'rgba(0,0,0,.85)'); ch.addColorStop(0.3, 'rgba(0,0,0,0)'); ch.addColorStop(1, 'rgba(255,230,190,.08)');
  f.fillStyle = ch; f.fillRect(24, 10, W - 48, 24);
  f.restore();
  // bevels: a lit upper edge, a dark outline, and the lip around the channel
  shape(); f.strokeStyle = '#0b0705'; f.lineWidth = 2.5; f.stroke();
  f.strokeStyle = 'rgba(235,225,200,.45)'; f.lineWidth = 1; f.beginPath(); f.moveTo(21, 5); f.lineTo(W - 21, 5); f.stroke();
  f.strokeStyle = 'rgba(0,0,0,.9)'; f.strokeRect(24.5, 10.5, W - 49, 23);
  f.strokeStyle = 'rgba(220,205,170,.25)'; f.beginPath(); f.moveTo(24, 34.5); f.lineTo(W - 24, 34.5); f.stroke();
  for (const x of [12, W - 12]) { // rivets on the ends
    const rg = f.createRadialGradient(x - 1.2, 20.5, 0.5, x, 22, 4.5); rg.addColorStop(0, '#d9d0bd'); rg.addColorStop(0.5, '#6d665a'); rg.addColorStop(1, '#1a1511');
    f.fillStyle = rg; f.beginPath(); f.arc(x, 22, 4.2, 0, 7); f.fill();
  }
  const fill = (top, mid, bot) => {
    const [c, x] = cv(128, 24);
    const gr = x.createLinearGradient(0, 0, 0, 24);
    gr.addColorStop(0, top); gr.addColorStop(0.32, mid); gr.addColorStop(1, bot);
    x.fillStyle = gr; x.fillRect(0, 0, 128, 24);
    for (let i = 0; i < 40; i++) { x.fillStyle = `rgba(0,0,0,${rand(0.05, 0.18)})`; x.fillRect(0, rand(0, 24), 128, rand(0.5, 1.5)); } // fibrous streaks
    for (let i = 0; i < 700; i++) { x.fillStyle = `rgba(${Math.random() < 0.55 ? '0,0,0' : '255,235,210'},${rand(0.04, 0.16)})`; x.fillRect(rand(0, 128), rand(0, 24), rand(1, 2.5), 1); } // grain
    x.fillStyle = 'rgba(255,240,220,.28)'; x.fillRect(0, 4, 128, 1.5); // the glossy bead along the top
    x.fillStyle = 'rgba(0,0,0,.35)'; x.fillRect(0, 22, 128, 2);
    return `url(${c.toDataURL()})`;
  };
  const css = document.documentElement.style;
  css.setProperty('--bar-frame', `url(${fc.toDataURL()})`);
  css.setProperty('--fill-hp', fill('#f0745c', '#c0281b', '#4e0905'));
  css.setProperty('--fill-st', fill('#ece0a0', '#ad9338', '#3e3210'));
  css.setProperty('--fill-foe', fill('#e9875a', '#a8381a', '#3d0f05'));
})();
// Worn UI: the same treatment for the lettering and the menus. A grain layer (specks, pitting, fine scratches) lies over
// every surface; gold lettering is a cast, rubbed gradient; and a wear mask chips and scratches the big letters and
// the buttons, as if the paint had worn off. Applied in index.html through CSS variables.
(function uiSkins() {
  const cv = s => { const c = document.createElement('canvas'); c.width = c.height = s; return [c, c.getContext('2d')]; };
  const url = c => `url(${c.toDataURL()})`, css = document.documentElement.style;
  // grain: transparent, so it darkens and lightens whatever it lies on
  const [gc, g] = cv(256);
  for (let i = 0; i < 2600; i++) { g.fillStyle = `rgba(${Math.random() < 0.6 ? '0,0,0' : '255,240,215'},${rand(0.04, 0.16)})`; g.fillRect(rand(0, 256), rand(0, 256), rand(0.8, 2.4), rand(0.8, 2.2)); }
  for (let i = 0; i < 40; i++) { const x = rand(0, 256), y = rand(0, 256), r = rand(6, 26), gr = g.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, `rgba(0,0,0,${rand(0.05, 0.14)})`); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(x - r, y - r, 2 * r, 2 * r); } // grime
  for (let i = 0; i < 34; i++) { g.strokeStyle = `rgba(${Math.random() < 0.5 ? '0,0,0' : '255,235,200'},${rand(0.06, 0.16)})`; g.lineWidth = rand(0.5, 1.1); const x = rand(0, 256), y = rand(0, 256), a = rand(-0.5, 0.5); g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * rand(14, 60), y + Math.sin(a) * rand(14, 60)); g.stroke(); }
  css.setProperty('--tex-grain', url(gc));
  // a quieter grain for full-screen backdrops (bright specks there read as falling snow)
  const [bc, b] = cv(256);
  for (let i = 0; i < 1800; i++) { b.fillStyle = `rgba(${Math.random() < 0.85 ? '0,0,0' : '255,240,215'},${rand(0.03, 0.08)})`; b.fillRect(rand(0, 256), rand(0, 256), rand(0.8, 2), rand(0.8, 2)); }
  for (let i = 0; i < 30; i++) { const x = rand(0, 256), y = rand(0, 256), r = rand(10, 40), gr = b.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, `rgba(0,0,0,${rand(0.04, 0.1)})`); gr.addColorStop(1, 'rgba(0,0,0,0)'); b.fillStyle = gr; b.fillRect(x - r, y - r, 2 * r, 2 * r); }
  css.setProperty('--tex-grain-bg', url(bc));
  // wear mask: opaque, with chips, pits and scratches knocked out of it
  const wear = (chips, scratches) => {
    const [c, x] = cv(256);
    x.fillStyle = '#fff'; x.fillRect(0, 0, 256, 256);
    x.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < chips; i++) { x.fillStyle = `rgba(0,0,0,${rand(0.35, 0.95)})`; x.beginPath(); x.ellipse(rand(0, 256), rand(0, 256), rand(0.6, 2.6), rand(0.5, 1.8), rand(0, 3), 0, 7); x.fill(); }
    for (let i = 0; i < scratches; i++) { x.strokeStyle = `rgba(0,0,0,${rand(0.35, 0.8)})`; x.lineWidth = rand(0.6, 1.4); const sx = rand(0, 256), sy = rand(0, 256), a = rand(0, 3.14); x.beginPath(); x.moveTo(sx, sy); x.lineTo(sx + Math.cos(a) * rand(8, 34), sy + Math.sin(a) * rand(8, 34)); x.stroke(); }
    for (let i = 0; i < 400; i++) { x.fillStyle = `rgba(0,0,0,${rand(0.08, 0.3)})`; x.fillRect(rand(0, 256), rand(0, 256), 1, 1); } // fine pitting
    return url(c);
  };
  css.setProperty('--tex-wear', wear(260, 22));       // big lettering
  css.setProperty('--tex-wear-soft', wear(110, 10));  // buttons and small panels
})();
const setBar = (el, v) => { el.style.clipPath = `inset(0 ${(100 - clamp(v, 0, 1) * 100).toFixed(2)}% 0 0)`; };
function updateHUD(dt) {
  P.ghostHp = damp(P.ghostHp, P.hp, 3, dt);
  setBar($('php').querySelector('.fill'), P.hp / P.maxHp);
  setBar($('php').querySelector('.ghost'), P.ghostHp / P.maxHp);
  setBar($('pst').querySelector('.fill'), P.st / P.maxSt);
  $('stance').textContent = P.state === 'down' ? (P.t > 0.7 ? 'KNOCKED DOWN — SPACE TO RISE' : 'KNOCKED DOWN') : P.drawn ? (P.state === 'block' ? 'GUARD' : (currentTarget() ? 'LOCKED · ' : '') + 'SWORD DRAWN') : (touch.portrait ? 'UNARMED — TAP TO STRIKE' : touch.enabled ? 'UNARMED — TAP DRAW' : 'UNARMED — PRESS CTRL');
  const tgt = currentTarget() || beasts.find(e => !e.dead && e.state !== 'wait');
  const eb = $('ebox');
  if (tgt && game.state !== 'title') {
    eb.style.opacity = 1;
    tgt.ghostHp = damp(tgt.ghostHp, tgt.hp, 3, dt);
    setBar($('ebar').querySelector('.fill'), tgt.hp / tgt.maxHp);
    setBar($('ebar').querySelector('.ghost'), tgt.ghostHp / tgt.maxHp);
    $('ename').textContent = tgt.name;
  } else eb.style.opacity = 0;
  // a small gold chevron over the locked beast's head
  if (touch.enabled) $('touch').style.visibility = game.state === 'title' || !$('overlay').classList.contains('hidden') ? 'hidden' : '';
  if (touch.enabled) { $('bDodge').textContent = currentTarget() ? 'STEP' : 'JUMP'; $('bLock').classList.toggle('lit', lockOn); $('bDraw').textContent = P.drawn ? 'SHEATHE' : 'DRAW'; }
  const lm = $('lockmark'), lt = currentTarget();
  if (lt && game.state !== 'title') {
    const v = tmpV2.set(lt.pos.x, groundH(lt.pos.x, lt.pos.z) + 2.6 * lt.s, lt.pos.z).project(camera);
    const x = (v.x * 0.5 + 0.5) * innerWidth, y = (-v.y * 0.5 + 0.5) * innerHeight + Math.sin(time * 5) * 3;
    lm.style.transform = `translate(${x - 6}px,${y - 12}px) rotate(45deg)`; lm.style.opacity = v.z < 1 ? 1 : 0;
  } else lm.style.opacity = 0;
  const c = $('combo');
  if (P.combo >= 2) { c.querySelector('.n').textContent = P.combo + '×'; c.querySelector('.t').textContent = 'CHAIN'; c.style.opacity = Math.min(1, P.comboT); }
  else c.style.opacity = 0;
  vignetteA = Math.max(0, vignetteA - dt * 2.5);
  const low = P.hp / P.maxHp < 0.3 && P.state !== 'dead' ? 0.25 + Math.sin(time * 5) * 0.1 : 0;
  vignette.style.opacity = Math.max(vignetteA * 0.8, low);
}

// ============================================================ main loop
let last = performance.now();
const clockEl = { crackle: 0 };
function updateBanners() {
  for (const b of banners) {
    const pos = b.m.geometry.attributes.position, arr = pos.array;
    for (let i = 0; i < arr.length; i += 3) {
      const x = b.base[i], y = b.base[i + 1];
      const amt = (1.2 - y) / 2.4;
      arr[i + 2] = b.base[i + 2] + Math.sin(time * 2.2 + y * 2 + x * 3 + b.ph) * 0.12 * amt;
    }
    pos.needsUpdate = true;
  }
}
// ---- depth pre-pass
// Almost all of the frame time is pixel shading (lit, shadowed, environment-mapped materials, plus the sky and barrier
// shaders). Without help, a pixel is often shaded several times — a far house, then the stands, then the palisade in
// front of it — and the costly sky is shaded behind everything. So each frame first lays down depth for every opaque
// surface with a trivial colourless shader, and only then renders for real: the depth test now rejects every hidden
// fragment before its shader runs, so each pixel is shaded exactly once. The picture is identical.
const depthMats = [THREE.FrontSide, THREE.BackSide, THREE.DoubleSide].map(side =>
  new THREE.MeshBasicMaterial({ colorWrite: false, side, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 2 })); // nudged back so the real pass always wins ties
renderer.shadowMap.autoUpdate = false; // the frame is rendered in two passes; the shadow map only needs one update
const prepassed = []; let shadowFrame = 0;
// ---- light shafts (volumetric light in screen space, after GPU Gems 3, ch. 13)
// At a quarter of the resolution, draw the sun as a bright disc with everything solid in front of it in black; then
// blur that radially away from the sun's place on screen and add it over the frame. Whatever stands between the camera
// and the sun (the hero's head, a beast, the palisade, a roof edge) throws visible shafts of light. Skipped entirely when
// the sun is behind the camera, set, or buried in cloud.
const Shafts = (() => {
  const SCALE = 0.2, N = TOUCH ? 28 : 40;
  const rt = new THREE.WebGLRenderTarget(4, 4, { depthBuffer: true });
  const black = new THREE.MeshBasicMaterial({ color: 0x000000, fog: false });
  const sunTex = (() => { const c = document.createElement('canvas'); c.width = c.height = 128; const x = c.getContext('2d');
    const gr = x.createRadialGradient(64, 64, 0, 64, 64, 64); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.12, 'rgba(255,255,255,.9)'); gr.addColorStop(0.35, 'rgba(255,255,255,.25)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = gr; x.fillRect(0, 0, 128, 128); return new THREE.CanvasTexture(c); })();
  const sunSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: sunTex, depthWrite: false, depthTest: false, fog: false }));
  sunSprite.scale.setScalar(120); const sunScene = new THREE.Scene(); sunScene.add(sunSprite);
  const mat = new THREE.ShaderMaterial({
    uniforms: { tOcc: { value: rt.texture }, sunPos: { value: new THREE.Vector2() }, strength: { value: 0 }, tint: { value: new THREE.Color() } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: `uniform sampler2D tOcc; uniform vec2 sunPos; uniform float strength; uniform vec3 tint; varying vec2 vUv;
      void main(){
        vec2 d = (vUv - sunPos) * (0.92 / ${N}.0), uv = vUv; float w = 1.0, sum = 0.0;
        for (int i = 0; i < ${N}; i++) { uv -= d; sum += texture2D(tOcc, uv).r * w; w *= 0.972; }
        gl_FragColor = vec4(tint * sum * (strength / ${N}.0), 1.0);
      }`,
    blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, transparent: true,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat); quad.frustumCulled = false;
  const qScene = new THREE.Scene(); qScene.add(quad); const qCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const v = new V3(), fwd = new V3(), clear = new THREE.Color(); let odd = false, fresh = false;
  function size() { rt.setSize(Math.max(4, innerWidth * SCALE | 0), Math.max(4, innerHeight * SCALE | 0)); }
  size(); addEventListener('resize', size);
  function render() {
    const D = Daylight.st, oc = sky.material.uniforms.overcast.value;
    const sunUp = smoothstep(0.0, 0.12, SUN_DIR.y) * (1 - smoothstep(0.25, 0.6, oc)); // none once the sky clouds over (it was still paying for a faint 10 % in rain)
    camera.getWorldDirection(fwd);
    const facing = fwd.dot(SUN_DIR);
    if (sunUp < 0.02 || facing < 0.2 || settings.shafts === false) { fresh = false; return; }
    v.copy(SUN_DIR).multiplyScalar(250).add(camera.position); sunSprite.position.copy(v);
    v.project(camera);
    const off = Math.max(Math.abs(v.x), Math.abs(v.y)), edge = 1 - smoothstep(1.0, 1.6, off);
    const strength = 1.25 * sunUp * edge * smoothstep(0.2, 0.5, facing);
    if (strength < 0.01) { fresh = false; return; }
    mat.uniforms.sunPos.value.set(v.x * 0.5 + 0.5, v.y * 0.5 + 0.5);
    mat.uniforms.strength.value = strength;
    mat.uniforms.tint.value.setRGB(1.0, 0.86, 0.66).lerp(clear.setRGB(1.0, 0.55, 0.28), D.dusk);
    const layers = camera.layers.mask, ac = renderer.autoClear;
    renderer.getClearColor(clear); const ca = renderer.getClearAlpha();
    // the occlusion picture is redrawn every other frame (it's blurred anyway): half the cost
    if ((odd = !odd) || !fresh) {
      renderer.setRenderTarget(rt); renderer.setClearColor(0x000000, 1);
      renderer.autoClear = true; renderer.render(sunScene, camera);                  // the bright sun
      renderer.autoClear = false; camera.layers.set(OCC); scene.overrideMaterial = black;
      renderer.render(scene, camera);                                               // everything solid in front of it, black
      scene.overrideMaterial = null; camera.layers.mask = layers;
      renderer.setRenderTarget(null); renderer.setClearColor(clear, ca); fresh = true;
    }
    renderer.autoClear = false; renderer.render(qScene, qCam);                      // streak it out and add it over the frame
    renderer.autoClear = ac;
    mat.uniforms.tint.value.setRGB(1.0, 0.86, 0.66);
  }
  return { render };
})();
// The layer sort (and the list of meshes for the pre-pass) is rebuilt only when the scene changes (a beast enters, the
// hero model loads) or every second, not walked every frame. Layer 2 marks the light-shaft occluders: the characters
// and anything big; pebbles, straw and arrows stay out of that pass.
const prepassList = []; let sortedFor = -1, sortAge = 0;
const OCC = 2;
function sortLayers() {
  prepassList.length = 0;
  scene.traverse(o => {
    if (!o.isMesh && !o.isPoints && !o.isLine) return;
    const m = o.material;
    if (o.isMesh && !m.transparent && !m.isShaderMaterial && m.depthWrite && m.depthTest && !m.userData.noPrepass) {
      o.layers.set(0); prepassList.push(o);
      let ch = false; for (let p = o; p; p = p.parent) if (p.userData.occluder) { ch = true; break; }
      if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
      if (ch || (!o.isInstancedMesh && o.geometry.boundingSphere.radius * o.matrixWorld.getMaxScaleOnAxis() > 0.8)) o.layers.enable(OCC);
    } else o.layers.set(1); // transparent things, particles, lightning, sky, barrier: main pass only
  });
  sortedFor = scene.children.length; sortAge = 0;
}
function drawFrame() {
  if (scene.children.length !== sortedFor || ++sortAge > 60) sortLayers();
  prepassed.length = 0;
  for (const o of prepassList) { if (!o.parent) continue; const m = o.material; prepassed.push(o, m); o.material = depthMats[m.side]; }
  camera.layers.set(0);
  renderer.render(scene, camera);
  for (let i = 0; i < prepassed.length; i += 2) prepassed[i].material = prepassed[i + 1];
  camera.layers.enable(1);
  // Shadows are real, from the sun (or moon) where it stands, which moves every 2 s with the clock (Daylight). The shadow
  // map is re-rendered every other frame: half the cost, and the characters' shadows still follow them smoothly.
  if ((shadowFrame = (shadowFrame + 1) % 2) === 0) renderer.shadowMap.needsUpdate = true;
  renderer.autoClear = false; renderer.render(scene, camera); renderer.autoClear = true;
  Shafts.render();
}
// ---- dynamic resolution, v2
// The first version averaged the frame rate over 2 s and stepped down below 50 fps. That misfired: one hitch in a window
// (the sky reflection being re-taken as clouds roll in, a shader compiled the first time rain falls) dragged the average
// under the line; a browser capping the frame rate (battery saver, a 50 Hz screen, a background tab) looked exactly like
// a slow GPU; and it only stepped back up above 58 fps, which a 60 Hz screen with a little jitter rarely reports.
// Now:
//  · where the browser offers GPU timer queries (EXT_disjoint_timer_query_webgl2), the decision is made on the GPU's own
//    time per frame: shrink only if the GPU can't draw the frame in ~14 ms, grow back while there's room at the next step;
//  · without them, on the median frame time (hitches don't count), and only after two slow windows in a row;
//  · a frame rate pinned at a cap with an idle GPU never shrinks the picture.
// ?perf=1 or F3 shows a readout: fps, frame and GPU times, resolution, weather, and the scaler's last decision.
let daylightT = 0;
let prevNow = performance.now(), frCool = 3, slowWins = 0;
const frTimes = [], gpuTimes = [];
const RES = { last: 'start', gpu: null, fps: 0, frameMs: 0 };
const median = a => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const GPUT = (() => { // GPU frame timing, if the browser offers it
  const gl = renderer.getContext(), ext = gl.getExtension && gl.getExtension('EXT_disjoint_timer_query_webgl2');
  if (!ext || !gl.createQuery) return null;
  let open = null; const pending = [];
  return {
    begin() { if (open || pending.length > 4) return; open = gl.createQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT, open); },
    end() { if (!open) return; gl.endQuery(ext.TIME_ELAPSED_EXT); pending.push(open); open = null; },
    poll() {
      while (pending.length && gl.getQueryParameter(pending[0], gl.QUERY_RESULT_AVAILABLE)) {
        const q = pending.shift(), ok = !gl.getParameter(ext.GPU_DISJOINT_EXT);
        if (ok) gpuTimes.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
        gl.deleteQuery(q);
      }
      if (gpuTimes.length > 240) gpuTimes.splice(0, gpuTimes.length - 240);
    },
  };
})();
function setRes(pr, why) {
  pixelRatio = pr; renderer.setPixelRatio(pr); renderer.setSize(innerWidth, innerHeight);
  for (const p of particleSystems) p.mat.uniforms.scale.value = pointScale();
  RES.last = why; frCool = 4; frTimes.length = 0; gpuTimes.length = 0;
  (window.__resLog = window.__resLog || []).push(`${new Date().toLocaleTimeString()} ${pr.toFixed(3)}× ${why}`);
}
function adaptResolution(fdt) {
  GPUT?.poll();
  if (!(fdt > 0) || fdt > 0.25) return;           // tab switches and one-off hitches don't count
  frTimes.push(fdt * 1000); frCool -= fdt;
  if (frTimes.reduce((a, b) => a + b, 0) < 2000) return;
  const fms = median(frTimes), gms = gpuTimes.length >= 10 ? median(gpuTimes) : null;
  RES.fps = 1000 / fms; RES.frameMs = fms; RES.gpu = gms; frTimes.length = 0; gpuTimes.length = 0;
  if (window.__noAdapt || frCool > 0 || settings.res !== 'auto') return;
  const pr = pixelRatio, upK = ((pr + 0.125) / pr) ** 2;   // pixels cost ~ the square of the ratio
  if (gms !== null) {                              // decide on the GPU's own time
    if (gms > 14 && pr > (TOUCH ? 0.75 : 0.5)) { slowWins++; if (slowWins >= 2) { slowWins = 0; setRes(Math.max(TOUCH ? 0.75 : 0.5, pr - (gms > 24 ? 0.25 : 0.125)), `GPU ${gms.toFixed(1)} ms`); } }
    else { slowWins = 0; if (gms * upK < 11 && pr < MAX_PR) setRes(Math.min(MAX_PR, pr + 0.125), `GPU ${gms.toFixed(1)} ms, room to grow`); }
    return;
  }
  // no GPU timing: the median frame time; a frame rate pinned to a cap (30/50/60 Hz) with no jitter isn't the GPU
  const capped = [16.67, 20, 33.33].some(c => Math.abs(fms - c) < 0.6);
  // phones get more leeway: a steady 40 fps is fine on a phone, and below 0.75× the picture turns to mush
  const slow = TOUCH ? 28 : 21, grow = TOUCH ? 20 : 17.5, floor = TOUCH ? 0.75 : 0.5;
  if (fms > slow && !capped && pr > floor) { slowWins++; if (slowWins >= 2) { slowWins = 0; setRes(Math.max(floor, pr - (fms > 40 ? 0.25 : 0.125)), `frame ${fms.toFixed(1)} ms`); } }
  else { slowWins = 0; if (fms < grow && pr < MAX_PR) setRes(Math.min(MAX_PR, pr + 0.125), `frame ${fms.toFixed(1)} ms, steady`); }
}
// the readout (?perf=1 or F3)
const perfEl = document.createElement('div');
perfEl.style.cssText = 'position:fixed;right:12px;top:52px;z-index:8;font:11px/1.45 monospace;color:#e8ddc4;background:rgba(0,0,0,.55);padding:6px 9px;pointer-events:none;white-space:pre;display:none';
document.body.appendChild(perfEl);
if (new URLSearchParams(location.search).has('perf') || settings.perf) perfEl.style.display = 'block';
// a fixed resolution from the pause menu (or back to automatic)
function applyResSetting() { if (settings.res === 'auto') { RES.last = 'automatic'; frCool = 2; } else setRes(MAX_PR * settings.res, `fixed at ${Math.round(settings.res * 100)} %`); }
if (settings.res !== 'auto') applyResSetting();
addEventListener('keydown', e => { if (e.code === 'F3') { e.preventDefault(); perfEl.style.display = perfEl.style.display === 'none' ? 'block' : 'none'; } });
let perfT = 0;
function updatePerf(dt) {
  if (perfEl.style.display === 'none' || (perfT -= dt) > 0) return; perfT = 0.5;
  const w = Weather.wx;
  perfEl.textContent = `${RES.fps.toFixed(0)} fps · frame ${RES.frameMs.toFixed(1)} ms\nGPU ${RES.gpu === null ? (GPUT ? 'measuring…' : 'n/a in this browser') : RES.gpu.toFixed(1) + ' ms'}\nresolution ${pixelRatio.toFixed(3)}× (max ${MAX_PR})\nrain ${w.rain.toFixed(2)} · clouds ${w.cloud.toFixed(2)} · barrier ${Weather.agitation.toFixed(2)}\nlast change: ${RES.last}`;
}
function loop(now) {
  requestAnimationFrame(loop);
  const rdt = Math.min(0.05, (now - last) / 1000); last = now;
  if (paused) { Weather.silence(); drawFrame(); pressed.clear(); return; }
  tick(rdt);
  adaptResolution((now - prevNow) / 1000); prevNow = now;
  if (!window.__noRender) { GPUT?.begin(); drawFrame(); GPUT?.end(); } // debug: __noRender = true keeps the page responsive in software-rendered tests
  updatePerf(rdt);
  pressed.clear();
}
// one step of the world, without drawing (rdt: real seconds; dt: game seconds, slowed by hit-stop and slow motion)
function tick(rdt) {
  let dt = rdt;
  if (hitStop > 0) { hitStop -= rdt; dt *= 0.06; }
  else if (slowMo > 0) { slowMo -= rdt; dt *= 0.35; }
  time += dt;

  if (game.state !== 'title') {
    updatePlayer(dt);
    const tg = currentTarget(), cand = !tg && P.drawn && P.state !== 'dead' ? acquireLock() : null;
    for (const e of beasts) e.hl = e === tg ? 1 : e === cand ? 0.35 : 0;
    if (!window.__freezeAI) for (const e of beasts) e.update(dt);
    separate();
    if (game.state === 'between') {
      game.betweenT -= rdt;
      if (game.betweenT <= 0) { P.hp = Math.min(P.maxHp, P.hp + P.maxHp * 0.45); startRound(game.round + 1); }
    }
  } else {
    applyHero(POSE.relaxed, 6, dt);
    hero.root.position.set(0, 0, 7); hero.root.rotation.y = Math.PI;
  }
  if ((daylightT -= rdt) <= 0) { daylightT = 2; Daylight.update(); } // the clock moves slowly: a few updates a minute is plenty
  Ambience.update(rdt);
  updateTorches(dt, time);
  grassWind.value += dt * (1 + Weather.rain * 0.6); // a storm blows harder
  Weather.update(dt, time);
  barrier.update(dt, time); sky.material.uniforms.time.value = time;
  clockEl.crackle -= rdt;
  if (clockEl.crackle <= 0 && AC) { clockEl.crackle = rand(0.05, 0.35); SFX.crackle?.(); }
  updateBanners();
  const fighting = game.state === 'play' && beasts.some(e => !e.dead && e.state !== 'wait');
  Music.setTheme(fighting ? 'fight' : Daylight.st.night > 0.5 ? 'night' : 'day');
  fxAdd.update(dt); fxNorm.update(dt); trail.update(dt);
  updateCamera(rdt);
  sky.position.copy(camera.position);
  updateHUD(rdt); updatePops(rdt);
}
// debug hooks (like medieval-sim's): ?auto=1 skips the title screen; window.__game exposes the state, and
// __game.step(seconds) runs the world in 1/60 s steps without drawing, for quick tests; __freezeAI = true stops the beasts
window.__game = {
  P, beasts, hero, camera, scene, THREE, game, settings, Weather, POSE,
  startRound, resetGame, startAttack, hitPlayer, currentTarget, switchTarget, acquireLock, barrierSpawn: barrier.spawn,
  get lockTarget() { return lockTarget; }, get lockOn() { return lockOn; }, set lockOn(v) { lockOn = v; },
  press(code) { pressed.add(code); }, Daylight, adapt: s => adaptResolution(s), get pixelRatio() { return pixelRatio; }, setHour: h => { Daylight.setHour(h); },
  renderer, draw: () => drawFrame(),
  // debug: average cost of a frame (simulation + drawing) over n frames, and what the renderer drew
  bench(n = 5) { renderer.setPixelRatio(1); const t0 = performance.now(); for (let i = 0; i < n; i++) { tick(1 / 60); drawFrame(); renderer.getContext().finish(); } const ms = (performance.now() - t0) / n; renderer.setPixelRatio(pixelRatio); return { ms: +ms.toFixed(1), calls: renderer.info.render.calls, tris: renderer.info.render.triangles }; }, hold(code, v = true) { keys[code] = v; },
  step(seconds, fps = 60) { for (let i = 0; i < Math.round(seconds * fps); i++) { tick(1 / fps); pressed.clear(); } },
};
SFX.crackle = () => nz({ dur: 0.03, type: 'highpass', f0: 2200, f1: 3200, gain: rand(0.01, 0.04) });
// ============================================================ loading: build + warm up every shader before play
// Physical materials (clearcoat/sheen) are slow to compile on Windows/ANGLE; doing it here instead of
// on the first frame a beast appears avoids a multi-second freeze when entering the arena.
async function preload() {
  const step = async (label, pct, fn) => {
    $('loadStep').textContent = label; $('loadFill').style.width = pct + '%';
    await new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
    await fn();
  };
  let warm;
  await step('RAISING THE TOWN…', 15, () => { buildTown(); Math.random = realRandom; }); // the world is built: back to real randomness
  await step('CARVING THE THORNBEAK…', 25, async () => {
    try {
      const h = (await new GLTFLoader().loadAsync('models/hero.glb')).scene;
      scene.remove(hero.root); Object.assign(hero, buildHeroGLB(h)); hero.root.userData.occluder = true; scene.add(hero.root); sortedFor = -1;
    } catch (e) { console.warn('hero.glb failed to load, using primitive hero', e); }
    try { beastTemplate = (await new GLTFLoader().loadAsync('models/thornbeak.glb')).scene; }
    catch (e) { console.warn('thornbeak.glb failed to load, using primitive model', e); }
  });
  await step('SUMMONING THE BEAST…', 35, () => {
    warm = new Beast(1, 0, 0); warm.pos.set(0, 0, 0); warm.rig.root.position.set(0, 0, 0);
    setSwordInHand(true);
    popText(new V3(0, -50, 0), '', '');
  });
  await step('TEMPERING STEEL…', 55, async () => {
    camera.position.set(0, 4, 10); camera.lookAt(0, 1.5, 0);
    Weather.warm(true); // the rain's material too, so the first shower doesn't stall on a shader compile
    if (renderer.compileAsync) await renderer.compileAsync(scene, camera); else renderer.compile(scene, camera);
    Weather.warm(false);
  });
  await step('LIGHTING THE TORCHES…', 80, () => {
    trail.push(new V3(0, 1, 0), new V3(0, 2, 0)); trail.update(0);
    renderer.render(scene, camera);
  });
  await step('TUNING THE ORCHESTRA…', 95, () => {
    try { initAudio(); } catch (e) { console.warn(e); }
  });
  warm.dispose(); trail.samples.length = 0; setSwordInHand(false);
  $('loadFill').style.width = '100%';
  $('loading').classList.add('hidden');
  $('overlay').classList.remove('hidden');
  last = performance.now();
  requestAnimationFrame(loop);
  if (new URLSearchParams(location.search).has('auto')) begin();
}
preload();
