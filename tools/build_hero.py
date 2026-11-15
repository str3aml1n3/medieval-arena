"""Procedurally builds the hero (an original medieval sell-sword) in Blender and exports glTF.

Run:  blender --background --factory-startup --python tools/build_hero.py -- models/hero.glb [preview_dir]

Built in game space (Y up, +Z forward), converted to Blender axes on the fly. Every part hangs off a
named empty whose offset matches the rig in game.js (Hips, Spine, Neck, Head, Shoulder/Elbow/Hand L/R,
Hip/Knee L/R). The sword (grip at origin, blade along +Z) and scabbard are separate root nodes so the
game can move the sword between hand and hip.
"""
import bpy, bmesh, math, random, sys, os
from mathutils import Vector, Matrix

random.seed(5)
argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT = os.path.abspath(argv[0] if argv else 'hero.glb')
PREVIEW = os.path.abspath(argv[1]) if len(argv) > 1 else None
bpy.ops.wm.read_factory_settings(use_empty=True)
scn = bpy.context.scene
V = lambda x, y, z: Vector((x, y, z))


def G(v):
    return Vector((v[0], -v[2], v[1]))


# ------------------------------------------------------------------ materials (named; the game swaps in its own)
MAT_ORDER = ['Skin', 'Leather', 'Cloth', 'Sash', 'Boot', 'Hair', 'Steel', 'Iron', 'Metal', 'Eye']
MATS = {}


def make_mat(name, color, rough, metal=0.0, coat=0.0, sheen=0.0):
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
    MATS[name] = m


make_mat('Skin', (0.55, 0.32, 0.22), 0.55)
make_mat('Leather', (0.09, 0.045, 0.02), 0.5, coat=0.5)
make_mat('Cloth', (0.05, 0.05, 0.035), 0.85, sheen=0.7)
make_mat('Sash', (0.28, 0.03, 0.02), 0.8, sheen=0.5)
make_mat('Boot', (0.03, 0.017, 0.008), 0.45, coat=0.6)
make_mat('Hair', (0.03, 0.017, 0.01), 0.9)
make_mat('Steel', (0.6, 0.63, 0.68), 0.2, metal=1.0, coat=0.9)
make_mat('Iron', (0.15, 0.15, 0.16), 0.3, metal=0.9, coat=0.6)
make_mat('Metal', (0.8, 0.82, 0.86), 0.12, metal=1.0, coat=1.0)
make_mat('Eye', (0.02, 0.02, 0.02), 0.1, coat=1.0)


# ------------------------------------------------------------------ geometry helpers (game space)
class Part:
    def __init__(self):
        self.bm = bmesh.new()
        self.col = self.bm.verts.layers.float_color.new('Col')

    def add(self, verts, faces, mat, tints):
        vs = []
        for p, t in zip(verts, tints):
            v = self.bm.verts.new(G(p)); v[self.col] = (t, t, t, 1.0); vs.append(v)
        mi = MAT_ORDER.index(mat)
        for f in faces:
            if len(set(f)) < 3:
                continue
            try:
                face = self.bm.faces.new([vs[i] for i in f])
            except ValueError:
                continue
            face.material_index = mi; face.smooth = True


def frames(path, up_hint):
    out = []
    for i in range(len(path)):
        t = (path[min(i + 1, len(path) - 1)] - path[max(i - 1, 0)]).normalized()
        h = up_hint if abs(t.dot(up_hint)) < 0.95 else V(1, 0, 0)
        side = t.cross(h).normalized(); up = side.cross(t).normalized()
        out.append((side, up))
    return out


