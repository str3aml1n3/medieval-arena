"""Procedurally builds the Thornbeak (an original creature) in Blender and exports it as glTF.

Run:  blender --background --factory-startup --python tools/build_thornbeak.py -- models/thornbeak.glb [preview_dir]

The model is built in the game's coordinate system (Y up, +Z forward) and converted to Blender's
(Z up, -Y forward) on the fly, so the exported glTF lands exactly in game space. Every body part
hangs off a named empty ("joint"); the game animates those joints procedurally, so the hierarchy
and joint offsets below must match the rig expected by game.js.
"""
import bpy, bmesh, math, random, sys, os
from mathutils import Vector

random.seed(11)
argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT = os.path.abspath(argv[0] if argv else 'thornbeak.glb')
PREVIEW = os.path.abspath(argv[1]) if len(argv) > 1 else None

bpy.ops.wm.read_factory_settings(use_empty=True)
scn = bpy.context.scene


def G(v):  # game (x, y-up, z-forward) -> Blender (x, y, z-up)
    return Vector((v[0], -v[2], v[1]))


V = lambda x, y, z: Vector((x, y, z))

# ------------------------------------------------------------------ materials (named; the game swaps in its own)
MAT_ORDER = ['Plume', 'Rust', 'Belly', 'Bone', 'Scale', 'Claw', 'Eye']
MATS = {}


def make_mat(name, color, rough, metal=0.0, coat=0.0, sheen=0.0, emit=None):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    b = nt.nodes['Principled BSDF']
    attr = nt.nodes.new('ShaderNodeVertexColor'); attr.layer_name = 'Col'
    mix = nt.nodes.new('ShaderNodeMix'); mix.data_type = 'RGBA'; mix.blend_type = 'MULTIPLY'
    mix.inputs['Factor'].default_value = 1.0
    mix.inputs[6].default_value = (*color, 1.0)
    nt.links.new(attr.outputs['Color'], mix.inputs[7])
    nt.links.new(mix.outputs[2], b.inputs['Base Color'])
    for key, val in (('Roughness', rough), ('Metallic', metal), ('Coat Weight', coat), ('Sheen Weight', sheen)):
        if key in b.inputs:
            b.inputs[key].default_value = val
    if emit and 'Emission Color' in b.inputs:
        b.inputs['Emission Color'].default_value = (*emit, 1.0)
        b.inputs['Emission Strength'].default_value = 6.0
    MATS[name] = m


make_mat('Plume', (0.05, 0.055, 0.07), 0.45, coat=0.3, sheen=1.0)
make_mat('Rust', (0.2, 0.06, 0.025), 0.5, sheen=0.8)
make_mat('Belly', (0.26, 0.17, 0.1), 0.6, sheen=0.6)
make_mat('Bone', (0.75, 0.68, 0.55), 0.25, coat=1.0)
make_mat('Scale', (0.12, 0.08, 0.045), 0.35, coat=0.8)
make_mat('Claw', (0.02, 0.015, 0.01), 0.15, coat=1.0)
make_mat('Eye', (0.05, 0.02, 0.0), 0.1, coat=1.0, emit=(1.0, 0.55, 0.05))


# ------------------------------------------------------------------ geometry helpers (all in game space)
class Part:
    def __init__(self):
        self.bm = bmesh.new()
        self.col = self.bm.verts.layers.float_color.new('Col')

    def add(self, verts, faces, mat, tints):
        vs = []
        for p, t in zip(verts, tints):
            v = self.bm.verts.new(G(p))
            v[self.col] = (t, t, t, 1.0)
            vs.append(v)
        mi = MAT_ORDER.index(mat)
        for f in faces:
            if len(set(f)) < 3:
                continue
            try:
                face = self.bm.faces.new([vs[i] for i in f])
            except ValueError:
                continue
            face.material_index = mi
            face.smooth = True


def frames(path, up_hint):
    out = []
    for i in range(len(path)):
        t = (path[min(i + 1, len(path) - 1)] - path[max(i - 1, 0)]).normalized()
        h = up_hint if abs(t.dot(up_hint)) < 0.95 else V(1, 0, 0)
        side = t.cross(h).normalized()
        up = side.cross(t).normalized()
        out.append((side, up))
    return out


