// Medieval Arena — an original third-person arena duel.
// All geometry, textures and sounds are generated procedurally at runtime.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

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
renderer.toneMappingExposure = 0.95;
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0xb2c3d3, 0.0052);
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
const sky = new THREE.Mesh(new THREE.SphereGeometry(300, 32, 16), new THREE.ShaderMaterial({
  side: THREE.BackSide, depthWrite: false, fog: false,
  uniforms: { sunDir: { value: SUN_DIR } },
  vertexShader: `varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `varying vec3 vD; uniform vec3 sunDir;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
    float noise(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.0-2.0*f);
      return mix(mix(hash(i), hash(i+vec2(1,0)), u.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), u.x), u.y); }
    float fbm(vec2 p){ float v = 0.0, a = 0.5; for (int i = 0; i < 5; i++){ v += a*noise(p); p *= 2.03; a *= 0.5; } return v; }
    void main(){
      vec3 d = normalize(vD); float h = d.y;
      vec3 zen = vec3(0.17,0.36,0.70), hor = vec3(0.70,0.80,0.90);
      vec3 c = mix(hor, zen, pow(smoothstep(0.0, 0.9, h), 0.6));
      c = mix(c, vec3(0.45,0.5,0.45), smoothstep(0.0, -0.12, h));
      float s = max(dot(d, sunDir), 0.0);
      c += vec3(1.0,0.96,0.88) * pow(s, 900.0) * 8.0 + vec3(1.0,0.92,0.75) * pow(s, 8.0) * 0.22;
      if (h > 0.0) {
        vec2 uv = d.xz / (h + 0.1) * 1.4;
        float cl = smoothstep(0.52, 0.85, fbm(uv)) * smoothstep(0.0, 0.2, h);
        vec3 cc = mix(vec3(0.97,0.97,0.99), vec3(0.66,0.71,0.79), smoothstep(0.62, 1.0, fbm(uv * 1.7 + 3.0)));
        c = mix(c, cc, cl * 0.9);
      }
      gl_FragColor = vec4(c, 1.0);
    }`
}));
scene.add(sky);
// bake the sky into an environment map so every glossy surface picks up cold sky reflections
{
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene(); envScene.add(new THREE.Mesh(sky.geometry, sky.material));
  scene.environment = pmrem.fromScene(envScene, 0, 0.1, 1000).texture;
}

scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x6a5a40, 0.55));
const sun = new THREE.DirectionalLight(0xfff0d8, 3.1);
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
const sandTex = canvasTex(512, (g, s) => {
  g.fillStyle = '#8c6c48'; g.fillRect(0, 0, s, s);
  for (let i = 0; i < 60; i++) {
    const x = Math.random() * s, y = Math.random() * s, r = rand(20, 90);
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    const dark = Math.random() < 0.5;
    gr.addColorStop(0, dark ? 'rgba(60,40,22,.22)' : 'rgba(180,150,110,.18)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  for (let i = 0; i < 14000; i++) {
    const v = Math.random();
    g.fillStyle = v < 0.5 ? `rgba(50,32,18,${rand(.1, .4)})` : `rgba(200,170,130,${rand(.1, .35)})`;
    g.fillRect(Math.random() * s, Math.random() * s, rand(1, 2.5), rand(1, 2.5));
  }
}, 36);
const arenaFloor = mesh(new THREE.CircleGeometry(19.4, 72), std(0xffffff, 1), scene, [0, 0.004, 0], [-Math.PI / 2, 0, 0]);
arenaFloor.material.map = sandTex; arenaFloor.castShadow = false;
const grassTex = canvasTex(512, (g, s) => {
  g.fillStyle = '#5d6e38'; g.fillRect(0, 0, s, s);
  for (let i = 0; i < 70; i++) {
    const x = Math.random() * s, y = Math.random() * s, r = rand(20, 80);
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, Math.random() < 0.4 ? 'rgba(120,98,62,.45)' : 'rgba(110,140,60,.3)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  for (let i = 0; i < 16000; i++) {
    g.fillStyle = Math.random() < 0.5 ? `rgba(40,60,20,${rand(.2, .5)})` : `rgba(150,170,90,${rand(.15, .4)})`;
    g.fillRect(Math.random() * s, Math.random() * s, 1, rand(1, 4));
  }
}, 70);
const ground = mesh(new THREE.CircleGeometry(260, 72), std(0xffffff, 1), scene, [0, 0, 0], [-Math.PI / 2, 0, 0]);
ground.material.map = grassTex; ground.castShadow = false;

const woodTex = canvasTex(256, (g, s) => {
  g.fillStyle = '#5c4029'; g.fillRect(0, 0, s, s);
  for (let i = 0; i < 380; i++) {
    const x = Math.random() * s;
    g.strokeStyle = Math.random() < 0.6 ? `rgba(25,14,6,${rand(.08, .3)})` : `rgba(150,110,75,${rand(.05, .2)})`;
    g.lineWidth = rand(0.5, 3);
    g.beginPath(); g.moveTo(x, 0); g.bezierCurveTo(x + rand(-6, 6), s * 0.33, x + rand(-6, 6), s * 0.66, x + rand(-4, 4), s); g.stroke();
  }
  for (let i = 0; i < 8; i++) {
    const x = Math.random() * s, y = Math.random() * s;
    g.fillStyle = 'rgba(30,18,8,.5)'; g.beginPath(); g.ellipse(x, y, rand(3, 6), rand(6, 12), 0, 0, 7); g.fill();
  }
});
const logMat = std(0xffffff, 0.92); logMat.map = woodTex;
const darkWood = std(0x6b4a30, 0.9); darkWood.map = woodTex;

(function buildWall() {
  const R = 18.6, N = 124, GATE = 0.13;
  const pts = [];
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    if (Math.abs(angWrap(a - Math.PI)) < GATE) continue;
    pts.push({ a, h: rand(4.2, 5.2) });
  }
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

  // gate
  for (const s of [-1, 1]) {
    const a = Math.PI + s * (GATE + 0.02);
    mesh(new THREE.CylinderGeometry(0.42, 0.46, 7, 10), logMat, scene, [Math.sin(a) * R, 3.5, Math.cos(a) * R]);
    mesh(cone(0.42, 0.9, 10), logMat, scene, [Math.sin(a) * R, 7.45, Math.cos(a) * R]);
  }
  mesh(new THREE.BoxGeometry(5.6, 0.45, 0.5), darkWood, scene, [0, 6.2, -R]);
  for (let i = -5; i <= 5; i++) mesh(new THREE.BoxGeometry(0.12, 1.6, 0.12), darkWood, scene, [i * 0.42, 5.3, -R - 0.1]);
  mesh(new THREE.BoxGeometry(4.6, 0.12, 0.12), darkWood, scene, [0, 4.55, -R - 0.1]);
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
  const stoneTex = canvasTex(256, (g, s) => {
    g.fillStyle = '#5e5b55'; g.fillRect(0, 0, s, s);
    const rows = 8, h = s / rows;
    for (let r = 0; r < rows; r++) {
      let x = (r % 2) * -18;
      while (x < s) { const w = rand(26, 46), v = rand(110, 160) | 0; g.fillStyle = `rgb(${v},${v - 2},${v - 8})`; g.fillRect(x + 2, r * h + 2, w - 3, h - 3); x += w; }
    }
    for (let i = 0; i < 3000; i++) { g.fillStyle = `rgba(${Math.random() < .5 ? '0,0,0' : '255,255,255'},${rand(.03, .1)})`; g.fillRect(rand(0, s), rand(0, s), 2, 2); }
  });
  const plasterTex = canvasTex(256, (g, s) => {
    g.fillStyle = '#ddd2ba'; g.fillRect(0, 0, s, s);
    for (let i = 0; i < 30; i++) { g.fillStyle = `rgba(120,100,70,${rand(.03, .08)})`; g.beginPath(); g.arc(rand(0, s), rand(0, s), rand(10, 40), 0, 7); g.fill(); }
    g.fillStyle = '#3a291b'; g.strokeStyle = '#3a291b';
    g.fillRect(0, 0, s, 12); g.fillRect(0, s - 12, s, 12);
    for (const x of [0, s / 3, (2 * s) / 3, s]) g.fillRect(x - 7, 0, 14, s);
    g.lineWidth = 11; g.beginPath(); g.moveTo(s / 3, s - 12); g.lineTo(2 * s / 3, 12); g.moveTo(s / 3, 12); g.lineTo(2 * s / 3, s - 12); g.stroke();
    for (const cx of [s / 6, (5 * s) / 6]) {
      const ww = (s / 3) * 0.45, wh = s * 0.38, wy = s * 0.45;
      g.fillStyle = '#3a291b'; g.fillRect(cx - ww / 2 - 6, wy - wh / 2 - 6, ww + 12, wh + 12);
      g.fillStyle = '#26303a'; g.fillRect(cx - ww / 2, wy - wh / 2, ww, wh);
    }
  });
  const tileTex = (base, line) => canvasTex(256, (g, s) => {
    g.fillStyle = base; g.fillRect(0, 0, s, s);
    for (let r = 0; r < 12; r++) {
      const y = r * (s / 12);
      for (let x = (r % 2) * 10; x < s; x += 21) {
        const gr = g.createLinearGradient(0, y, 0, y + s / 12);
        gr.addColorStop(0, 'rgba(255,255,255,.12)'); gr.addColorStop(1, line);
        g.fillStyle = gr; g.fillRect(x, y, 19, s / 12 - 2);
      }
    }
  });
  const stoneM = std(0xffffff, 0.82); stoneM.map = stoneTex; stoneM.userData.world = 3.5;
  const plasterM = std(0xffffff, 0.9); plasterM.map = plasterTex;
  const gableM = std(0xd8ccb2, 0.9, 0, { side: THREE.DoubleSide });
  const roofM = phys(0xffffff, 0.55, 0, { map: tileTex('#8a4a32', 'rgba(40,10,5,.55)'), side: THREE.DoubleSide, clearcoat: 0.3, clearcoatRoughness: 0.4 }); roofM.userData.world = 2.6;
  const slateM = phys(0xffffff, 0.3, 0.15, { map: tileTex('#4b5866', 'rgba(10,15,25,.6)'), side: THREE.DoubleSide, clearcoat: 0.8, clearcoatRoughness: 0.15 }); slateM.userData.world = 2.6;
  const glassM = phys(0x1b2733, 0.04, 0.2, { clearcoat: 1, clearcoatRoughness: 0.02 });
  const doorM = std(0x3d2716, 0.8);
  const beamM = std(0x3a291b, 0.85);
  const clothM = std(0x8a2219, 0.9, 0, { side: THREE.DoubleSide });
  const hillM = std(0x5a7038, 1);
  const pineM = std(0x2f4a2a, 0.9), trunkM = std(0x4a3322, 0.9);
  const mountM = std(0x6a7a8a, 1), snowM = phys(0xf2f6ff, 0.35, 0, { clearcoat: 0.6 });
  const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);

  function gableGeo(w, d, h) {
    const P = [], U = [], I = [];
    const quad = (a, b, c, e) => { const i = P.length / 3; P.push(...a, ...b, ...c, ...e); U.push(0, 0, 1, 0, 1, 1, 0, 1); I.push(i, i + 1, i + 2, i, i + 2, i + 3); };
    const x = w / 2, z = d / 2;
    quad([-x, 0, z], [x, 0, z], [x, h, 0], [-x, h, 0]);
    quad([x, 0, -z], [-x, 0, -z], [-x, h, 0], [x, h, 0]);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
    g.setIndex(I); g.computeVertexNormals(); return g;
  }
  function gableEndGeo(w, d, h) {
    const x = w / 2, z = d / 2;
    const P = [-x, 0, -z, -x, 0, z, -x, h, 0, x, 0, z, x, 0, -z, x, h, 0];
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, .5, 1, 0, 0, 1, 0, .5, 1], 2));
    g.computeVertexNormals(); return g;
  }
  const crenels = (parent, len, y, z, step = 2.2) => { for (let x = -len / 2 + 0.6; x < len / 2; x += step) mesh(box(1.1, 1.3, 0.9), stoneM, parent, [x, y + 0.65, z]); };
  function roundTower(parent, x, z, r, h, roofH, base = 0) {
    mesh(new THREE.CylinderGeometry(r, r * 1.08, h, 20), stoneM, parent, [x, base + h / 2, z]);
    mesh(new THREE.CylinderGeometry(r * 1.15, r, 1, 20), stoneM, parent, [x, base + h + 0.5, z]);
    for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2; mesh(box(0.9, 1.2, 0.7), stoneM, parent, [x + Math.sin(a) * r * 1.08, base + h + 1.6, z + Math.cos(a) * r * 1.08], [0, a, 0]); }
    mesh(cone(r * 1.25, roofH, 20), slateM, parent, [x, base + h + 1 + roofH / 2, z]);
    for (let i = 0; i < 3; i++) { const a = rand(0, 6.28); mesh(box(0.35, 1.1, 0.2), glassM, parent, [x + Math.sin(a) * r * 1.02, base + h * rand(0.45, 0.85), z + Math.cos(a) * r * 1.02], [0, a, 0]); }
  }
  function banner(parent, x, y, z, rot) {
    mesh(new THREE.CylinderGeometry(0.08, 0.08, 4, 6), beamM, parent, [x, y + 2, z]);
    mesh(new THREE.PlaneGeometry(1.6, 1.0), clothM, parent, [x + Math.cos(rot) * 0.85, y + 3.4, z - Math.sin(rot) * 0.85], [0, rot, 0]);
  }

  function house(x, z, rot) {
    const g = new THREE.Group(); g.position.set(x, 0, z); g.rotation.y = rot; tmp.add(g);
    const w = rand(5, 7.5), d = rand(5, 6.5), storeys = Math.random() < 0.5 ? 2 : 3, gh = 3.2;
    mesh(box(w, gh, d), stoneM, g, [0, gh / 2, 0]);
    mesh(box(1.2, 2.2, 0.12), doorM, g, [rand(-w / 4, w / 4), 1.1, d / 2 + 0.05]);
    for (const sx of [-1, 1]) mesh(box(0.7, 0.9, 0.08), glassM, g, [sx * w * 0.33, 1.9, d / 2 + 0.04]);
    let y = gh, jet = 0, fw = w, fd = d;
    for (let i = 1; i < storeys; i++) {
      jet += 0.3; fw = w + jet * 0.6; fd = d + jet;
      mesh(box(fw + 0.1, 0.22, fd + 0.1), beamM, g, [0, y + 0.11, jet / 2]);
      mesh(box(fw, 2.8, fd), plasterM, g, [0, y + 0.22 + 1.4, jet / 2]);
      for (const sx of [-1, 1]) mesh(box(fw / 3 * 0.45, 1.06, 0.06), glassM, g, [sx * fw / 3, y + 0.22 + 1.54, jet / 2 + fd / 2 + 0.02]);
      y += 3.02;
    }
    const rh = fd * rand(0.6, 0.85);
    const roof = new THREE.Mesh(gableGeo(fw + 0.7, fd + 0.9, rh), roofM); roof.position.set(0, y, jet / 2); g.add(roof);
    const ends = new THREE.Mesh(gableEndGeo(fw, fd, rh * 0.94), gableM); ends.position.set(0, y, jet / 2); g.add(ends);
    if (Math.random() < 0.8) mesh(box(0.7, rh + 1.4, 0.7), stoneM, g, [fw * rand(-0.35, 0.35), y + (rh + 1.4) / 2, -fd * 0.2]);
  }

  // houses in rings around the arena, leaving a road open towards the castle
  for (const [r, n, jitter] of [[27, 24, 1.5], [37, 30, 2], [48, 36, 2.5]]) {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rand(-0.04, 0.04);
      if (Math.abs(angWrap(a - Math.PI)) < 6 / r) continue;
      if (r === 37 && Math.abs(angWrap(a - 1.05)) < 0.18) continue; // bell tower plot
      const rr = r + rand(-jitter, jitter);
      house(Math.sin(a) * rr, Math.cos(a) * rr, a + Math.PI + rand(-0.12, 0.12));
    }
  }
  // bell tower
  {
    const a = 1.05, r = 37, g = new THREE.Group(); g.position.set(Math.sin(a) * r, 0, Math.cos(a) * r); g.rotation.y = a; tmp.add(g);
    mesh(box(6, 22, 6), stoneM, g, [0, 11, 0]);
    for (const [sx, sz, ry] of [[0, 3.02, 0], [0, -3.02, 0], [3.02, 0, Math.PI / 2], [-3.02, 0, Math.PI / 2]]) mesh(box(1.4, 3, 0.1), glassM, g, [sx, 18, sz], [0, ry, 0]);
    mesh(box(7, 0.8, 7), stoneM, g, [0, 22.4, 0]);
    mesh(cone(5.2, 12, 4), slateM, g, [0, 28.8, 0], [0, Math.PI / 4, 0]);
    mesh(box(10, 9, 7), stoneM, g, [0, 4.5, -6.5]);
    const roof = new THREE.Mesh(gableGeo(7.6, 11, 5), slateM); roof.position.set(0, 9, -6.5); roof.rotation.y = Math.PI / 2; g.add(roof);
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
      mesh(box(len, 9, 2.4), stoneM, g, [0, 4.5, 0]);
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
    const road = mesh(new THREE.PlaneGeometry(6, 80), std(0x7c6448, 1), scene, [0, 0.02, -58], [-Math.PI / 2, 0, 0]);
    road.castShadow = false;
  }
  // forest and mountains beyond the walls
  for (let i = 0; i < 140; i++) {
    const a = rand(0, Math.PI * 2), r = rand(70, 150);
    const x = Math.sin(a) * r, z = Math.cos(a) * r;
    if (Math.hypot(x, z + 112) < 62) continue;
    const s = rand(0.8, 1.5);
    mesh(new THREE.CylinderGeometry(0.3 * s, 0.4 * s, 3 * s, 6), trunkM, tmp, [x, 1.5 * s, z]);
    for (let k = 0; k < 3; k++) mesh(cone((3 - k * 0.7) * s, 4 * s, 8), pineM, tmp, [x, (3 + k * 2.4) * s, z]);
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
buildTown();

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
  const tunic = [0x6b2a20, 0x2d4a6b, 0x5a5a2a, 0x7a6a50, 0x3a5a3a, 0x8a7a60, 0x4a3a5a, 0x8a3a1a];
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
    g.fillStyle = '#6e4d2f'; g.fillRect(0, 0, s, s);
    g.strokeStyle = '#2d1c0e'; g.lineWidth = 8; g.strokeRect(4, 4, s - 8, s - 8);
    g.beginPath(); g.moveTo(8, 8); g.lineTo(s - 8, s - 8); g.stroke();
    for (let i = 0; i < 60; i++) { g.fillStyle = `rgba(0,0,0,${rand(.05, .15)})`; g.fillRect(rand(0, s), rand(0, s), rand(10, 40), 2); }
  });
  const crateMat = std(0xffffff, 0.9); crateMat.map = crateTex;
  const spots = [[0.75, 1], [0.82, 0.8], [2.3, 1.1], [-0.9, 0.9], [-2.2, 1], [-2.3, 0.75], [1.6, 0.85]];
  for (const [a, s] of spots) {
    const r = 16.9;
    mesh(new THREE.BoxGeometry(s, s, s), crateMat, scene, [Math.sin(a) * r, s / 2, Math.cos(a) * r], [0, rand(0, 3), 0]);
  }
  const barrelMat = std(0x5a3a22, 0.8);
  for (const a of [0.55, -1.4, 2.0, -2.75]) {
    const r = 17.0;
    const b = mesh(new THREE.CylinderGeometry(0.42, 0.42, 1.1, 14), barrelMat, scene, [Math.sin(a) * r, 0.55, Math.cos(a) * r]);
    mesh(new THREE.TorusGeometry(0.43, 0.03, 6, 18), std(0x2a2522, 0.5, 0.8), b, [0, 0.35, 0], [Math.PI / 2, 0, 0]);
    mesh(new THREE.TorusGeometry(0.43, 0.03, 6, 18), std(0x2a2522, 0.5, 0.8), b, [0, -0.35, 0], [Math.PI / 2, 0, 0]);
  }
  // bleached bones in the sand
  const boneMat = std(0xd8ccb0, 0.7);
  for (let i = 0; i < 18; i++) {
    const a = rand(0, 6.28), r = rand(4, 16);
    mesh(new THREE.CylinderGeometry(0.04, 0.05, rand(0.4, 0.9), 6), boneMat, scene, [Math.sin(a) * r, 0.04, Math.cos(a) * r], [Math.PI / 2, 0, rand(0, 3)]);
  }
  // banners
  const clothMat = std(0x7a1f18, 0.95, 0, { side: THREE.DoubleSide });
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
      if (this.pos[i3 + 1] < 0.03) {
        this.pos[i3 + 1] = 0.03;
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
  m.position.set(x, 0.011 + Math.random() * 0.004, z);
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
  const postMat = std(0x3a2616, 0.9), ironMat = std(0x2b2824, 0.5, 0.8);
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
  Music.init(AC, master);
}

// ============================================================ orchestral score
// An original battle theme in D minor, written as MIDI note numbers and played by a small
// Web Audio "orchestra": string section, horns/trumpets, low-string ostinato, timpani, snare, cymbals.
const Music = (() => {
  let ctx, out, layers = {}, nextT = 0, step = 0, on = true, intensity = -1;
  const BPM = 104, S16 = 60 / BPM / 4, LOOP = 256;
  const mtof = n => 440 * Math.pow(2, (n - 69) / 12);
  const CH = { Dm: [50, 57, 62, 65], Bb: [46, 58, 62, 65], C: [48, 55, 64, 67], Am: [45, 57, 60, 64], Gm: [43, 55, 62, 67], A: [45, 57, 61, 64], F: [41, 57, 60, 65] };
  const PROG = [['Dm', 'Bb', 'C', 'Am', 'Dm', 'Gm', 'A', 'A'], ['F', 'C', 'Dm', 'Bb', 'Gm', 'Dm', 'A', 'A']];
  // [beat, beats, midi] per bar
  const MEL = [[
    [[0, 1.5, 62], [1.5, 0.5, 65], [2, 2, 69]],
    [[0, 1, 70], [1, 1, 69], [2, 1, 67], [3, 1, 65]],
    [[0, 1.5, 67], [1.5, 0.5, 64], [2, 2, 72]],
    [[0, 3, 69], [3, 1, 67]],
    [[0, 1.5, 65], [1.5, 0.5, 67], [2, 1, 69], [3, 1, 74]],
    [[0, 2, 74], [2, 1, 72], [3, 1, 70]],
    [[0, 1, 69], [1, 1, 73], [2, 2, 76]],
    [[0, 4, 69]],
  ], [
    [[0, 2, 72], [2, 1, 69], [3, 1, 72]],
    [[0, 2, 76], [2, 2, 72]],
    [[0, 1.5, 74], [1.5, 0.5, 72], [2, 1, 69], [3, 1, 65]],
    [[0, 3, 70], [3, 1, 74]],
    [[0, 1.5, 74], [1.5, 0.5, 72], [2, 2, 70]],
    [[0, 1, 69], [1, 1, 65], [2, 2, 62]],
    [[0, 1.5, 64], [1.5, 0.5, 67], [2, 2, 73]],
    [[0, 2, 76], [2, 2, 69]],
  ]];
  const OST = [0, 0, 12, 0, 0, 7, 12, 0];
  function impulse() {
    const len = ctx.sampleRate * 3.2, b = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.8); }
    return b;
  }
  function init(c, dest) {
    if (ctx) return;
    ctx = c; out = ctx.createGain(); out.gain.value = 0.5; out.connect(dest);
    const rev = ctx.createConvolver(); rev.buffer = impulse();
    const wet = ctx.createGain(); wet.gain.value = 0.5; rev.connect(wet).connect(out);
    for (const [k, send] of [['strings', 0.7], ['low', 0.3], ['brass', 0.5], ['melody', 0.55], ['perc', 0.4]]) {
      const g = ctx.createGain(); g.gain.value = 0; g.connect(out);
      const s = ctx.createGain(); s.gain.value = send; g.connect(s).connect(rev);
      layers[k] = g;
    }
    nextT = ctx.currentTime + 0.15;
    setInterval(tick, 40);
  }
  function voice(layer, { type = 'sawtooth', n, t, dur, vel = 0.1, a = 0.05, r = 0.3, cut = 2000, cutEnv = 0, detune = [0], vib = 0, q = 0.7 }) {
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.Q.value = q;
    if (cutEnv) { f.frequency.setValueAtTime(cut * 0.3, t); f.frequency.linearRampToValueAtTime(cut, t + cutEnv); } else f.frequency.setValueAtTime(cut, t);
    const g = ctx.createGain(), hold = Math.max(a, dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(vel, t + a);
    g.gain.setValueAtTime(vel, t + hold); g.gain.exponentialRampToValueAtTime(0.0001, t + hold + r);
    f.connect(g).connect(layers[layer]);
    let lg = null;
    if (vib) { const l = ctx.createOscillator(); l.frequency.value = 5.3; lg = ctx.createGain(); lg.gain.value = vib; l.connect(lg); l.start(t); l.stop(t + hold + r + 0.1); }
    for (const d of detune) {
      const o = ctx.createOscillator(); o.type = type; o.frequency.value = mtof(n); o.detune.value = d;
      if (lg) lg.connect(o.detune);
      o.connect(f); o.start(t); o.stop(t + hold + r + 0.1);
    }
  }
  function timpani(n, t, vel) {
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(mtof(n) * 1.06, t); o.frequency.exponentialRampToValueAtTime(mtof(n), t + 0.08);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vel, t + 0.005); g.gain.exponentialRampToValueAtTime(0.0001, t + 1.3);
    o.connect(g).connect(layers.perc); o.start(t); o.stop(t + 1.4);
    const s = ctx.createBufferSource(); s.buffer = noiseBuf; const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 500;
    const ng = ctx.createGain(); ng.gain.setValueAtTime(vel * 0.5, t); ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
    s.connect(f).connect(ng).connect(layers.perc); s.start(t, Math.random()); s.stop(t + 0.2);
  }
  function hitNoise(t, { type, f0, q = 0.8, vel, dur }) {
    const s = ctx.createBufferSource(); s.buffer = noiseBuf; const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = f0; f.Q.value = q;
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vel, t + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f).connect(g).connect(layers.perc); s.start(t, Math.random()); s.stop(t + dur + 0.05);
  }
  const snare = (t, vel) => { hitNoise(t, { type: 'bandpass', f0: 1900, vel, dur: 0.14 }); voice('perc', { type: 'triangle', n: 54, t, dur: 0.02, vel: vel * 0.5, a: 0.003, r: 0.06, cut: 3000 }); };
  const cymbal = (t, vel) => hitNoise(t, { type: 'highpass', f0: 6500, vel, dur: 2.2 });
  function schedule(s, t) {
    const bar = Math.floor(s / 16), sec = bar < 8 ? 0 : 1, bi = bar % 8, p = s % 16;
    const ch = CH[PROG[sec][bi]], bar4 = 16 * S16;
    if (p === 0) {
      for (const n of ch.slice(1)) voice('strings', { n: n + 12, t, dur: bar4, vel: 0.035, a: 0.35, r: 0.8, cut: 2600, detune: [-9, 0, 9], vib: 9 });
      for (const n of [ch[0], ch[0] - 12]) voice('strings', { n, t, dur: bar4, vel: 0.045, a: 0.25, r: 0.7, cut: 900, detune: [-6, 6] });
      if (bi === 0) cymbal(t, 0.12);
      if (sec === 1 || bi % 4 === 0) for (const n of ch.slice(1)) voice('brass', { n, t, dur: sec ? 8 * S16 : bar4, vel: sec ? 0.045 : 0.03, a: sec ? 0.03 : 0.2, r: 0.4, cut: sec ? 2600 : 1300, cutEnv: 0.12, detune: [-5, 5] });
    }
    if (sec === 1 && bi >= 6 && p === 8) for (const n of ch.slice(1)) voice('brass', { n, t, dur: 6 * S16, vel: 0.05, a: 0.02, r: 0.4, cut: 2800, cutEnv: 0.1, detune: [-5, 5] });
    if (p % 2 === 0) voice('low', { n: ch[0] + OST[p / 2], t, dur: S16 * 1.1, vel: 0.075, a: 0.006, r: 0.08, cut: 1500, cutEnv: 0.025, detune: [-6, 6] });
    for (const [beat, len, n] of MEL[sec][bi]) {
      if (beat * 4 !== p) continue;
      voice('melody', { n, t, dur: len * 4 * S16 * 0.94, vel: 0.075, a: 0.06, r: 0.3, cut: sec ? 2900 : 1800, cutEnv: 0.09, detune: [-7, 0, 7], vib: 14 });
      voice('melody', { type: 'triangle', n: n - 12, t, dur: len * 4 * S16 * 0.94, vel: 0.05, a: 0.08, r: 0.3, cut: 1200 });
    }
    let tn = ch[0]; while (tn > 45) tn -= 12; while (tn < 36) tn += 12;
    if (bi === 7) timpani(45, t, 0.15 + (p / 16) * 0.35);
    else if (p === 0 || p === 8 || (p === 14 && bi % 2 === 1)) timpani(p === 8 ? tn + 7 > 45 ? tn - 5 : tn + 7 : tn, t, p === 14 ? 0.25 : 0.45);
    if (sec === 1 && (p === 4 || p === 12)) snare(t, 0.22);
    if (sec === 1 && p === 14) snare(t, 0.08);
    if (bi === 7 && p >= 8) snare(t, 0.06 + (p - 8) * 0.03);
  }
  function tick() {
    if (!ctx) return;
    if (nextT < ctx.currentTime - 1) nextT = ctx.currentTime + 0.05; // tab was in the background
    while (nextT < ctx.currentTime + 0.25) { schedule(step, nextT); nextT += S16; step = (step + 1) % LOOP; }
  }
  function setIntensity(x) {
    if (!ctx || Math.abs(x - intensity) < 0.01) return;
    intensity = x;
    const now = ctx.currentTime, lv = { strings: 1, low: x, brass: 0.35 + 0.65 * x, melody: 0.45 + 0.55 * x, perc: x * x };
    for (const k in lv) layers[k].gain.setTargetAtTime(lv[k], now, 1.2);
  }
  function toggle() { if (!ctx) return; on = !on; out.gain.setTargetAtTime(on ? 0.5 : 0, ctx.currentTime, 0.2); return on; }
  return { init, setIntensity, toggle };
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
  hurt() { tn({ dur: 0.24, type: 'sawtooth', f0: 200, f1: 115, gain: 0.25, lp: 650 }); nz({ dur: 0.16, type: 'lowpass', f0: 900, f1: 260, gain: 0.32 }); },
  step(heavy) {
    nz({ dur: heavy ? 0.13 : 0.06, type: 'lowpass', f0: heavy ? 260 : 480, f1: 90, gain: heavy ? 0.32 : 0.09 });
    if (heavy) tn({ dur: 0.12, f0: 75, f1: 40, gain: 0.22 });
  },
  draw() { nz({ dur: 0.45, f0: 2400, f1: 7200, q: 4, gain: 0.17 }); tn({ dur: 0.7, f0: 3100, f1: 3050, gain: 0.035, delay: 0.32 }); },
  sheath() { nz({ dur: 0.35, f0: 6500, f1: 1900, q: 4, gain: 0.15 }); tn({ dur: 0.09, f0: 300, f1: 180, gain: 0.22, delay: 0.33 }); },
  thud() { tn({ dur: 0.45, f0: 85, f1: 28, gain: 0.9 }); nz({ dur: 0.35, type: 'lowpass', f0: 500, f1: 70, gain: 0.55 }); },
  dodge() { nz({ dur: 0.26, type: 'lowpass', f0: 900, f1: 180, gain: 0.25 }); },
  gong() { [98, 196.5, 247, 392.7, 523].forEach((f, i) => tn({ dur: 3.2 - i * 0.4, f0: f, f1: f * 0.995, gain: 0.22 / (i + 1), attack: 0.01 })); nz({ dur: 0.3, type: 'lowpass', f0: 600, f1: 100, gain: 0.3 }); },
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
function buildBeast(scale, pal) {
  const M = {
    // glossy, oily plumage with a cold blue sheen; lacquered beak, thorns and talons
    plume: phys(pal.plume, 0.5, 0, { sheen: 1, sheenColor: 0xb8d0ff, sheenRoughness: 0.3, clearcoat: 0.3, clearcoatRoughness: 0.35 }),
    rust: phys(pal.rust, 0.55, 0, { sheen: 0.8, sheenColor: 0xd4e2ff, sheenRoughness: 0.35, clearcoat: 0.2 }),
    belly: phys(pal.belly, 0.6, 0, { sheen: 0.6, sheenColor: 0xe0e8ff }),
    bone: phys(0xe2d6bc, 0.25, 0, { clearcoat: 1, clearcoatRoughness: 0.08 }),
    scale: phys(0x5e4a33, 0.35, 0.1, { clearcoat: 0.85, clearcoatRoughness: 0.18 }),
    claw: phys(0x1f1710, 0.18, 0.2, { clearcoat: 1, clearcoatRoughness: 0.04 }),
    eye: phys(0x221100, 0.1, 0, { clearcoat: 1, clearcoatRoughness: 0, emissive: 0xffa21a, emissiveIntensity: 2.4 }),
  };
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
    this.s = 1.12 + Math.min(level, 6) * 0.03;
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
    R.root.position.copy(this.pos);
    R.root.rotation.y = this.yaw;
    if (st === 'dead') { R.root.rotation.z = damp(R.root.rotation.z, this.dieRoll, 4, dt); R.root.position.y = damp(R.root.position.y, 0.55 * this.s, 4, dt); }
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
  SFX.hurt(); shake = Math.max(shake, heavy ? 0.6 : 0.35); hitStop = 0.06; vignetteA = 1;
  P.combo = 0;
  if (P.hp <= 0) { P.hp = 0; P.state = 'dead'; P.t = 0; P.vel.copy(dir).multiplyScalar(3); onPlayerDeath(); return true; }
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
      hero.root.position.y = damp(hero.root.position.y, 0.12, 5, dt);
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
  applyHero(tp, k, dt);

  if (P.state !== 'block' && P.state !== 'attack' && P.state !== 'dodge' && P.stDelay <= 0) P.st = Math.min(P.maxSt, P.st + 32 * dt);
  if (P.state === 'block') P.st = Math.min(P.maxSt, P.st + 6 * dt);

  P.pos.addScaledVector(P.vel, dt);
  const l = Math.hypot(P.pos.x, P.pos.z);
  if (l > ARENA_R) { P.pos.x *= ARENA_R / l; P.pos.z *= ARENA_R / l; }
  hero.root.position.x = P.pos.x; hero.root.position.z = P.pos.z;
  if (P.state !== 'dead') { hero.root.position.y = 0; hero.root.rotation.x = 0; }
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
  Object.assign(P, { hp: P.maxHp, st: P.maxSt, state: 'idle', t: 0, combo: 0, ghostHp: P.maxHp, iframes: 0 });
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

// ============================================================ input
const keys = {}; const pressed = new Set(); let mouseR = false;
addEventListener('keydown', e => {
  if (['Tab', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
  if (!keys[e.code]) pressed.add(e.code);
  keys[e.code] = true;
  if (e.code === 'Tab') lockOn = !lockOn;
  if (e.code === 'KeyH') $('help').style.display = $('help').style.display === 'none' ? '' : 'none';
  if (e.code === 'KeyM' && master) master.gain.value = master.gain.value > 0 ? 0 : 0.6;
  if (e.code === 'KeyN') Music.toggle();
});
addEventListener('keyup', e => { keys[e.code] = false; });
addEventListener('blur', () => { for (const k in keys) keys[k] = false; mouseR = false; });
renderer.domElement.addEventListener('mousedown', e => {
  if (game.state === 'title') return;
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
  if (!currentTarget() && P.state !== 'dead' && P.state !== 'attack') P.yaw -= e.movementX * 0.0024;
  camPitch = clamp(camPitch + e.movementY * 0.0018, 0.02, 0.85);
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
  const look = new V3(P.pos.x, 1.45, P.pos.z).addScaledVector(new V3(Math.sin(camYaw), 0, Math.cos(camYaw)), 1.2);
  if (target) look.lerp(new V3(target.pos.x, 1.2, target.pos.z), 0.22);
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
requestAnimationFrame(loop);