def tube(part, path, radii, mat, n=16, tip=None, cap=True, up_hint=V(0, 0, 1), tint=1.0, mod=None, grad=(1.0, 1.0)):
    fr = frames(path, up_hint)
    verts, faces, tints = [], [], []
    L = len(path)
    for i, (p, (s, u)) in enumerate(zip(path, fr)):
        rx, ry = radii[i]
        g = grad[0] + (grad[1] - grad[0]) * i / max(1, L - 1)
        for j in range(n):
            a = 2 * math.pi * j / n
            k = mod(i, a) if mod else 1.0
            verts.append(p + s * (math.cos(a) * rx * k) + u * (math.sin(a) * ry * k)); tints.append(tint * g)
    for i in range(L - 1):
        for j in range(n):
            a, b = i * n + j, i * n + (j + 1) % n
            faces.append((a, b, b + n, a + n))
    if cap:
        c = len(verts); verts.append(path[0].copy()); tints.append(tint * grad[0])
        for j in range(n):
            faces.append((c, (j + 1) % n, j))
    end = tip if tip is not None else path[-1].copy()
    c = len(verts); verts.append(end); tints.append(tint * grad[1])
    base = (L - 1) * n
    for j in range(n):
        faces.append((base + j, base + (j + 1) % n, c))
    part.add(verts, faces, mat, tints)


def ellipsoid(part, center, radii, mat, seg=20, rings=14, deform=None, rot=None, tint=1.0):
    verts, faces, tints = [], [], []

    def xf(p):
        if deform:
            p = deform(p)
        if rot:
            p = rot @ p
        return center + p
    for r in range(1, rings):
        th = math.pi * r / rings
        for s in range(seg):
            ph = 2 * math.pi * s / seg
            verts.append(xf(V(math.sin(th) * math.sin(ph) * radii[0], math.cos(th) * radii[1], math.sin(th) * math.cos(ph) * radii[2]))); tints.append(tint)
    top = len(verts); verts.append(xf(V(0, radii[1], 0))); tints.append(tint)
    bot = len(verts); verts.append(xf(V(0, -radii[1], 0))); tints.append(tint)
    for r in range(rings - 2):
        for s in range(seg):
            a, b = r * seg + s, r * seg + (s + 1) % seg
            faces.append((a, b, b + seg, a + seg))
    last = (rings - 2) * seg
    for s in range(seg):
        faces.append((top, (s + 1) % seg, s)); faces.append((bot, last + s, last + (s + 1) % seg))
    part.add(verts, faces, mat, tints)


def torus(part, center, R, r, mat, n_around=28, n_sides=8, tint=1.0, squash=1.0):
    """Ring around the Y axis; R = (rx, rz) of the ring, r = tube radius."""
    verts, faces, tints = [], [], []
    for i in range(n_around):
        a = 2 * math.pi * i / n_around
        c = V(math.sin(a) * R[0], 0, math.cos(a) * R[1])
        out = V(math.sin(a), 0, math.cos(a))
        for j in range(n_sides):
            b = 2 * math.pi * j / n_sides
            verts.append(center + c + out * (math.cos(b) * r) + V(0, math.sin(b) * r * squash, 0)); tints.append(tint)
    for i in range(n_around):
        for j in range(n_sides):
            a = i * n_sides + j; b = i * n_sides + (j + 1) % n_sides
            a2 = ((i + 1) % n_around) * n_sides + j; b2 = ((i + 1) % n_around) * n_sides + (j + 1) % n_sides
            faces.append((a, b, b2, a2))
    part.add(verts, faces, mat, tints)


def plate(part, top, down, width, length, thick, mat, out=V(0, 0, 1), flare=1.25, tint=1.0, segs=4):
    """Flat hanging panel (tasset / strap) from `top` along `down`."""
    d = down.normalized()
    path = [top + d * (length * i / segs) for i in range(segs + 1)]
    radii = [(width / 2 * (1 + (flare - 1) * i / segs), thick) for i in range(segs + 1)]
    tube(part, path, radii, mat, n=8, up_hint=out, tint=tint)


# ------------------------------------------------------------------ joints
OBJS = []


def empty(name, parent, offset):
    e = bpy.data.objects.new(name, None); scn.collection.objects.link(e)
    e.empty_display_size = 0.05
    if parent:
        e.parent = parent
    e.location = G(offset)
    return e


def finalize(part, name, parent):
    bmesh.ops.recalc_face_normals(part.bm, faces=part.bm.faces[:])
    me = bpy.data.meshes.new(name); part.bm.to_mesh(me); part.bm.free()
    for m in MAT_ORDER:
        me.materials.append(MATS[m])
    try:
        me.color_attributes.active_color = me.color_attributes['Col']
    except Exception:
        pass
    ob = bpy.data.objects.new(name, me); scn.collection.objects.link(ob)
    if parent:
        ob.parent = parent
    OBJS.append(ob)
    return ob