def tube(part, path, radii, mat, n=10, tip=None, cap=True, up_hint=V(0, 1, 0), tint=1.0, grad=(1.0, 1.0)):
    """Loft rings of (rx, ry) along a path. `tip` adds a closing point; `cap` closes the start."""
    fr = frames(path, up_hint)
    verts, faces, tints = [], [], []
    L = len(path)
    for i, (p, (s, u)) in enumerate(zip(path, fr)):
        rx, ry = radii[i]
        g = grad[0] + (grad[1] - grad[0]) * (i / max(1, L - 1))
        for j in range(n):
            a = 2 * math.pi * j / n
            verts.append(p + s * (math.cos(a) * rx) + u * (math.sin(a) * ry))
            tints.append(tint * g)
    for i in range(L - 1):
        for j in range(n):
            a, b = i * n + j, i * n + (j + 1) % n
            faces.append((a, b, b + n, a + n))
    if cap:
        c = len(verts); verts.append(sum(path[:1], V(0, 0, 0))); tints.append(tint * grad[0])
        for j in range(n):
            faces.append((c, (j + 1) % n, j))
    if tip is not None:
        c = len(verts); verts.append(tip); tints.append(tint * grad[1])
        base = (L - 1) * n
        for j in range(n):
            faces.append((base + j, base + (j + 1) % n, c))
    part.add(verts, faces, mat, tints)


def ellipsoid(part, center, radii, mat, seg=24, rings=16, deform=None, tint=1.0):
    verts, faces, tints = [], [], []
    for r in range(1, rings):
        th = math.pi * r / rings
        for s in range(seg):
            ph = 2 * math.pi * s / seg
            d = V(math.sin(th) * math.sin(ph), math.cos(th), math.sin(th) * math.cos(ph))
            p = V(d.x * radii[0], d.y * radii[1], d.z * radii[2])
            if deform:
                p = deform(p)
            verts.append(center + p); tints.append(tint)
    top = len(verts); verts.append(center + (deform(V(0, radii[1], 0)) if deform else V(0, radii[1], 0))); tints.append(tint)
    bot = len(verts); verts.append(center + (deform(V(0, -radii[1], 0)) if deform else V(0, -radii[1], 0))); tints.append(tint)
    for r in range(rings - 2):
        for s in range(seg):
            a, b = r * seg + s, r * seg + (s + 1) % seg
            faces.append((a, b, b + seg, a + seg))
    for s in range(seg):
        faces.append((top, (s + 1) % seg, s))
        last = (rings - 2) * seg
        faces.append((bot, last + s, last + (s + 1) % seg))
    part.add(verts, faces, mat, tints)


def feather(part, base, direction, normal, length, width, mat, curl=0.06, thick=0.13, tint=None):
    d = direction.normalized()
    nrm = (normal - d * normal.dot(d)).normalized()
    K = 5
    path, radii = [], []
    for i in range(K):
        t = i / K
        path.append(base + d * (length * t) + nrm * (curl * length * t * t))
        w = width * (math.sin(math.pi * min(1.0, 0.18 + t * 0.95)) ** 0.7) * (1 - 0.25 * t)
        radii.append((max(w, 0.004), max(w * thick, 0.003)))
    tip = base + d * length + nrm * (curl * length)
    tube(part, path, radii, mat, n=4, tip=tip, up_hint=nrm, tint=tint if tint is not None else random.uniform(0.82, 1.15), grad=(0.8, 1.1))


def spike(part, base, direction, length, radius, mat, bend=V(0, 0, 0), n=8, segs=5, tint=1.0):
    d = direction.normalized()
    path, radii = [], []
    for i in range(segs):
        t = i / segs
        path.append(base + d * (length * t) + bend * (length * t * t))
        r = radius * (1 - t) ** 0.85
        radii.append((r, r))
    tube(part, path, radii, mat, n=n, tip=base + d * length + bend * length, tint=tint, grad=(0.9, 1.15))


def ell_point(dx, dy, dz, r):
    p = V(dx * r[0], dy * r[1], dz * r[2])
    n = V(dx / r[0], dy / r[1], dz / r[2]).normalized()
    return p, n


