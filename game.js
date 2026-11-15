// Medieval Arena — an original third-person arena duel.
// All geometry, textures and sounds are generated procedurally at runtime.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const V3 = THREE.Vector3;
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
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
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

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
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
const SUN_DIR = new V3(0.38, 0.8, 0.46).normalize();
// A brooding, hazy sky: warped, drifting cumulus lit from the sun side with dark bellies, thin cirrus above,
// a soft sun halo burning through the haze, and lightning that flickers inside the clouds.
const sky = new THREE.Mesh(new THREE.SphereGeometry(300, 48, 24), new THREE.ShaderMaterial({
  side: THREE.BackSide, depthWrite: false, fog: false,
  uniforms: { sunDir: { value: SUN_DIR }, time: { value: 0 }, flash: { value: 0 }, flashDir: { value: new V3(0, 1, 0) } },
  vertexShader: `varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `varying vec3 vD; uniform vec3 sunDir; uniform float time; uniform float flash; uniform vec3 flashDir;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
    float noise(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.0-2.0*f);
      return mix(mix(hash(i), hash(i+vec2(1,0)), u.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), u.x), u.y); }
    float fbm(vec2 p){ float v = 0.0, a = 0.5; mat2 r = mat2(0.8,-0.6,0.6,0.8); for (int i = 0; i < 6; i++){ v += a*noise(p); p = r*p*2.03; a *= 0.5; } return v; }
    void main(){
      vec3 d = normalize(vD); float h = d.y;
      vec3 zen = vec3(0.09,0.14,0.24), mid = vec3(0.30,0.36,0.44), hor = vec3(0.60,0.58,0.54);
      vec3 c = mix(hor, mid, smoothstep(0.0, 0.22, h));
      c = mix(c, zen, smoothstep(0.18, 0.95, h));
      c = mix(c, vec3(0.30,0.31,0.28), smoothstep(0.0, -0.15, h));
      float s = max(dot(d, sunDir), 0.0);
      vec3 sunCol = vec3(1.0,0.86,0.66);
      c += sunCol * (pow(s, 5.0) * 0.18 + pow(s, 48.0) * 0.35);
      float cov = 0.0;
      if (h > -0.03) {
        vec2 uv = d.xz / (h + 0.13) * 1.15;
        vec2 w = vec2(time * 0.006, time * 0.0025);
        vec2 q = uv + w + 0.55 * vec2(fbm(uv * 0.7 - w), fbm(uv * 0.7 + 3.1 + w)); // domain warp → billowing shapes
        float n = fbm(q);
        cov = smoothstep(0.40, 0.74, n) * smoothstep(-0.03, 0.18, h);
        float n2 = fbm(q + normalize(sunDir.xz + 1e-4) * 0.09);                   // one step toward the sun
        float lit = clamp((n - n2) * 4.0 + 0.45, 0.0, 1.0);
        vec3 belly = vec3(0.16,0.17,0.20), top = vec3(0.86,0.83,0.78);
        vec3 cc = mix(belly, top, lit * 0.75 + smoothstep(0.75, 0.4, n) * 0.25);
        cc += sunCol * pow(s, 10.0) * (1.0 - smoothstep(0.5, 0.8, n)) * 0.9;     // silver lining near the sun
        cc = mix(cc, hor, smoothstep(0.25, 0.0, h) * 0.55);                      // distant clouds melt into the haze
        c = mix(c, cc, cov * 0.94);
        float ci = fbm(vec2(uv.x * 0.6, uv.y * 2.4) + w * 2.0);                  // high cirrus streaks
        c = mix(c, vec3(0.80,0.80,0.80), smoothstep(0.55, 0.9, ci) * 0.18 * (1.0 - cov) * smoothstep(0.05, 0.4, h));
        float g = pow(max(dot(d, flashDir), 0.0), 10.0);                         // lightning lights the clouds from inside
        c += vec3(0.55,0.65,1.0) * flash * g * (0.25 + cov * 1.4);
      }
      c = mix(c, hor * 1.04, exp(-max(h, 0.0) * 10.0) * 0.55);                    // thick haze on the horizon
      c += sunCol * pow(s, 1400.0) * 5.0 * (1.0 - cov * 0.9);
      gl_FragColor = vec4(c, 1.0);
    }`
}));
scene.add(sky);

// ---- the barrier: a vast dome of force over the town, mostly invisible — a living, veined membrane that streams
// and breathes, glows where it meets the land, and crackles with arcs of lightning that send ripples across it
const barrier = (() => {
  const R = 150, HITS = 6;
  const geo = new THREE.SphereGeometry(R, 128, 64);
  const hits = Array.from({ length: HITS }, () => new THREE.Vector4(0, 1, 0, 99));
  // A living membrane rather than a grid: warped, drifting noise grows branching veins and soft cells,
  // light pulses stream along the veins, the whole skin slowly breathes, and it only shows in drifting patches.
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
    uniforms: { time: { value: 0 }, hits: { value: hits } },
    vertexShader: `varying vec3 vN; void main(){ vN = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `varying vec3 vN; uniform float time; uniform vec4 hits[${HITS}];
      float hash(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
      vec3 hash3(vec3 p){ return vec3(hash(p), hash(p + 31.7), hash(p + 71.3)); }
      float noise(vec3 x){ vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
                   mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z); }
      float fbm(vec3 p){ float v = 0.0, a = 0.5; for (int i = 0; i < 4; i++){ v += a * noise(p); p = p * 2.03 + vec3(1.7, 9.2, 3.1); a *= 0.5; } return v; }
      // soft cell walls: distance to the nearest two jittered seeds (smooth, like a membrane of cells)
      float cells(vec3 p, float t){ vec3 i = floor(p), f = fract(p); float d1 = 8.0, d2 = 8.0;
        for (int x = -1; x <= 1; x++) for (int y = -1; y <= 1; y++) for (int z = -1; z <= 1; z++) {
          vec3 g = vec3(x, y, z), o = hash3(i + g); o = 0.5 + 0.4 * sin(t * 0.4 + 6.2831 * o);
          float d = length(g + o - f); if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d; }
        return d2 - d1; }
      void main(){
        vec3 n = normalize(vN); float t = time;
        vec3 p = n * 4.0;
        // domain warp that slowly evolves → everything streams and curls
        vec3 w = vec3(fbm(p * 0.7 + vec3(0.0, t * 0.035, 0.0)), fbm(p * 0.7 + vec3(5.2, 1.3, t * 0.03)), fbm(p * 0.7 + vec3(t * 0.03, 7.7, 2.1)));
        vec3 q = p + (w - 0.5) * 3.2;
        // branching veins: ridges of two noise octaves, thin and bright where they cross
        float v1 = 1.0 - abs(noise(q * 1.6) * 2.0 - 1.0);
        float v2 = 1.0 - abs(noise(q * 3.4 + 4.0) * 2.0 - 1.0);
        float veins = pow(v1, 14.0) + pow(v2, 22.0) * 0.55 * smoothstep(0.6, 1.0, v1 + 0.4);
        // light pulsing along the veins, like blood or sap moving through them
        float flow = 0.35 + 0.65 * pow(0.5 + 0.5 * sin(dot(q, vec3(1.3, 2.1, 0.7)) * 2.2 - t * 1.6), 3.0);
        float memb = smoothstep(0.16, 0.0, cells(q * 1.1, t)) * 0.35;      // faint walls of the cells
        float breathe = 0.75 + 0.25 * sin(t * 0.55 + w.x * 4.0);
        // the skin only surfaces in a few drifting patches; they swell, fade and wander so it is never visible everywhere
        float pn = fbm(p * 0.38 + vec3(t * 0.02, -t * 0.03, t * 0.015)) + 0.12 * sin(t * 0.21 + n.x * 3.0);
        float veil = smoothstep(0.56, 0.74, pn);
        float base = exp(-max(n.y, 0.0) * 8.0) * smoothstep(0.45, 0.7, pn + 0.08); // thickest where it sinks into the land, also in patches
        float vis = veil * 0.45 + base * 0.55;
        float I = (veins * flow + memb) * vis * breathe + (veil * 0.02 + base * 0.045) * breathe;
        for (int i = 0; i < ${HITS}; i++) {
          float age = hits[i].w; if (age > 3.0) continue;
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
  let nextArc = 1.5, hitIdx = 0;
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
    const theta = rand(0, Math.PI * 2), y = Math.random() < 0.4 ? rand(0.03, 0.2) : rand(0.2, 0.9);
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
    SFX.zap(Math.min(1, 0.6 + y));
  }
  return {
    spawn,
    update(dt, time) {
      mat.uniforms.time.value = time;
      for (const h of hits) h.w += dt;
      nextArc -= dt;
      if (nextArc <= 0) { spawn(); if (Math.random() < 0.3) spawn(); nextArc = rand(0.8, 4); }
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
// bake the sky into an environment map so every glossy surface picks up cold sky reflections
{
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene(); envScene.add(new THREE.Mesh(sky.geometry, sky.material));
  scene.environment = pmrem.fromScene(envScene, 0, 0.1, 1000).texture;
}

scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x6a5a40, 0.55));
const sun = new THREE.DirectionalLight(0xffeccc, 2.75);
sun.position.copy(SUN_DIR).multiplyScalar(60);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -26, right: 26, top: 26, bottom: -26, near: 1, far: 140 });
sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.03;
scene.add(sun);
const coldFill = new THREE.DirectionalLight(0x9cc0ff, 1.1); // cold back light → steely rim glints
coldFill.position.set(-35, 20, -40);
scene.add(coldFill);

// ============================================================ arena
// ---- terrain: one height function shared by rendering and gameplay (feet, blood, pebbles follow it)
function groundH(x, z) {
  const r = Math.hypot(x, z);
  const h = 0.045 * Math.sin(x * 0.83 + 1.3) * Math.cos(z * 0.71 - 0.4)
        + 0.03 * Math.sin(x * 2.17 - z * 1.63 + 2.1)
        + 0.015 * Math.sin(x * 4.7 + z * 3.9) * Math.cos(x * 3.1 - z * 5.3);
  if (r < 19.5) return h + Math.max(0, r - 15.5) ** 2 * 0.03; // sand banked up against the stockade
  const far = clamp((r - 58) / 40, 0, 1); // the town stays gentle, hills roll beyond the city wall
  return h * 3 + 0.22 * Math.sin(x * 0.11 + z * 0.07) * Math.cos(z * 0.09 - x * 0.05)
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
const macro = (x, z, s) => 0.5 + 0.5 * (Math.sin(x * 0.27 * s + 1.7) * Math.cos(z * 0.23 * s - 0.6) * 0.6 + Math.sin((x - z) * 0.61 * s) * 0.25 + Math.sin(x * 1.37 * s + z * 0.97 * s) * 0.15);
const sandMaps = groundMaps(1024, { blobs: 260, blobR: [6, 46], ripples: 40, stones: 140, grains: 9000, strength: 3.2, contrast: 1.5, dark: [78, 60, 40], light: [150, 124, 92], repeat: 7 });
terrainMesh(new THREE.RingGeometry(0.001, 19.4, 200, 80), sandMaps, (x, z) => {
  const m = macro(x, z, 1), r = Math.hypot(x, z), trodden = Math.exp(-r * r / 60) * 0.12;
  const v = 0.78 + m * 0.3 - trodden + (r > 16 ? 0.06 : 0);
  return [v * 1.02, v, v * 0.95];
});
const grassMaps = groundMaps(512, { blobs: 220, blobR: [6, 50], stones: 30, grains: 22000, blades: true, strength: 2.4, contrast: 1.4, dark: [36, 46, 22], light: [92, 104, 56], repeat: 70 });
terrainMesh(new THREE.RingGeometry(19.0, 260, 160, 90), grassMaps, (x, z) => {
  const m = macro(x, z, 0.35), d = macro(x + 40, z - 17, 0.9), r = Math.hypot(x, z);
  const worn = Math.exp(-((r - 22) ** 2) / 8) * 0.5 + (Math.abs(x) < 4 && z < -18 ? 0.5 : 0); // trampled ring + road edge
  const dry = clamp(d * 0.6 + worn, 0, 1), b = 0.85 + m * 0.3;
  return [lerp(0.8, 1.25, dry) * b, lerp(1, 0.92, dry) * b, 0.83 * b];
});
// loose pebbles on the sand
{
  const n = 320, peb = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(1, 0), std(0xffffff, 0.75), n);
  const d = new THREE.Object3D(), c = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const a = rand(0, 6.28), r = Math.sqrt(Math.random()) * 17.8, x = Math.sin(a) * r, z = Math.cos(a) * r, s = rand(0.03, 0.085);
    d.position.set(x, groundH(x, z) + s * 0.1, z); d.rotation.set(rand(0, 3), rand(0, 3), rand(0, 3)); d.scale.set(s, s * rand(0.4, 0.7), s * rand(0.7, 1.1));
    d.updateMatrix(); peb.setMatrixAt(i, d.matrix);
    const v = rand(0.28, 0.5); peb.setColorAt(i, c.setRGB(v * 0.95, v * 0.85, v * 0.7));
  }
  peb.castShadow = peb.receiveShadow = true; scene.add(peb);
}
// grass tufts around the outside of the stockade
{
  const n = 900, tuft = new THREE.InstancedMesh(new THREE.ConeGeometry(0.12, 0.45, 4), std(0xffffff, 0.9), n);
  const d = new THREE.Object3D(), c = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const a = rand(0, 6.28), r = rand(19.6, 60), x = Math.sin(a) * r, z = Math.cos(a) * r, s = rand(0.6, 1.6);
    d.position.set(x, groundH(x, z) + 0.18 * s, z); d.rotation.set(rand(-0.2, 0.2), rand(0, 3), rand(-0.2, 0.2)); d.scale.setScalar(s);
    d.updateMatrix(); tuft.setMatrixAt(i, d.matrix); tuft.setColorAt(i, c.setHSL(rand(0.17, 0.25), rand(0.25, 0.45), rand(0.13, 0.22)));
  }
  tuft.receiveShadow = true; scene.add(tuft);
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

// dark, mossy, soot-streaked masonry — shared by the arena wall and the town
const stoneTex = canvasTex(256, (g, s) => {
  g.fillStyle = '#26231f'; g.fillRect(0, 0, s, s); // deep mortar joints
  const rows = 8, h = s / rows;
  for (let r = 0; r < rows; r++) {
    let x = (r % 2) * -18;
    while (x < s) {
      const w = rand(24, 46), v = rand(50, 82) | 0, warm = rand(0, 10) | 0;
      g.fillStyle = `rgb(${v + warm + 4},${v},${v - 10 - warm})`; g.fillRect(x + 2, r * h + 2, w - 3, h - 3);
      const gr = g.createLinearGradient(0, r * h, 0, r * h + h); // worn, rounded faces
      gr.addColorStop(0, 'rgba(255,245,230,.08)'); gr.addColorStop(1, 'rgba(0,0,0,.28)');
      g.fillStyle = gr; g.fillRect(x + 2, r * h + 2, w - 3, h - 3);
      for (let k = 0; k < 2; k++) { g.fillStyle = 'rgba(20,18,15,.35)'; g.beginPath(); g.arc(x + rand(4, w - 4), r * h + (Math.random() < .5 ? 3 : h - 3), rand(1.5, 3.5), 0, 7); g.fill(); } // chipped arrises
      x += w;
    }
  }
  weather(g, s, { streaks: 26, streakA: 0.3, damp: 0.4, dampA: 0.45, blotches: 30, moss: 0.55, grit: 3000 });
});
const stoneM = surfMat(stoneTex, 0.95, 3); stoneM.userData.world = 3.5;

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
  for (let i = -5; i <= 5; i++) mesh(new THREE.BoxGeometry(0.1, 2.0, 0.1), rustM, scene, [i * 0.42, 5.4, -R - 0.1]);
  for (const y of [4.65, 5.5]) mesh(new THREE.BoxGeometry(4.6, 0.1, 0.12), rustM, scene, [0, y, -R - 0.1]);
  for (let i = -5; i <= 5; i++) mesh(cone(0.07, 0.25, 4), rustM, scene, [i * 0.42, 4.3, -R - 0.1], [Math.PI, 0, 0]);
  // a dark pen beyond the gate
  const pen = mesh(new THREE.BoxGeometry(5, 6, 8), std(0x0d0806, 1), scene, [0, 3, -R - 4.4]);
  pen.material.side = THREE.BackSide;

  // two tiers of spectator stands behind the stockade
  for (let i = 0; i < 44; i++) {
    const a = (i / 44) * Math.PI * 2;
    if (Math.abs(angWrap(a - Math.PI)) < 0.4) continue;
    for (const [r, y] of STAND_TIERS) {
      mesh(new THREE.BoxGeometry(2.9, 0.22, 1.4), darkWood, scene, [Math.sin(a) * r, y, Math.cos(a) * r], [0, a, 0]);
      mesh(new THREE.BoxGeometry(0.18, y, 0.18), darkWood, scene, [Math.sin(a) * (r + 0.5), y / 2, Math.cos(a) * (r + 0.5)]);
    }
  }
})();

// ============================================================ the town, city wall and castle
function buildTown() {
  const tmp = new THREE.Group();
  const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
  const pick = a => a[(Math.random() * a.length) | 0];

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
  const planksM = surfMat(planksTex, 0.95, 2.5, 0, { side: THREE.DoubleSide }); planksM.userData.world = 3;

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
    clay:    { mat: surfMat(clayTex, 0.9, 2, 0, { side: THREE.DoubleSide }), tw: 0.36, course: 0.32, lift: 0.075, jit: 0.45, sag: 0.1, ridge: 0.13 },
    slate:   { mat: surfMat(slateTex, 0.8, 1.5, 0, { side: THREE.DoubleSide }), tw: 0.38, course: 0.26, lift: 0.04, jit: 0.5, sag: 0.07, ridge: 0.09 },
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
  const mountM = std(0x5a6774, 1), snowM = std(0xe4e8ee, 0.6);

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
    const w = rand(5, 7.5), d = rand(5, 6.5), storeys = Math.random() < 0.5 ? 2 : 3, gh = 3.2, plaster = pick(plasterMs);
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
    const R = ROOF[pick(['clay', 'clay', 'clay', 'slate', 'shingle'])], rh = fd * rand(0.6, 0.85);
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
    gableRoof(g, ROOF.thatch, w + 0.9, d + 1.5, rh + 0.25, wh - 0.2);
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
    gableRoof(g, ROOF.shingle, w + 0.6, d + 0.8, rh, wh);
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
    const w = rand(4.2, 5.2), d = rand(6, 7.5), storeys = Math.random() < 0.5 ? 3 : 4, gh = 3.2, plaster = pick(plasterMs);
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
    const R = ROOF[pick(['slate', 'slate', 'clay'])], rh = fw * rand(0.95, 1.25);
    gableRoof(g, R, fd + 0.6, fw + 0.6, rh, y, jet / 2, Math.PI / 2); // ridge runs front to back
    const ends = new THREE.Mesh(gableEndGeo(fd, fw, rh * 0.95), daubM); ends.position.set(0, y, jet / 2); ends.rotation.y = Math.PI / 2; g.add(ends);
    win(g, 0, y + rh * 0.35, jet / 2 + fd / 2 + 0.02, 0.6, 0.8, false); // attic window in the gable
    if (Math.random() < 0.3) sign(g, w * 0.45, 2.9, d / 2);
    chimney(g, fw / 2 - 0.4, -fd * 0.25, y + rh * 0.5);
  }

  // houses in rings around the arena, leaving a road open towards the castle; the inner rings are denser and taller
  for (const [r, n, jitter, mix] of [[27, 24, 1.5, [timberHouse, timberHouse, townhouse, townhouse, plankHouse]], [37, 30, 2, [timberHouse, townhouse, plankHouse, cottage]], [48, 36, 2.5, [timberHouse, plankHouse, cottage, cottage]]]) {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rand(-0.04, 0.04);
      if (Math.abs(angWrap(a - Math.PI)) < 6 / r) continue;
      if (r === 37 && Math.abs(angWrap(a - 1.05)) < 0.18) continue; // bell tower plot
      const rr = r + rand(-jitter, jitter);
      const g = new THREE.Group(); g.position.set(Math.sin(a) * rr, 0, Math.cos(a) * rr); g.rotation.y = a + Math.PI + rand(-0.12, 0.12); tmp.add(g);
      pick(mix)(g);
    }
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
  for (let i = 0; i < 22; i++) {
    const a = (i / 22) * Math.PI * 2 + rand(-0.1, 0.1), r = rand(185, 215), h = rand(45, 90), rad = rand(40, 65);
    mesh(cone(rad, h, 7), mountM, tmp, [Math.sin(a) * r, h / 2 - 3, Math.cos(a) * r], [0, rand(0, 3), 0]);
    mesh(cone(rad * 0.32, h * 0.32, 7), snowM, tmp, [Math.sin(a) * r, h - 3 - h * 0.16 + 0.3, Math.cos(a) * r], [0, rand(0, 3), 0]);
  }
  bakeStatic(tmp);
}
// merge all static town geometry by material → a handful of draw calls
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
    if (!bins.has(o.material)) bins.set(o.material, []);
    bins.get(o.material).push(g);
  });
  for (const [mat, arr] of bins) {
    const m = new THREE.Mesh(mergeGeometries(arr), mat);
    m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false;
    scene.add(m);
  }
}

// spectators on the stands — instanced, they jump when blood is drawn
let crowdExcite = 0;
const crowd = (() => {
  const spots = [];
  for (const [r, y] of STAND_TIERS) for (let i = 0; i < 70; i++) {
    const a = rand(0, Math.PI * 2);
    if (Math.abs(angWrap(a - Math.PI)) < 0.45) continue;
    spots.push({ a, r: r + rand(-0.3, 0.3), y: y + 0.11, ph: rand(0, 6), sp: rand(0.8, 1.3) });
  }
  const bodies = new THREE.InstancedMesh(capsule(0.22, 0.55), std(0xffffff, 0.9), spots.length);
  const heads = new THREE.InstancedMesh(sphere(0.16, 10, 8), std(0xc89a7a, 0.7), spots.length);
  const tunic = [0x4a2218, 0x26364a, 0x45452a, 0x5a4e3c, 0x2e4230, 0x605444, 0x3a3044, 0x5e2c18];
  const c = new THREE.Color();
  spots.forEach((s, i) => { bodies.setColorAt(i, c.setHex(tunic[i % tunic.length])); });
  bodies.castShadow = heads.castShadow = true;
  scene.add(bodies, heads);
  const d = new THREE.Object3D();
  return {
    update(t) {
      spots.forEach((s, i) => {
        const jump = Math.max(0, Math.sin(t * (2.5 + crowdExcite * 7) * s.sp + s.ph)) * (0.03 + crowdExcite * 0.35);
        d.position.set(Math.sin(s.a) * s.r, s.y + 0.5 + jump, Math.cos(s.a) * s.r);
        d.rotation.set(0, s.a + Math.PI, Math.sin(t * 1.3 + s.ph) * 0.05); d.updateMatrix(); bodies.setMatrixAt(i, d.matrix);
        d.position.y += 0.52; d.updateMatrix(); heads.setMatrixAt(i, d.matrix);
      });
      bodies.instanceMatrix.needsUpdate = true; heads.instanceMatrix.needsUpdate = true;
    },
  };
})();

// props scattered around the edge
const banners = [];
(function props() {
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
    mesh(new THREE.BoxGeometry(s, s, s), crateMat, scene, [Math.sin(a) * r, s / 2, Math.cos(a) * r], [0, rand(0, 3), 0]);
  }
  const barrelMat = surfMat(woodTex, 0.9, 2.5, 0, { color: 0x9a8070 });
  for (const a of [0.55, -1.4, 2.0, -2.75]) {
    const r = 17.0;
    const b = mesh(new THREE.CylinderGeometry(0.42, 0.42, 1.1, 14), barrelMat, scene, [Math.sin(a) * r, 0.55, Math.cos(a) * r]);
    mesh(new THREE.TorusGeometry(0.43, 0.03, 6, 18), rustM, b, [0, 0.35, 0], [Math.PI / 2, 0, 0]);
    mesh(new THREE.TorusGeometry(0.43, 0.03, 6, 18), rustM, b, [0, -0.35, 0], [Math.PI / 2, 0, 0]);
  }
  // bleached bones in the sand
  const boneMat = std(0xa89c82, 0.85);
  for (let i = 0; i < 18; i++) {
    const a = rand(0, 6.28), r = rand(4, 16);
    mesh(new THREE.CylinderGeometry(0.04, 0.05, rand(0.4, 0.9), 6), boneMat, scene, [Math.sin(a) * r, groundH(Math.sin(a) * r, Math.cos(a) * r) + 0.03, Math.cos(a) * r], [Math.PI / 2, 0, rand(0, 3)]);
  }
  // banners
  const clothMat = std(0x5a1812, 0.97, 0, { side: THREE.DoubleSide });
  for (const a of [Math.PI + 0.55, Math.PI - 0.55, 0.0]) {
    const r = 18.0;
    mesh(new THREE.CylinderGeometry(0.06, 0.06, 7.5, 6), darkWood, scene, [Math.sin(a) * r, 3.75, Math.cos(a) * r]);
    const cloth = mesh(new THREE.PlaneGeometry(1.1, 2.4, 4, 8), clothMat, scene, [Math.sin(a) * (r - 0.05), 5.9, Math.cos(a) * (r - 0.05)], [0, a + Math.PI, 0]);
    banners.push({ m: cloth, base: cloth.geometry.attributes.position.array.slice(), ph: rand(0, 6) });
  }
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
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) continue;
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
    for (const n of ['position', 'pcolor', 'alpha', 'psize']) this.geo.attributes[n].needsUpdate = true;
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
  const postMat = darkWood, ironMat = rustM;
  angles.forEach((a, i) => {
    const r = 17.5, x = Math.sin(a) * r, z = Math.cos(a) * r;
    mesh(new THREE.CylinderGeometry(0.08, 0.1, 2.7, 7), postMat, scene, [x, 1.35, z]);
    mesh(new THREE.CylinderGeometry(0.22, 0.1, 0.25, 10, 1, true), ironMat, scene, [x, 2.78, z]);
    const t = { p: new V3(x, 2.95, z), acc: 0, seed: rand(0, 100), light: null };
    if (i % 2 === 0) {
      t.light = new THREE.PointLight(0xff8a3c, 10, 12, 1.7);
      t.light.position.copy(t.p).add(new V3(-x * 0.03, 0.3, -z * 0.03));
      scene.add(t.light);
    }
    torches.push(t);
  });
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
      t.light.intensity = 10 * (0.85 + 0.15 * f);
    }
  }
}

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
  let ctx, out, layers = {}, nextT = 0, step = 0, on = true, vol = 0.8, intensity = -1, ducked = false;
  const banks = {}; // inst -> Map(midi -> AudioBuffer)
  // Slow, dark and modal: D minor with Phrygian E-flat colour, long drones, sparse plucked voices.
  const BPM = 62, S16 = 60 / BPM / 4, LOOP = 256;
  const CH = {
    Dm: [38, 50, 57, 62, 65], Eb: [39, 51, 58, 63, 67], A: [33, 45, 57, 61, 64], Asus: [33, 45, 57, 62, 64],
    Gm: [31, 43, 58, 62, 67], Bb: [34, 46, 58, 62, 65],
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
  function schedule(s, t) {
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
    // fight layers: low horn swells, a heavy pulse, and a heartbeat on the war drums
    if (p === 0) play('horn', 'brass', ch[1], t, barLen, 0.22, 1.4, 1.0);
    if (p % 4 === 0) play('pizz', 'low', ch[0] + (p === 8 ? 7 : 0), t, S16 * 3, 0.42, 0.4);
    if (p === 0) play('drum', 'perc', 36, t, 2, 0.8, 1.0);
    if (p === 3) play('drum', 'perc', 36, t, 2, 0.5, 1.0);
    if (p === 10 && bi % 2 === 1) play('drum', 'perc', 33, t, 2, 0.45, 1.0);
    if (bi === 7) { if (p % 2 === 0) play('timp', 'perc', 33, t, 1.2, 0.15 + (p / 16) * 0.45, 0.6); }
    else if (p === 0 && bi % 2 === 0) play('timp', 'perc', ch[0], t, 3, 0.55, 1.2);
  }
  function tick() {
    if (!ctx || ctx.state !== 'running') return;
    if (nextT < ctx.currentTime - 1) nextT = ctx.currentTime + 0.05;
    while (nextT < ctx.currentTime + 0.25) { schedule(step, nextT); nextT += S16; step = (step + 1) % LOOP; }
  }
  function setIntensity(x) {
    if (!ctx || Math.abs(x - intensity) < 0.01) return;
    intensity = x;
    const lv = { strings: 0.9, choir: 0.75 - 0.2 * x, harp: 0.8 - 0.35 * x, lute: 0.7 - 0.3 * x, low: 0.8 * x, brass: 0.9 * x, calm: 0.85 - 0.35 * x, perc: 0.9 * x };
    for (const k in lv) layers[k].gain.setTargetAtTime(lv[k], ctx.currentTime, 1.2);
  }
  const apply = () => ctx && out.gain.setTargetAtTime(on ? vol * (ducked ? 0.4 : 1) : 0, ctx.currentTime, 0.15);
  return {
    init, setIntensity,
    toggle() { on = !on; apply(); return on; },
    setVolume(v) { vol = v; apply(); },
    duck(d) { ducked = d; apply(); },
    get volume() { return vol; }, get enabled() { return on; },
  };
})();
function nz({ dur = 0.2, type = 'bandpass', f0 = 1000, f1 = f0, q = 1, gain = 0.4, attack = 0.004, delay = 0 }) {
  if (!AC) return;
  const t = AC.currentTime + delay;
  const s = AC.createBufferSource(); s.buffer = noiseBuf;
  const f = AC.createBiquadFilter(); f.type = type; f.Q.value = q;
  f.frequency.setValueAtTime(f0, t); f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
  const g = AC.createGain(); g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + attack); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  s.connect(f).connect(g).connect(master); s.start(t, Math.random()); s.stop(t + dur + 0.05);
}
function tn({ dur = 0.2, type = 'sine', f0 = 440, f1 = f0, gain = 0.3, attack = 0.004, delay = 0, lp = 0, vib = 0, vibF = 25 }) {
  if (!AC) return;
  const t = AC.currentTime + delay;
  const o = AC.createOscillator(); o.type = type;
  o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
  let node = o;
  if (vib) { const l = AC.createOscillator(); l.frequency.value = vibF; const lg = AC.createGain(); lg.gain.value = vib; l.connect(lg).connect(o.frequency); l.start(t); l.stop(t + dur + 0.05); }
  if (lp) { const f = AC.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = lp; node.connect(f); node = f; }
  const g = AC.createGain(); g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + attack); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  node.connect(g).connect(master); o.start(t); o.stop(t + dur + 0.05);
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
  zap(near = 1) {
    for (let i = 0, t = 0; i < 6; i++, t += rand(0.015, 0.07)) nz({ dur: rand(0.02, 0.06), type: 'highpass', f0: rand(2500, 4500), f1: 1400, gain: 0.035 * near, delay: t });
    nz({ dur: 1.4, type: 'lowpass', f0: 260, f1: 50, gain: 0.08 * near, attack: 0.15, delay: rand(0.3, 0.7) });
  },
  whiff() { nz({ dur: 0.22, f0: 600, f1: 1600, q: 0.8, gain: 0.18 }); },
};

// ============================================================ the hero
function buildHero() {
  const M = {
    skin: phys(0xc4906f, 0.6, 0, { sheen: 0.3, sheenColor: 0xffd8c0 }),
    leather: phys(0x4b3020, 0.55, 0, { clearcoat: 0.55, clearcoatRoughness: 0.3 }),
    cloth: phys(0x37362c, 0.85, 0, { sheen: 0.7, sheenColor: 0x9fb4cc, sheenRoughness: 0.45 }),
    sash: phys(0x8c2a1c, 0.8, 0, { sheen: 0.5, sheenColor: 0xd0c0c8 }),
    boot: phys(0x271a10, 0.45, 0, { clearcoat: 0.6, clearcoatRoughness: 0.25 }), hair: std(0x2a1b12, 1),
    metal: phys(0xd8e0ea, 0.12, 1.0, { clearcoat: 1, clearcoatRoughness: 0.06, emissive: 0x000000 }),
    steel: phys(0xb4bfcc, 0.2, 1.0, { clearcoat: 0.9, clearcoatRoughness: 0.12 }),
    iron: phys(0x5c6168, 0.3, 0.9, { clearcoat: 0.6, clearcoatRoughness: 0.2 }), eye: phys(0x111111, 0.1, 0, { clearcoat: 1 }),
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
  block: pose({ spine: [0.12, 0.15, 0], neck: [-0.05, -0.15, 0], rSh: [-1.25, 0, 0.25], rEl: [-1.25, 0, 0], rHa: [0.65, 1.35, 0], lSh: [-1.0, 0, 0.1], lEl: [-1.4, 0, 0], lHip: [-0.42, 0, 0.06], lKn: [0.55, 0, 0], rHip: [0.32, 0, -0.08], rKn: [0.45, 0, 0], hy: -0.1 }),
  hurt: pose({ spine: [-0.45, 0, 0.15], neck: [-0.4, 0, 0], rSh: [-0.2, 0, -0.6], rEl: [-0.6, 0, 0], lSh: [-0.1, 0, 0.7], lEl: [-0.4, 0, 0], lHip: [0.2, 0, 0], lKn: [0.4, 0, 0], rHip: [-0.3, 0, 0], rKn: [0.5, 0, 0], hy: -0.08 }),
  dodge: pose({ spine: [0.32, 0, 0], neck: [-0.25, 0, 0], rSh: [-0.4, 0, -0.5], rEl: [-0.9, 0, 0], lSh: [-0.3, 0, 0.6], lEl: [-0.8, 0, 0], lHip: [-0.9, 0, 0], lKn: [1.2, 0, 0], rHip: [-0.35, 0, 0], rKn: [1.0, 0, 0], hy: -0.22 }),
  dead: pose({ spine: [-0.2, 0, 0], neck: [-0.5, 0.4, 0], rSh: [-2.6, 0, -0.6], rEl: [-0.2, 0, 0], lSh: [-2.4, 0, 0.7], lEl: [-0.3, 0, 0], lHip: [-0.2, 0, 0.1], rHip: [-0.1, 0, -0.15], lKn: [0.2, 0, 0], rKn: [0.3, 0, 0] }),
};
const SWINGS = {
  chop: { w: 'chopW', s: 'chopS', arc: 0.6, dmg: 1.0, lunge: 1.5 },
  rl: { w: 'rlW', s: 'rlS', arc: 1.2, dmg: 0.9, lunge: 1.0 },
  lr: { w: 'lrW', s: 'lrS', arc: 1.2, dmg: 0.95, lunge: 1.0 },
  heavy: { w: 'heavyW', s: 'heavyS', arc: 0.7, dmg: 1.75, lunge: 2.6, slow: 1.3 },
};
const COMBO = ['chop', 'rl', 'lr', 'heavy'];

const hero = buildHero();
// Blender-built hero (tools/build_hero.py -> models/hero.glb); swapped in place of the primitive hero at load.
function buildHeroGLB(tpl) {
  const vc = { vertexColors: true };
  const M = {
    skin: phys(0xc4906f, 0.6, 0, { ...vc, sheen: 0.3, sheenColor: 0xffd8c0 }),
    leather: phys(0x5a3622, 0.55, 0, { ...vc, clearcoat: 0.55, clearcoatRoughness: 0.3 }),
    cloth: phys(0x3d3c31, 0.85, 0, { ...vc, sheen: 0.7, sheenColor: 0x9fb4cc, sheenRoughness: 0.45 }),
    sash: phys(0x8c2a1c, 0.8, 0, { ...vc, sheen: 0.5, sheenColor: 0xd0c0c8 }),
    boot: phys(0x2b1d12, 0.45, 0, { ...vc, clearcoat: 0.6, clearcoatRoughness: 0.25 }),
    hair: std(0x2a1b12, 1, 0, vc),
    steel: phys(0xb4bfcc, 0.2, 1.0, { ...vc, clearcoat: 0.9, clearcoatRoughness: 0.12 }),
    iron: phys(0x5c6168, 0.3, 0.9, { ...vc, clearcoat: 0.6, clearcoatRoughness: 0.2 }),
    metal: phys(0xd8e0ea, 0.12, 1.0, { ...vc, clearcoat: 1, clearcoatRoughness: 0.06, emissive: 0x000000 }),
    eye: phys(0x111111, 0.1, 0, { ...vc, clearcoat: 1 }),
  };
  const model = tpl.clone(true);
  model.traverse(o => { if (o.isMesh) { o.material = M[(o.material.name || '').toLowerCase()] || M.cloth; o.castShadow = true; o.receiveShadow = true; } });
  const f = n => model.getObjectByName(n);
  const root = new THREE.Group(); root.rotation.order = 'YXZ'; root.add(model);
  const j = { hips: f('Hips'), spine: f('Spine'), neck: f('Neck'), lSh: f('ShoulderL'), lEl: f('ElbowL'), lHa: f('HandL'),
    rSh: f('ShoulderR'), rEl: f('ElbowR'), rHa: f('HandR'), lHip: f('HipL'), lKn: f('KneeL'), rHip: f('HipR'), rKn: f('KneeR') };
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
  combo: 0, comboT: 0, ghostHp: 100,
};

// ============================================================ the Thornbeak (original creature)
const PALETTES = [
  { plume: 0x3c4048, rust: 0x7a3d22, belly: 0x8a6a4a, name: 'THORNBEAK' },
  { plume: 0x5a5146, rust: 0xa0742e, belly: 0xa08868, name: 'ASHEN THORNBEAK' },
  { plume: 0x1d1a1c, rust: 0x8e1c18, belly: 0x5a3a30, name: 'BLOODCREST THORNBEAK' },
];
// glossy, oily plumage with a cold blue sheen; lacquered beak, thorns and talons
function beastMaterials(pal, vc) {
  const o = { vertexColors: vc };
  return {
    // matte, dusty feathers: only a faint, warm sheen at grazing angles, no lacquer
    plume: phys(pal.plume, 0.9, 0, { ...o, sheen: 0.25, sheenColor: 0x6a6258, sheenRoughness: 0.8, envMapIntensity: 0.4 }),
    rust: phys(pal.rust, 0.9, 0, { ...o, sheen: 0.2, sheenColor: 0x6a5a4a, sheenRoughness: 0.8, envMapIntensity: 0.4 }),
    belly: std(pal.belly, 0.95, 0, { ...o, envMapIntensity: 0.4 }),
    bone: std(0xb8ac94, 0.7, 0, { ...o, envMapIntensity: 0.5 }),
    scale: std(0x4a3a28, 0.75, 0, { ...o, envMapIntensity: 0.5 }),
    claw: std(0x1a130d, 0.55, 0, { ...o, envMapIntensity: 0.6 }),
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
    this.rig = buildBeast(this.s, pal); scene.add(this.rig.root);
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
    this.rig.root.position.copy(this.pos);
  }
  setState(s) { this.state = s; this.t = 0; this.hitDone = false; }
  forward() { return this.fwd.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)); }
  takeHit(dmg, dir, heavy) {
    if (this.dead) return;
    this.hp -= dmg; this.flash = 0.12;
    const hp = this.pos.clone().add(new V3(0, 1.25 * this.s, 0)).addScaledVector(dir, -0.5 * this.s);
    popText(hp, String(dmg), heavy ? 'crit' : '');
    bloodBurst(hp, dir, heavy ? 34 : 20);
    feathers(hp, heavy ? 6 : 3, [this.pal.plume >> 16 & 255, this.pal.plume >> 8 & 255, this.pal.plume & 255].map(v => v / 255 * 0.6));
    hitStop = heavy ? 0.12 : 0.07; shake = Math.max(shake, heavy ? 0.55 : 0.3); SFX.hit(heavy);
    crowdExcite = Math.min(1, crowdExcite + (heavy ? 0.6 : 0.35));
    if (this.hp <= 0) { this.die(dir); return; }
    this.hitChain = time - this.lastHit < 1.7 ? this.hitChain + 1 : 1; this.lastHit = time;
    if (this.state === 'lunge' && !heavy) return; // hyper-armour mid-charge
    if (this.hitChain >= 3 && !heavy && Math.random() < 0.5 * this.aggr) { // breaks the combo with a leap back
      this.setState('hop'); this.iframes = 0.4; this.vel.copy(dir).multiplyScalar(7.5); SFX.squawk(this.pitch * 1.1);
      dust(this.pos, 8, 0.6, 1.4); return;
    }
    this.setState('stagger'); this.stagDur = heavy ? 0.6 : 0.34; this.stagRoll = rand(-0.25, 0.25);
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
    SFX.screech(this.pitch * 0.8); slowMo = 0.9; crowdExcite = 1;
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
    for (const m of R.flashMats) m.emissive.setRGB(0.6 * f, 0.08 * f, 0.04 * f);
    const tele = st === 'lungeWind' || st === 'peckWind' ? 1 : 0;
    R.M.eye.emissiveIntensity = damp(R.M.eye.emissiveIntensity, st === 'dead' ? 0 : 2.4 + tele * 5, 10, dt);
  }
  dispose() { scene.remove(this.rig.root); }
}

// ============================================================ combat glue
let hitStop = 0, slowMo = 0, shake = 0, time = 0, lockOn = true;
const vignette = document.getElementById('vignette');
let vignetteA = 0;

function currentTarget() {
  if (!P.drawn || !lockOn || P.state === 'dead') return null;
  let best = null, bd = 15;
  for (const e of beasts) {
    if (e.dead || e.state === 'wait') continue;
    const d = Math.hypot(e.pos.x - P.pos.x, e.pos.z - P.pos.z);
    if (d < bd) { bd = d; best = e; }
  }
  return best;
}

function hitPlayer(e, dmg, heavy) {
  if (P.state === 'dead' || P.iframes > 0) return false;
  const angTo = yawTo(P.pos, e.pos);
  const facing = Math.abs(angWrap(angTo - P.yaw)) < 1.25;
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
  }
  P.hp -= dmg;
  const hp = P.pos.clone().add(new V3(0, 1.35, 0));
  popText(hp, String(dmg), 'player');
  bloodBurst(hp, dir, 14);
  shake = Math.max(shake, heavy ? 0.6 : 0.35); hitStop = 0.06; vignetteA = 1;
  P.pain = Math.min(1.6, (P.pain || 0) + (heavy ? 1.2 : 0.8)); P.painSeed = rand(0, 10);
  if (P.hp > 0) SFX.hurt(heavy);
  P.combo = 0;
  if (P.hp <= 0) { P.hp = 0; P.state = 'dead'; P.t = 0; SFX.scream(); P.pain = 2; P.vel.copy(dir).multiplyScalar(3); onPlayerDeath(); return true; }
  P.state = 'hurt'; P.t = 0; P.stunDur = heavy ? 0.75 : 0.36;
  P.vel.copy(dir).multiplyScalar(heavy ? 7.5 : 3);
  trail.samples.length = 0; hero.bladeMat.emissive.setRGB(0, 0, 0);
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
    const dmg = Math.round(17 * P.swing.dmg * (1 + P.step * 0.12) * rand(0.92, 1.08));
    P.combo++; P.comboT = 2.2;
    e.takeHit(dmg, new V3(dx, 0, dz).normalize(), heavy);
  }
}

function startAttack(step, lf, rt, target) {
  let type = COMBO[step];
  if (step < 3) { if (lf) type = 'rl'; else if (rt) type = 'lr'; }
  const sw = SWINGS[type];
  Object.assign(P, { state: 'attack', t: 0, step, swing: sw, swingType: type, queued: false, failed: false, swungSound: false });
  P.hitSet.clear();
  const sp = Math.pow(0.9, step) * (sw.slow || 1);
  P.times = { w: 0.21 * sp, a: 0.11 * sp, r: 0.42 * sp };
  P.st = Math.max(0, P.st - (7 + step * 2)); P.stDelay = 0.6;
  if (target) P.yaw = dampAng(P.yaw, yawTo(P.pos, target.pos), 30, 0.05);
}

// ============================================================ player update
function updatePlayer(dt) {
  const target = currentTarget();
  P.iframes = Math.max(0, P.iframes - dt); P.stDelay -= dt;
  P.comboT -= dt; if (P.comboT <= 0) P.combo = 0;
  const fw = keys.KeyW || keys.ArrowUp, bw = keys.KeyS || keys.ArrowDown;
  const lf = keys.KeyA || keys.ArrowLeft, rt = keys.KeyD || keys.ArrowRight;
  const sl = keys.KeyQ, sr = keys.KeyE;
  const wantAttack = pressed.has('Attack') || pressed.has('KeyJ');
  const wantBlock = mouseR || keys.KeyK;
  const wantDraw = pressed.has('KeyF') || pressed.has('Digit1');
  const wantDodge = pressed.has('Space');
  const sprint = keys.ShiftLeft || keys.ShiftRight;
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

  switch (P.state) {
    case 'idle':
    case 'block': {
      if (!canAct) { tp = P.drawn ? POSE.stance : POSE.relaxed; break; }
      if (wantDraw) { startDraw(); break; }
      if (wantAttack) { if (!P.drawn) { startDraw(); break; } if (P.st >= 6) { startAttack(0, lf, rt, target); break; } }
      if (wantDodge && P.drawn && P.st >= 18) { startDodge(); break; }
      P.state = wantBlock && P.drawn ? 'block' : 'idle';
      let turn = 0, f = 0, s = 0;
      if (fw) f += 1; if (bw) f -= 0.65;
      if (target) { if (lf) s -= 1; if (rt) s += 1; } else { if (lf) turn += 1; if (rt) turn -= 1; }
      if (sl) s -= 1; if (sr) s += 1;
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
      const { w, a, r } = P.times, tot = w + a + r, winStart = w + a + 0.02;
      if (wantAttack && P.step < 3) {
        if (P.t >= winStart && !P.failed && P.st >= 4) {
          const late = (P.t - winStart) / (tot - winStart);
          popText(hero.swordTip.getWorldPosition(new V3()), late < 0.4 ? 'PERFECT' : 'GOOD', 'timing');
          startAttack(P.step + 1, lf, rt, target);
          break;
        } else if (P.t < winStart) P.failed = true;
      }
      if (wantDodge && P.t > w + a && P.st >= 18) { startDodge(); hero.bladeMat.emissive.setRGB(0, 0, 0); break; }
      if (!P.swungSound && P.t >= w * 0.7) { SFX.swing(P.step); P.swungSound = true; }
      if (P.t < w && target) P.yaw = dampAng(P.yaw, yawTo(P.pos, target.pos), 10, dt);
      else if (P.t < w) { if (lf) P.yaw += 1.2 * dt; if (rt) P.yaw -= 1.2 * dt; }
      let v = 0;
      if (P.t >= w * 0.5 && P.t < w + a) v = P.swing.lunge * 2.6; else if (P.t < w + a + r * 0.3) v = P.swing.lunge * 0.5;
      desired.copy(fwdV).multiplyScalar(v); velK = 20;
      if (P.t >= w && P.t < w + a + 0.025) checkPlayerHits();
      const W = POSE[P.swing.w], S = POSE[P.swing.s], base = POSE.stance;
      if (P.t < w) tp = blend(base, W, ease(P.t / w));
      else if (P.t < w + a) tp = blend(W, S, ease((P.t - w) / a));
      else tp = blend(S, base, ease(clamp(((P.t - w - a) / r - 0.3) / 0.7, 0, 1)));
      k = 30;
      const inWin = P.step < 3 && !P.failed && P.t >= winStart;
      const g = inWin ? 0.6 + 0.4 * Math.sin(P.t * 40) : 0;
      hero.bladeMat.emissive.setRGB(0.9 * g, 0.55 * g, 0.2 * g);
      if (P.t >= tot) { P.state = 'idle'; hero.bladeMat.emissive.setRGB(0, 0, 0); }
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
      P.t += dt; tp = POSE.hurt; k = 18; velK = 5;
      if (P.t > P.stunDur) P.state = 'idle';
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

  // walk cycle layered on top of the upper-body pose
  P.vel.x = damp(P.vel.x, desired.x, velK, dt); P.vel.z = damp(P.vel.z, desired.z, velK, dt);
  const spd = Math.hypot(P.vel.x, P.vel.z);
  if (moving && spd > 0.3) {
    tp = blend(tp, tp, 0);
    const a = Math.min(1.2, spd / 4.2);
    P.gait += dt * (4 + spd * 1.7);
    const s = Math.sin(P.gait), c = Math.cos(P.gait);
    const fdot = (P.vel.x * fwdV.x + P.vel.z * fwdV.z) / spd;
    const dir = fdot < -0.3 ? -1 : 1;
    tp.lHip[0] = tp.lHip[0] * 0.25 - s * 0.7 * a * dir; tp.rHip[0] = tp.rHip[0] * 0.25 + s * 0.7 * a * dir;
    tp.lKn[0] = 0.12 + Math.max(0, c * dir) * 1.1 * a; tp.rKn[0] = 0.12 + Math.max(0, -c * dir) * 1.1 * a;
    tp.hy += -Math.abs(c) * 0.05 * a + 0.02 * a;
    if (!P.drawn && P.state === 'idle') { tp.lSh[0] = s * 0.55 * a; tp.rSh[0] = -s * 0.55 * a; tp.lEl[0] = -0.35; tp.rEl[0] = -0.35; tp.spine[0] += 0.08 * a; }
    if (P.drawn) tp.spine[0] += 0.05 * a;
    const sg = Math.sign(s); if (sg !== P.lastSg) { P.lastSg = sg; SFX.step(false); if (spd > 5) dust(P.pos, 1, 0.2, 0.5); }
  }
  // breathing
  tp = blend(tp, tp, 0); tp.spine[0] += Math.sin(time * 2.1) * 0.015;
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
  if (P.state !== 'dead') { hero.root.position.y = groundH(P.pos.x, P.pos.z); hero.root.rotation.x = 0; hero.root.rotation.z = 0; }
  hero.root.rotation.y = P.yaw;
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
    setTimeout(() => showMsg('VICTORY', 'the crowd roars — catch your breath', 3), 600);
  }
}
function onPlayerDeath() {
  game.state = 'dead'; game.deadT = 0;
  SFX.thud();
  setTimeout(() => {
    showOverlay(`<h1>YOU HAVE FALLEN</h1><div class="tag">REACHED ROUND ${toRoman(game.round)}</div>
      <p>Watch the eyes: they flare before every strike. Parry the pecks, step back from the charge, then punish the recovery.</p>
      <button id="startBtn">FIGHT AGAIN</button>`);
  }, 2200);
}
function resetGame() {
  Object.assign(P, { hp: P.maxHp, st: P.maxSt, state: 'idle', t: 0, combo: 0, ghostHp: P.maxHp, iframes: 0, pain: 0 });
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
  $('overlay').classList.add('hidden');
  resetGame();
  renderer.domElement.requestPointerLock?.();
}
$('startBtn').onclick = begin;

// ============================================================ pause menu
const settings = { sens: 1, sound: 0.6 };
try { Object.assign(settings, JSON.parse(localStorage.getItem('arena-settings') || '{}')); } catch (e) { /* storage unavailable */ }
const saveSettings = () => { try { localStorage.setItem('arena-settings', JSON.stringify({ ...settings, music: Music.volume, lockOn })); } catch (e) { /* ignore */ } };
try { const st = JSON.parse(localStorage.getItem('arena-settings') || '{}'); if (typeof st.lockOn === 'boolean') lockOn = st.lockOn; if (typeof st.music === 'number') Music.setVolume(st.music); } catch (e) { /* ignore */ }
let paused = false, resumeGuard = 0;
const canPause = () => (game.state === 'play' || game.state === 'between') && $('overlay').classList.contains('hidden');
function pauseGame() {
  if (paused || !canPause()) return;
  paused = true;
  for (const k in keys) keys[k] = false; mouseR = false;
  $('optMusic').value = Music.volume; $('optSound').value = settings.sound; $('optSens').value = settings.sens; $('optLock').checked = lockOn;
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
  renderer.domElement.requestPointerLock?.()?.catch?.(() => {});
}
$('resumeBtn').onclick = resumeGame;
$('restartBtn').onclick = () => { resumeGame(); resetGame(); };
$('optMusic').oninput = e => { Music.setVolume(+e.target.value); saveSettings(); };
$('optSound').oninput = e => { settings.sound = +e.target.value; if (master) master.gain.value = settings.sound; saveSettings(); };
$('optSens').oninput = e => { settings.sens = +e.target.value; saveSettings(); };
$('optLock').onchange = e => { lockOn = e.target.checked; saveSettings(); };
// losing pointer lock (the browser eats the first Esc press) or the window losing focus pauses the game
document.addEventListener('pointerlockchange', () => {
  if (!document.pointerLockElement && performance.now() - resumeGuard > 300) pauseGame();
});
addEventListener('blur', () => pauseGame());
document.addEventListener('visibilitychange', () => { if (document.hidden) pauseGame(); });

// ============================================================ input
const keys = {}; const pressed = new Set(); let mouseR = false;
addEventListener('keydown', e => {
  if (['Tab', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
  if (!keys[e.code]) pressed.add(e.code);
  keys[e.code] = true;
  if (e.code === 'Escape') { if (paused) resumeGame(); else pauseGame(); return; }
  if (paused) return;
  if (e.code === 'Tab') lockOn = !lockOn;
  if (e.code === 'KeyH') $('help').style.display = $('help').style.display === 'none' ? '' : 'none';
  if (e.code === 'KeyM' && master) master.gain.value = master.gain.value > 0 ? 0 : settings.sound;
  if (e.code === 'KeyN') Music.toggle();
});
addEventListener('keyup', e => { keys[e.code] = false; });
addEventListener('blur', () => { for (const k in keys) keys[k] = false; mouseR = false; });
renderer.domElement.addEventListener('mousedown', e => {
  if (game.state === 'title' || paused) return;
  if (document.pointerLockElement !== renderer.domElement) renderer.domElement.requestPointerLock?.();
  if (e.button === 0) pressed.add('Attack');
  if (e.button === 2) mouseR = true;
  if (e.button === 1) { lockOn = !lockOn; e.preventDefault(); }
});
addEventListener('mouseup', e => { if (e.button === 2) mouseR = false; });
addEventListener('contextmenu', e => e.preventDefault());
let camYaw = Math.PI, camPitch = 0.3, camDist = 4.8;
addEventListener('mousemove', e => {
  if (document.pointerLockElement !== renderer.domElement) return;
  if (!currentTarget() && P.state !== 'dead' && P.state !== 'attack') P.yaw -= e.movementX * 0.0024 * settings.sens;
  camPitch = clamp(camPitch + e.movementY * 0.0018 * settings.sens, -0.75, 0.85);
});
addEventListener('wheel', e => { camDist = clamp(camDist + Math.sign(e.deltaY) * 0.4, 2.8, 9); }, { passive: true });

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
  camYaw = dampAng(camYaw, P.yaw, target ? 7 : 5, dt);
  const hor = camDist * Math.cos(camPitch), h = 1.55 + camDist * Math.sin(camPitch);
  const cp = new V3(P.pos.x - Math.sin(camYaw) * hor, h, P.pos.z - Math.cos(camYaw) * hor);
  const rl = Math.hypot(cp.x, cp.z);
  if (rl > 18.0) { cp.x *= 18.0 / rl; cp.z *= 18.0 / rl; }
  cp.y = Math.max(cp.y, groundH(cp.x, cp.z) + 0.4); // below level the camera hugs the ground and tilts its gaze up instead
  const gazeUp = clamp((0.12 - camPitch) * 1.9, 0, 1.38);
  const look = new V3(P.pos.x, 1.45, P.pos.z).addScaledVector(new V3(Math.sin(camYaw), 0, Math.cos(camYaw)), 1.2);
  if (target) look.lerp(new V3(target.pos.x, 1.2, target.pos.z), 0.22 * (1 - gazeUp / 1.38));
  look.y += Math.tan(gazeUp) * (hor + 1.2);
  camLook.lerp(look, 1 - Math.exp(-10 * dt));
  camera.position.lerp(cp, 1 - Math.exp(-14 * dt));
  if (shake > 0) { camera.position.add(new V3(rand(-1, 1), rand(-1, 1), rand(-1, 1)).multiplyScalar(shake * 0.12)); shake = Math.max(0, shake - dt * 2.2); }
  camera.lookAt(camLook);
}
function updateHUD(dt) {
  P.ghostHp = damp(P.ghostHp, P.hp, 3, dt);
  $('php').querySelector('.fill').style.transform = `scaleX(${P.hp / P.maxHp})`;
  $('php').querySelector('.ghost').style.transform = `scaleX(${P.ghostHp / P.maxHp})`;
  $('pst').querySelector('.fill').style.transform = `scaleX(${Math.max(0, P.st) / P.maxSt})`;
  $('stance').textContent = P.drawn ? (P.state === 'block' ? 'GUARD' : (currentTarget() ? 'LOCKED · ' : '') + 'SWORD DRAWN') : 'UNARMED — PRESS F';
  const tgt = currentTarget() || beasts.find(e => !e.dead && e.state !== 'wait');
  const eb = $('ebox');
  if (tgt && game.state !== 'title') {
    eb.style.opacity = 1;
    tgt.ghostHp = damp(tgt.ghostHp, tgt.hp, 3, dt);
    $('ebar').querySelector('.fill').style.transform = `scaleX(${Math.max(0, tgt.hp) / tgt.maxHp})`;
    $('ebar').querySelector('.ghost').style.transform = `scaleX(${Math.max(0, tgt.ghostHp) / tgt.maxHp})`;
    $('ename').textContent = tgt.name;
  } else eb.style.opacity = 0;
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
function loop(now) {
  requestAnimationFrame(loop);
  const rdt = Math.min(0.05, (now - last) / 1000); last = now;
  let dt = rdt;
  if (paused) { renderer.render(scene, camera); pressed.clear(); return; }
  if (hitStop > 0) { hitStop -= rdt; dt *= 0.06; }
  else if (slowMo > 0) { slowMo -= rdt; dt *= 0.35; }
  time += dt;

  if (game.state !== 'title') {
    updatePlayer(dt);
    for (const e of beasts) e.update(dt);
    separate();
    if (game.state === 'between') {
      game.betweenT -= rdt;
      if (game.betweenT <= 0) { P.hp = Math.min(P.maxHp, P.hp + P.maxHp * 0.45); startRound(game.round + 1); }
    }
  } else {
    applyHero(POSE.relaxed, 6, dt);
    hero.root.position.set(0, 0, 7); hero.root.rotation.y = Math.PI;
  }
  updateTorches(dt, time);
  barrier.update(dt, time); sky.material.uniforms.time.value = time;
  clockEl.crackle -= rdt;
  if (clockEl.crackle <= 0 && AC) { clockEl.crackle = rand(0.05, 0.35); SFX.crackle?.(); }
  updateBanners();
  crowdExcite = Math.max(0, crowdExcite - rdt * 0.35);
  crowd.update(time);
  const fighting = game.state === 'play' && beasts.some(e => !e.dead && e.state !== 'wait');
  Music.setIntensity(fighting ? 1 : game.state === 'play' || game.state === 'between' ? 0.45 : 0.2);
  fxAdd.update(dt); fxNorm.update(dt); trail.update(dt);
  updateCamera(rdt);
  sky.position.copy(camera.position);
  updateHUD(rdt); updatePops(rdt);
  renderer.render(scene, camera);
  pressed.clear();
}
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
  await step('RAISING THE TOWN…', 15, () => buildTown());
  await step('CARVING THE THORNBEAK…', 25, async () => {
    try {
      const h = (await new GLTFLoader().loadAsync('models/hero.glb')).scene;
      scene.remove(hero.root); Object.assign(hero, buildHeroGLB(h)); scene.add(hero.root);
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
    if (renderer.compileAsync) await renderer.compileAsync(scene, camera); else renderer.compile(scene, camera);
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
}
preload();