root = empty('Hero', None, (0, 0, 0))
hips = empty('Hips', root, (0, 0.98, 0))
spine = empty('Spine', hips, (0, 0.1, 0))
neck = empty('Neck', spine, (0, 0.56, 0))
head = empty('Head', neck, (0, 0.085, 0))
arms, legs = {}, {}
for side, sx in (('L', 1), ('R', -1)):
    sh = empty('Shoulder' + side, spine, (sx * 0.27, 0.5, 0))
    el = empty('Elbow' + side, sh, (0, -0.3, 0))
    ha = empty('Hand' + side, el, (0, -0.28, 0))
    arms[side] = (sx, sh, el, ha)
    hp = empty('Hip' + side, hips, (sx * 0.1, -0.04, 0))
    kn = empty('Knee' + side, hp, (0, -0.44, 0))
    legs[side] = (sx, hp, kn)

quilt = lambda i, a: (1 + 0.03 * math.cos(a * 16)) * (0.975 if i % 2 else 1.0)  # gambeson channels + stitch rows

# ------------------------------------------------------------------ hips: trousers seat, belt, sash, tassets, pouch
P = Part()
sec = [(-0.15, 0.15, 0.105), (-0.07, 0.168, 0.118), (0.02, 0.172, 0.122), (0.1, 0.168, 0.12), (0.16, 0.165, 0.118)]
tube(P, [V(0, y, 0) for y, _, _ in sec], [(rx, rz) for _, rx, rz in sec], 'Cloth', n=20, tint=0.9)
torus(P, V(0, 0.075, 0), (0.18, 0.13), 0.026, 'Leather', squash=1.3)
ellipsoid(P, V(0, 0.075, 0.153), (0.035, 0.03, 0.01), 'Iron', seg=10, rings=6)
torus(P, V(0, 0.015, 0), (0.183, 0.133), 0.032, 'Sash', squash=1.1)
for k, x in enumerate((0.1, 0.13)):  # knotted sash tails at the left hip
    plate(P, V(x, 0.0, 0.1), V(0.15 * k, -1, 0.15), 0.06, 0.26 - k * 0.05, 0.008, 'Sash', out=V(0.4, 0, 1))
for z, out in ((0.135, V(0, 0, 1)), (-0.135, V(0, 0, -1))):  # front / back tassets
    for x in (-0.07, 0.07):
        plate(P, V(x, 0.05, z), V(x * 0.6, -1, z * 0.6), 0.12, 0.25, 0.012, 'Leather', out=out)
for sx in (-1, 1):
    plate(P, V(sx * 0.18, 0.05, 0), V(sx * 0.35, -1, 0), 0.11, 0.2, 0.012, 'Leather', out=V(sx, 0, 0))
    for y in (0.0, -0.08, -0.16):  # rivets on the side tassets
        ellipsoid(P, V(sx * (0.192 - y * 0.35 * -0.3), y + 0.01, 0), (0.008, 0.008, 0.008), 'Iron', seg=6, rings=4)
ellipsoid(P, V(-0.16, 0.0, 0.08), (0.045, 0.055, 0.032), 'Leather', seg=12, rings=8, tint=1.2)  # pouch
finalize(P, 'HipsMesh', hips)

# ------------------------------------------------------------------ spine: quilted gambeson, riveted brigandine, layered pauldrons, collar
P = Part()
T = [(-0.04, 0.165, 0.115, 0.0), (0.08, 0.17, 0.12, 0.0), (0.2, 0.19, 0.13, 0.008), (0.32, 0.212, 0.136, 0.012),
     (0.42, 0.215, 0.13, 0.008), (0.49, 0.185, 0.112, 0.0), (0.53, 0.11, 0.082, 0.0)]