def rand_dir():
    while True:
        v = V(random.uniform(-1, 1), random.uniform(-1, 1), random.uniform(-1, 1))
        if 0.01 < v.length <= 1:
            return v.normalized()


def tangent_back(n, back=V(0, -0.25, -1)):
    t = back - n * back.dot(n)
    return t.normalized() if t.length > 1e-4 else V(0, 0, -1)


# ------------------------------------------------------------------ joints
OBJS = []


def empty(name, parent, offset):
    e = bpy.data.objects.new(name, None)
    scn.collection.objects.link(e)
    e.empty_display_size = 0.08
    if parent:
        e.parent = parent
    e.location = G(offset)
    return e


def finalize(part, name, joint):
    bmesh.ops.recalc_face_normals(part.bm, faces=part.bm.faces[:])
    me = bpy.data.meshes.new(name)
    part.bm.to_mesh(me); part.bm.free()
    for m in MAT_ORDER:
        me.materials.append(MATS[m])
    try:
        me.color_attributes.active_color = me.color_attributes['Col']
    except Exception:
        pass
    ob = bpy.data.objects.new(name, me)
    scn.collection.objects.link(ob)
    ob.parent = joint
    OBJS.append(ob)
    return ob


root = empty('Thornbeak', None, (0, 0, 0))
body = empty('Body', root, (0, 1.2, 0))
neck_base = empty('NeckBase', body, (0, 0.35, 0.95))
neck1 = empty('Neck1', neck_base, (0, 0, 0))
neck2 = empty('Neck2', neck1, (0, 0.5, 0))
head = empty('Head', neck2, (0, 0.46, 0))
jaw = empty('Jaw', head, (0, -0.08, 0.16))
tail = empty('Tail', body, (0, 0.2, -0.95))
legs = {}
for side, sx in (('L', 1), ('R', -1)):
    hip = empty('Hip' + side, body, (sx * 0.42, -0.28, -0.05))
    knee = empty('Knee' + side, hip, (0, -0.45, 0))
    ankle = empty('Ankle' + side, knee, (0, -0.55, 0))
    legs[side] = (sx, hip, knee, ankle)

# ------------------------------------------------------------------ body: egg torso, belly, shingled plumage, thorns, wings
P = Part()
TR = (0.74, 0.64, 1.0)


def torso_deform(p):
    q = p.copy()
    if q.z < 0:
        k = -q.z / TR[2]
        q.x *= 1 - 0.18 * k; q.y *= 1 - 0.12 * k
    if q.z > 0 and q.y < 0:
        q.z *= 1.06
    q.y -= 0.05 * (q.x / TR[0]) ** 2  # slight drop at the flanks
    return q


ellipsoid(P, V(0, 0, 0), TR, 'Plume', seg=32, rings=20, deform=torso_deform, tint=0.8)
ellipsoid(P, V(0, -0.22, 0.17), (0.55, 0.42, 0.7), 'Belly', seg=24, rings=14)
count = 0
while count < 300:
    d = rand_dir()
    if d.y < -0.42 or (d.y < -0.1 and d.z > 0.5):
        continue
    p, n = ell_point(d.x, d.y, d.z, TR)
    p = torso_deform(p)
    t = tangent_back(n)
    L = random.uniform(0.32, 0.5) + max(0, -d.z) * 0.2
    feather(P, p - n * 0.025, t, n, L, random.uniform(0.15, 0.22), 'Rust' if random.random() < 0.25 else 'Plume', curl=0.05)
    count += 1
# breast: short rounded contour feathers over the belly
for i in range(60):
    d = rand_dir()
    if d.y > 0.1 or d.z < 0.15:
        continue
    p, n = ell_point(d.x, d.y, d.z, (0.6, 0.5, 0.84))
    p = p + V(0, -0.18, 0.12)
    feather(P, p - n * 0.02, tangent_back(n, V(0, -1, -0.3)), n, random.uniform(0.18, 0.26), 0.12, 'Belly', curl=0.08)
# thorns along the spine
for i in range(8):
    z = 0.72 - i * 0.2
    y = 0.64 * math.sqrt(max(0.0, 1 - (z / TR[2]) ** 2)) * (1 - 0.12 * max(0, -z)) - 0.02
    h = 0.42 - abs(i - 3) * 0.05
    spike(P, V(0, y, z), V(0, 1, -0.5), h, 0.075, 'Bone', bend=V(0, -0.15, -0.35))
    for sx in (-1, 1):
        if 1 <= i <= 5:
            spike(P, V(sx * 0.2, y - 0.07, z - 0.05), V(sx * 0.5, 1, -0.6), h * 0.55, 0.05, 'Bone', bend=V(0, -0.1, -0.3))
# folded wings
for sx in (-1, 1):
    # folded wing: layered coverts over long flight feathers, pressed flat against the flank
    for row, (y0, L0, w, mat_a, mat_b) in enumerate(((0.28, 0.55, 0.2, 'Plume', 'Rust'), (0.16, 0.75, 0.17, 'Rust', 'Plume'), (0.04, 0.95, 0.14, 'Plume', 'Plume'))):
        for k in range(6):
            z = 0.42 - k * 0.09 - row * 0.05
            base = V(sx * (0.66 + row * 0.03), y0 - k * 0.012, z)
            feather(P, base, V(sx * 0.1, -0.22 - row * 0.05, -1), V(sx, 0.35, 0), L0 + k * 0.03, w, mat_a if k % 2 else mat_b, curl=0.02, thick=0.1)
finalize(P, 'BodyMesh', body)

# ------------------------------------------------------------------ neck: two feathered segments and a rust ruff
P = Part()
path = [V(0, -0.1 + 0.65 * i / 6, 0) for i in range(7)]
tube(P, path, [(0.23 - 0.05 * i / 6, 0.21 - 0.05 * i / 6) for i in range(7)], 'Plume', n=16, tip=None, cap=True, up_hint=V(0, 0, 1), tint=0.85)
for i in range(46):
    a = random.uniform(0, 2 * math.pi); y = random.uniform(0.05, 0.5)
    out = V(math.sin(a), 0, math.cos(a))
    feather(P, V(0, y, 0) + out * 0.17, V(0, -1, 0) + out * 0.35 + V(0, 0, -0.15), out, random.uniform(0.2, 0.3), 0.1, 'Plume')
for i in range(16):
    a = 2 * math.pi * i / 16
    out = V(math.sin(a), 0, math.cos(a))
    feather(P, V(0, 0.06, 0) + out * 0.18, out + V(0, -0.45, -0.35), out + V(0, 0.6, 0), random.uniform(0.42, 0.55), 0.14, 'Rust', curl=0.15)
finalize(P, 'Neck1Mesh', neck1)

P = Part()
path = [V(0, -0.08 + 0.58 * i / 6, 0) for i in range(7)]
tube(P, path, [(0.18 - 0.03 * i / 6, 0.165 - 0.025 * i / 6) for i in range(7)], 'Plume', n=14, cap=True, up_hint=V(0, 0, 1), tint=0.85)
for i in range(34):
    a = random.uniform(0, 2 * math.pi); y = random.uniform(0.02, 0.45)
    out = V(math.sin(a), 0, math.cos(a))
    feather(P, V(0, y, 0) + out * 0.13, V(0, -1, 0) + out * 0.3 + V(0, 0, -0.1), out, random.uniform(0.16, 0.24), 0.09, 'Plume')
finalize(P, 'Neck2Mesh', neck2)

# ------------------------------------------------------------------ head: skull, hooked beak, crest horns, eyes
P = Part()
ellipsoid(P, V(0, 0.05, 0.03), (0.2, 0.18, 0.26), 'Plume', seg=24, rings=14, tint=0.85)
for sx in (-1, 1):
    ellipsoid(P, V(sx * 0.12, 0.14, 0.13), (0.085, 0.045, 0.12), 'Plume', seg=12, rings=8, tint=0.7)  # heavy brow
    ellipsoid(P, V(sx * 0.155, 0.075, 0.155), (0.045, 0.045, 0.045), 'Eye', seg=14, rings=10)
beak = [(V(0, 0.02, 0.17), 0.13, 0.11), (V(0, 0.015, 0.33), 0.11, 0.095), (V(0, 0.0, 0.5), 0.085, 0.072),
        (V(0, -0.02, 0.64), 0.06, 0.052), (V(0, -0.05, 0.75), 0.04, 0.036), (V(0, -0.1, 0.81), 0.022, 0.022)]