tube(P, [V(0, y, z) for y, _, _, z in T], [(rx, rz) for _, rx, rz, _ in T], 'Cloth', n=28, tip=V(0, 0.56, 0), mod=quilt, tint=0.95)
B = [(0.02, 0.18, 0.13), (0.14, 0.188, 0.136), (0.26, 0.205, 0.146), (0.36, 0.222, 0.15), (0.44, 0.215, 0.14)]
tube(P, [V(0, y, 0.012) for y, _, _ in B], [(rx, rz) for _, rx, rz in B], 'Leather', n=28, tip=V(0, 0.47, 0.01), tint=1.0)
for y, rx, rz in B[:-1]:  # brigandine rivet rows, front and back
    for k in range(-3, 4):
        a = k * 0.32
        for front in (1, -1):
            p = V(math.sin(a) * rx * 1.02, y + 0.03, 0.012 + front * math.cos(a) * rz * 1.03)
            ellipsoid(P, p, (0.008, 0.008, 0.008), 'Iron', seg=6, rings=4)
torus(P, V(0, 0.535, 0.0), (0.098, 0.085), 0.042, 'Cloth', squash=1.9, tint=0.9)  # high padded collar
# baldric strap across the chest
strap = [V(0.17, 0.46, 0.06), V(0.08, 0.36, 0.15), V(-0.04, 0.22, 0.155), V(-0.15, 0.06, 0.13)]
tube(P, strap, [(0.035, 0.008)] * len(strap), 'Leather', n=8, up_hint=V(0, 0, 1), tint=1.25)
for sx in (-1, 1):  # pauldrons: three overlapping steel lames
    for k in range(3):
        rot = Matrix.Rotation(sx * (-0.35 - k * 0.12), 3, 'Z')
        ellipsoid(P, V(sx * (0.245 + k * 0.01), 0.548 - k * 0.048, 0.0), (0.098 + k * 0.006, 0.042, 0.102 + k * 0.004), 'Steel', seg=20, rings=10,
                  deform=lambda p: V(p.x, p.y * (0.4 if p.y < 0 else 1), p.z), rot=rot)
        ellipsoid(P, V(sx * (0.245 + k * 0.01) + sx * 0.03, 0.552 - k * 0.048, 0.085), (0.007, 0.007, 0.007), 'Iron', seg=6, rings=4)
finalize(P, 'SpineMesh', spine)

# ------------------------------------------------------------------ neck & head: face, beard, nasal helm
P = Part()
tube(P, [V(0, -0.03, 0.0), V(0, 0.04, 0.005), V(0, 0.11, 0.01)], [(0.07, 0.072), (0.066, 0.068), (0.064, 0.066)], 'Skin', n=14)
finalize(P, 'NeckMesh', neck)

P = Part()
ellipsoid(P, V(0, 0.1, 0.0), (0.103, 0.122, 0.112), 'Skin', seg=24, rings=16)  # cranium
ellipsoid(P, V(0, 0.035, 0.035), (0.082, 0.07, 0.088), 'Skin', seg=20, rings=12)  # jaw and cheeks
ellipsoid(P, V(0, 0.13, 0.083), (0.088, 0.02, 0.035), 'Skin', seg=16, rings=8, tint=0.9)  # brow ridge
tube(P, [V(0, 0.12, 0.105), V(0, 0.09, 0.122), V(0, 0.065, 0.132)], [(0.014, 0.012), (0.018, 0.016), (0.022, 0.017)], 'Skin', n=10, up_hint=V(0, 0, 1), tip=V(0, 0.058, 0.128))  # nose
for sx in (-1, 1):
    ellipsoid(P, V(sx * 0.104, 0.09, -0.005), (0.016, 0.036, 0.026), 'Skin', seg=10, rings=8, tint=0.92)  # ears
    ellipsoid(P, V(sx * 0.038, 0.108, 0.098), (0.016, 0.01, 0.008), 'Eye', seg=10, rings=6)
    ellipsoid(P, V(sx * 0.042, 0.124, 0.1), (0.026, 0.007, 0.012), 'Hair', seg=10, rings=6)  # eyebrows
    ellipsoid(P, V(sx * 0.03, 0.05, 0.118), (0.032, 0.01, 0.012), 'Hair', seg=10, rings=6, rot=Matrix.Rotation(sx * 0.35, 3, 'Z'))  # moustache
ellipsoid(P, V(0, 0.015, 0.062), (0.086, 0.06, 0.072), 'Hair', seg=20, rings=12, deform=lambda p: V(p.x, p.y * (1.25 if p.y < 0 else 0.6), p.z))  # short beard
ellipsoid(P, V(0, 0.085, -0.06), (0.098, 0.065, 0.065), 'Hair', seg=16, rings=10)  # hair at the nape
# nasal helm: conical dome, brow band, nasal, small rivets
ellipsoid(P, V(0, 0.142, -0.004), (0.118, 0.105, 0.128), 'Steel', seg=28, rings=16,
          deform=lambda p: V(p.x, p.y * (0.12 if p.y < 0 else 1.0) + (0.02 * (p.y / 0.105) ** 3 if p.y > 0 else 0), p.z))
torus(P, V(0, 0.142, -0.004), (0.119, 0.129), 0.012, 'Iron', squash=1.4)
tube(P, [V(0, 0.15, 0.13), V(0, 0.11, 0.133), V(0, 0.072, 0.142)], [(0.013, 0.004)] * 3, 'Steel', n=8, up_hint=V(0, 0, 1))
for k in range(8):
    a = 2 * math.pi * k / 8
    ellipsoid(P, V(math.sin(a) * 0.121, 0.142, -0.004 + math.cos(a) * 0.131), (0.007, 0.007, 0.007), 'Iron', seg=6, rings=4)
tube(P, [V(0, 0.145, 0.125), V(0, 0.22, 0.04), V(0, 0.245, -0.03), V(0, 0.22, -0.11), V(0, 0.145, -0.13)], [(0.01, 0.006)] * 5, 'Iron', n=6, up_hint=V(1, 0, 0))  # crest ridge
finalize(P, 'HeadMesh', head)

# ------------------------------------------------------------------ arms: quilted sleeves, couters, vambraces, gloved fists
for side, (sx, sh, el, ha) in arms.items():
    P = Part()
    U = [(0.03, 0.068, 0.066), (-0.05, 0.066, 0.062), (-0.13, 0.064, 0.06), (-0.21, 0.058, 0.056), (-0.3, 0.052, 0.05)]
    tube(P, [V(0, y, 0) for y, _, _ in U], [(rx, rz) for _, rx, rz in U], 'Cloth', n=16, mod=quilt, tint=0.95)
    finalize(P, 'UpperArm' + side, sh)

    P = Part()
    F = [(0.02, 0.05, 0.05), (-0.08, 0.05, 0.047), (-0.18, 0.044, 0.04), (-0.26, 0.038, 0.034)]
    tube(P, [V(0, y, 0) for y, _, _ in F], [(rx, rz) for _, rx, rz in F], 'Cloth', n=14, tint=0.95)
    vb = [(-0.06, 0.06, 0.057), (-0.14, 0.058, 0.053), (-0.235, 0.05, 0.046)]
    tube(P, [V(0, y, 0) for y, _, _ in vb], [(rx, rz) for _, rx, rz in vb], 'Steel', n=18, tint=1.0)
    for y in (-0.07, -0.225):
        torus(P, V(0, y, 0), (0.061 if y > -0.1 else 0.052, 0.058 if y > -0.1 else 0.048), 0.006, 'Iron', n_sides=6)
    ellipsoid(P, V(0, 0.0, -0.035), (0.055, 0.055, 0.03), 'Steel', seg=16, rings=10)  # couter (elbow cop)
    ellipsoid(P, V(sx * 0.045, 0.0, -0.035), (0.012, 0.035, 0.03), 'Steel', seg=10, rings=6)  # side wing
    finalize(P, 'Forearm' + side, el)

    P = Part()
    tube(P, [V(0, 0.07, 0), V(0, 0.02, 0)], [(0.05, 0.047), (0.046, 0.044)], 'Leather', n=12, tint=1.15)  # glove cuff
    ellipsoid(P, V(0, -0.005, 0.0), (0.04, 0.05, 0.055), 'Leather', seg=16, rings=10)  # fist
    for z in (-0.03, -0.01, 0.01, 0.03):  # knuckles around the grip
        ellipsoid(P, V(-sx * 0.03, -0.035, z), (0.016, 0.015, 0.011), 'Leather', seg=8, rings=6, tint=1.1)
    ellipsoid(P, V(sx * 0.028, 0.0, 0.042), (0.017, 0.03, 0.017), 'Leather', seg=10, rings=6, rot=Matrix.Rotation(sx * 0.4, 3, 'Z'), tint=1.1)  # thumb
    finalize(P, 'Hand' + side + 'Mesh', ha)