tube(P, [b[0] for b in beak], [(b[1], b[2]) for b in beak], 'Bone', n=12, tip=V(0, -0.17, 0.8), up_hint=V(0, 1, 0), grad=(0.9, 1.15))
spike(P, V(0, 0.2, -0.02), V(0, 0.65, -1), 0.5, 0.06, 'Bone', bend=V(0, -0.25, -0.1))
for sx in (-1, 1):
    spike(P, V(sx * 0.1, 0.17, -0.04), V(sx * 0.35, 0.55, -1), 0.36, 0.045, 'Bone', bend=V(0, -0.2, 0))
    spike(P, V(sx * 0.16, 0.06, -0.1), V(sx * 0.5, 0.1, -1), 0.22, 0.035, 'Bone', bend=V(0, -0.1, 0))
for i in range(18):
    a = random.uniform(-2.2, 2.2)
    out = V(math.sin(a), 0.4, -abs(math.cos(a)) * 0.5 - 0.3).normalized()
    feather(P, V(0, 0.1, -0.05) + out * 0.12, V(math.sin(a) * 0.3, -0.2, -1), out, random.uniform(0.18, 0.3), 0.08, 'Plume')
finalize(P, 'HeadMesh', head)

P = Part()
jaw_s = [(V(0, 0.0, 0.0), 0.11, 0.05), (V(0, -0.01, 0.18), 0.085, 0.045), (V(0, -0.02, 0.34), 0.055, 0.034), (V(0, -0.02, 0.46), 0.03, 0.02)]
tube(P, [b[0] for b in jaw_s], [(b[1], b[2]) for b in jaw_s], 'Bone', n=10, tip=V(0, -0.015, 0.53), grad=(0.85, 1.1))
finalize(P, 'JawMesh', jaw)

# ------------------------------------------------------------------ tail: fanned quills with bone tips
P = Part()
ellipsoid(P, V(0, 0, 0.1), (0.3, 0.22, 0.3), 'Plume', seg=16, rings=10, tint=0.8)
for i in range(-4, 5):
    d = V(i * 0.24, 0.42 - abs(i) * 0.045, -1).normalized()
    L = 1.2 - abs(i) * 0.07
    nrm = V(0, 1, 0.3)
    feather(P, V(i * 0.03, 0, 0.05), d, nrm, L, 0.18, 'Rust' if i % 2 else 'Plume', curl=-0.05, thick=0.2)
    spike(P, V(i * 0.03, 0, 0.05) + d * (L * 0.97), d, 0.2, 0.03, 'Bone')
for i in range(-3, 4):
    d = V(i * 0.2, 0.3, -1).normalized()
    feather(P, V(i * 0.03, 0.1, 0.1), d, V(0, 1, 0.3), 0.6, 0.15, 'Plume', curl=0.05)
finalize(P, 'TailMesh', tail)

# ------------------------------------------------------------------ legs: feathered thigh, scaled shin with spur, taloned toes
for side, (sx, hip, knee, ankle) in legs.items():
    P = Part()
    ellipsoid(P, V(0, -0.2, 0.02), (0.23, 0.34, 0.27), 'Plume', seg=18, rings=12, tint=0.8)
    for i in range(22):
        a = random.uniform(0, 2 * math.pi)
        out = V(math.sin(a), 0, math.cos(a))
        y = random.uniform(-0.25, 0.05)
        feather(P, V(0, y, 0.02) + out * 0.2, V(0, -1, 0) + out * 0.3 + V(0, 0, -0.2), out, random.uniform(0.28, 0.4), 0.13, 'Plume' if i % 4 else 'Rust')
    finalize(P, 'Thigh' + side, hip)

    P = Part()
    n = 12
    path = [V(0, -0.58 * i / (n - 1), 0) for i in range(n)]
    tube(P, path, [((0.095 - 0.03 * i / n) * (1.07 if i % 2 else 1), (0.085 - 0.025 * i / n) * (1.07 if i % 2 else 1)) for i in range(n)], 'Scale', n=10, up_hint=V(0, 0, 1))
    spike(P, V(0, -0.2, -0.06), V(0, -0.3, -1), 0.17, 0.035, 'Claw', bend=V(0, 0.15, 0))
    finalize(P, 'Shin' + side, knee)

    P = Part()
    ellipsoid(P, V(0, 0, 0), (0.075, 0.07, 0.08), 'Scale', seg=12, rings=8)
    for a in (-0.5, 0.0, 0.5):
        f = V(math.sin(a), 0, math.cos(a))
        pts = [V(0, -0.02, 0) + f * 0.0, V(0, -0.05, 0) + f * 0.14, V(0, -0.06, 0) + f * 0.27]
        tube(P, pts, [(0.05, 0.042), (0.044, 0.036), (0.036, 0.03)], 'Scale', n=8, up_hint=V(0, 1, 0), tip=None)
        spike(P, pts[-1] + f * 0.02, f + V(0, -0.35, 0), 0.14, 0.03, 'Claw', bend=V(0, -0.35, 0))
    back = [V(0, -0.03, 0), V(0, -0.05, -0.11)]
    tube(P, back, [(0.035, 0.03), (0.03, 0.026)], 'Scale', n=8, up_hint=V(0, 1, 0))
    spike(P, back[-1] + V(0, 0, -0.02), V(0, -0.4, -1), 0.09, 0.022, 'Claw', bend=V(0, -0.3, 0))
    finalize(P, 'Foot' + side, ankle)