# ------------------------------------------------------------------ legs: trousers, turned-cuff boots
for side, (sx, hp, kn) in legs.items():
    P = Part()
    TH = [(0.04, 0.09, 0.095), (-0.06, 0.088, 0.09), (-0.2, 0.078, 0.08), (-0.33, 0.066, 0.068), (-0.45, 0.058, 0.06)]
    tube(P, [V(0, y, 0) for y, _, _ in TH], [(rx, rz) for _, rx, rz in TH], 'Cloth', n=16, tint=0.85)
    finalize(P, 'Thigh' + side, hp)

    P = Part()
    BO = [(0.0, 0.074, 0.076), (-0.07, 0.072, 0.074), (-0.075, 0.062, 0.064), (-0.18, 0.062, 0.068), (-0.3, 0.054, 0.058), (-0.39, 0.049, 0.052)]
    tube(P, [V(0, y, 0) for y, _, _ in BO], [(rx, rz) for _, rx, rz in BO], 'Boot', n=16)
    torus(P, V(0, -0.03, 0), (0.07, 0.073), 0.011, 'Boot', squash=2.8, tint=1.25)  # turned-down cuff
    FT = [V(0, -0.405, -0.075), V(0, -0.41, -0.01), V(0, -0.418, 0.08), V(0, -0.424, 0.15)]
    tube(P, FT, [(0.046, 0.042), (0.05, 0.038), (0.05, 0.03), (0.04, 0.024)], 'Boot', n=14, up_hint=V(0, 1, 0), tip=V(0, -0.426, 0.18))
    tube(P, [V(0, -0.442, -0.08), V(0, -0.443, 0.17)], [(0.05, 0.007), (0.045, 0.007)], 'Leather', n=10, up_hint=V(0, 1, 0), tint=0.7)  # sole
    finalize(P, 'Shin' + side, kn)

# ------------------------------------------------------------------ sword (grip at origin, blade along +Z) and scabbard
P = Part()
tube(P, [V(0, 0, -0.1), V(0, 0, 0.1)], [(0.02, 0.02), (0.021, 0.021)], 'Leather', n=10, up_hint=V(0, 1, 0), mod=lambda i, a: 1.0, tint=1.0)
for z in (-0.07, -0.035, 0.0, 0.035, 0.07):
    ellipsoid(P, V(0, 0, z), (0.023, 0.023, 0.009), 'Leather', seg=10, rings=4, tint=1.2)  # wire-wrap ridges
ellipsoid(P, V(0, 0, -0.125), (0.038, 0.038, 0.016), 'Iron', seg=16, rings=8, rot=Matrix.Rotation(math.pi / 2, 3, 'Y'))  # wheel pommel
guard = [V(-0.13, -0.012, 0.11), V(-0.06, 0, 0.112), V(0.06, 0, 0.112), V(0.13, -0.012, 0.11)]
tube(P, guard, [(0.016, 0.012), (0.018, 0.014), (0.018, 0.014), (0.016, 0.012)], 'Iron', n=8, up_hint=V(0, 1, 0), tip=V(0.14, -0.016, 0.11))
BL = [(0.125, 0.03), (0.4, 0.027), (0.7, 0.024), (0.92, 0.018), (1.0, 0.01)]
tube(P, [V(0, 0, z) for z, _ in BL], [(w, 0.0065) for _, w in BL], 'Metal', n=4, up_hint=V(0, 1, 0), tip=V(0, 0, 1.06))  # diamond-section blade
tube(P, [V(0, 0, 0.13), V(0, 0, 0.75)], [(0.006, 0.0075), (0.004, 0.0072)], 'Iron', n=6, up_hint=V(0, 1, 0), tip=V(0, 0, 0.8))  # fuller
finalize(P, 'Sword', None)

P = Part()
SC = [(0.12, 0.042, 0.019), (0.5, 0.038, 0.017), (0.95, 0.03, 0.014)]
tube(P, [V(0, 0, z) for z, _, _ in SC], [(w, t) for _, w, t in SC], 'Leather', n=12, up_hint=V(0, 1, 0), tip=V(0, 0, 1.02))
tube(P, [V(0, 0, 0.11), V(0, 0, 0.16)], [(0.047, 0.023), (0.046, 0.022)], 'Iron', n=12, up_hint=V(0, 1, 0))  # locket
tube(P, [V(0, 0, 0.9), V(0, 0, 0.99)], [(0.034, 0.017), (0.025, 0.013)], 'Iron', n=12, up_hint=V(0, 1, 0), tip=V(0, 0, 1.035))  # chape
finalize(P, 'Scabbard', None)

tris = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in OBJS)
print(f'HERO: {len(OBJS)} meshes, {tris} triangles')

os.makedirs(os.path.dirname(OUT), exist_ok=True)
kw = dict(filepath=OUT, export_format='GLB', export_yup=True, export_apply=True, use_selection=False, export_cameras=False, export_lights=False)
try:
    bpy.ops.export_scene.gltf(**kw, export_vertex_color='ACTIVE')
except TypeError:
    bpy.ops.export_scene.gltf(**kw)
print('EXPORTED', OUT, os.path.getsize(OUT), 'bytes')

if PREVIEW:
    os.makedirs(PREVIEW, exist_ok=True)
    sword = bpy.data.objects['Sword']; sword.parent = bpy.data.objects['HandR']; sword.location = (0, 0, 0)
    scab = bpy.data.objects['Scabbard']; scab.parent = hips; scab.location = G((0.22, 0.02, -0.04)); scab.rotation_euler = (2.45, 0, 0)
    pose = {'Spine': (0.1, 0.0, 0.22), 'ShoulderR': (-0.55, 0, -0.25), 'ElbowR': (-1.0, 0, 0), 'HandR': (0.45, 0, 0),
            'ShoulderL': (-0.35, 0, 0.28), 'ElbowL': (-0.9, 0, 0), 'HipL': (-0.32, 0, 0.06), 'KneeL': (0.42, 0, 0), 'HipR': (0.25, 0, -0.08), 'KneeR': (0.35, 0, 0)}
    for k, (x, y, z) in pose.items():  # game euler (x, y, z) -> blender (x, -z?, y): rotate about game Y == blender Z
        bpy.data.objects[k].rotation_euler = (x, -z, y)
    world = bpy.data.worlds.new('W'); scn.world = world; world.use_nodes = True
    world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.55, 0.62, 0.72, 1)
    world.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.7
    sun = bpy.data.objects.new('Sun', bpy.data.lights.new('Sun', 'SUN')); scn.collection.objects.link(sun)
    sun.data.energy = 4.0; sun.rotation_euler = (math.radians(50), 0, math.radians(30))
    fill = bpy.data.objects.new('Fill', bpy.data.lights.new('Fill', 'SUN')); scn.collection.objects.link(fill)
    fill.data.energy = 1.5; fill.data.color = (0.6, 0.75, 1.0); fill.rotation_euler = (math.radians(60), 0, math.radians(200))
    floor = bpy.data.meshes.new('Floor'); fo = bpy.data.objects.new('Floor', floor); scn.collection.objects.link(fo)
    bm = bmesh.new(); bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=4); bm.to_mesh(floor); bm.free()
    cam = bpy.data.objects.new('Cam', bpy.data.cameras.new('Cam')); scn.collection.objects.link(cam); scn.camera = cam
    scn.render.engine = 'CYCLES'; scn.cycles.samples = 40; scn.cycles.device = 'CPU'
    scn.render.resolution_x, scn.render.resolution_y = 700, 900
    for name, pos, tgt in (('front3q', (1.6, -2.6, 1.5), (0, 0, 1.05)), ('back3q', (-1.8, 2.4, 1.6), (0, 0, 1.05)), ('face', (0.35, -0.8, 1.8), (0, 0, 1.76))):
        cam.location = pos
        cam.rotation_euler = (Vector(tgt) - Vector(pos)).to_track_quat('-Z', 'Y').to_euler()
        scn.render.filepath = os.path.join(PREVIEW, f'hero_{name}.png')
        bpy.ops.render.render(write_still=True)
    print('PREVIEW', PREVIEW)