tris = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in OBJS)
print(f'THORNBEAK: {len(OBJS)} meshes, {tris} triangles')

# ------------------------------------------------------------------ export (rest pose: zero rotations)
os.makedirs(os.path.dirname(OUT), exist_ok=True)
kw = dict(filepath=OUT, export_format='GLB', export_yup=True, export_apply=True, use_selection=False,
          export_cameras=False, export_lights=False)
try:
    bpy.ops.export_scene.gltf(**kw, export_vertex_color='ACTIVE')
except TypeError:
    bpy.ops.export_scene.gltf(**kw)
print('EXPORTED', OUT, os.path.getsize(OUT), 'bytes')

# ------------------------------------------------------------------ optional preview render in the game's idle pose
if PREVIEW:
    os.makedirs(PREVIEW, exist_ok=True)
    pose = {'Neck1': 0.5, 'Neck2': -0.2, 'Head': -0.3, 'HipL': -0.5, 'HipR': -0.5, 'KneeL': 1.0, 'KneeR': 1.0, 'AnkleL': -0.5, 'AnkleR': -0.5, 'Tail': 0.1}
    for k, v in pose.items():
        bpy.data.objects[k].rotation_euler[0] = v
    world = bpy.data.worlds.new('W'); scn.world = world
    world.use_nodes = True
    world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.55, 0.62, 0.72, 1)
    world.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.8
    sun = bpy.data.objects.new('Sun', bpy.data.lights.new('Sun', 'SUN')); scn.collection.objects.link(sun)
    sun.data.energy = 4.0; sun.rotation_euler = (math.radians(50), 0, math.radians(30))
    fill = bpy.data.objects.new('Fill', bpy.data.lights.new('Fill', 'SUN')); scn.collection.objects.link(fill)
    fill.data.energy = 1.5; fill.data.color = (0.6, 0.75, 1.0); fill.rotation_euler = (math.radians(60), 0, math.radians(200))
    floor = bpy.data.meshes.new('Floor'); fo = bpy.data.objects.new('Floor', floor); scn.collection.objects.link(fo)
    bm = bmesh.new(); bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=6); bm.to_mesh(floor); bm.free()
    cam = bpy.data.objects.new('Cam', bpy.data.cameras.new('Cam')); scn.collection.objects.link(cam); scn.camera = cam
    scn.render.engine = 'CYCLES'; scn.cycles.samples = 40; scn.cycles.device = 'CPU'
    scn.render.resolution_x, scn.render.resolution_y = 900, 700
    target = Vector((0, -0.2, 1.3))
    for name, pos in (('front3q', (3.2, -4.2, 2.2)), ('side', (5.0, 0.3, 1.6))):
        cam.location = pos
        cam.rotation_euler = (target - Vector(pos)).to_track_quat('-Z', 'Y').to_euler()
        scn.render.filepath = os.path.join(PREVIEW, f'thornbeak_{name}.png')
        bpy.ops.render.render(write_still=True)
    print('PREVIEW', PREVIEW)
