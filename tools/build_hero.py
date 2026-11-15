"""Procedurally builds the hero (an original medieval sell-sword) in Blender and exports glTF.

Run:  blender --background --factory-startup --python tools/build_hero.py -- models/hero.glb [preview_dir]

Built in game space (Y up, +Z forward), converted to Blender axes on the fly. Every part hangs off a
named empty whose offset matches the rig in game.js (Hips, Spine, Neck, Head, Shoulder/Elbow/Hand L/R,
Hip/Knee L/R). The sword (grip at origin, blade along +Z) and scabbard are separate root nodes so the
game can move the sword between hand and hip.

Realism pass: large panels are subdivided, then Cycles bakes ambient occlusion into the vertex colours
(creases, armpits and overlaps get real contact shadow), and the colours are weathered: grime noise,
road dust creeping up the legs, and rust gathering in the crevices of the steel and iron.
"""
import bpy, bmesh, math, random, sys, os
from mathutils import Vector, Matrix, noise

random.seed(5)
argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT = os.path.abspath(argv[0] if argv else 'hero.glb')
PREVIEW = os.path.abspath(argv[1]) if len(argv) > 1 else None
bpy.ops.wm.read_factory_settings(use_empty=True)
scn = bpy.context.scene
V = lambda x, y, z: Vector((x, y, z))
TAU = 2 * math.pi


def G(v):
    return Vector((v[0], -v[2], v[1]))


# ------------------------------------------------------------------ materials (named; the game swaps in its own)
MAT_ORDER = ['Skin', 'Leather', 'Cloth', 'Sash', 'Boot', 'Hair', 'Steel', 'Iron', 'Metal', 'Eye', 'Mail']
MATS = {}


def make_mat(name, color, rough, metal=0.0):
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
    b.inputs['Roughness'].default_value = rough
    b.inputs['Metallic'].default_value = metal
    MATS[name] = m


make_mat('Skin', (0.48, 0.3, 0.21), 0.7)
make_mat('Leather', (0.085, 0.045, 0.022), 0.8)
make_mat('Cloth', (0.05, 0.05, 0.035), 0.95)
make_mat('Sash', (0.22, 0.03, 0.02), 0.9)
make_mat('Boot', (0.03, 0.017, 0.008), 0.78)
make_mat('Hair', (0.03, 0.017, 0.01), 0.95)
make_mat('Steel', (0.36, 0.38, 0.41), 0.5, metal=0.8)
make_mat('Iron', (0.12, 0.12, 0.13), 0.62, metal=0.7)
make_mat('Metal', (0.6, 0.63, 0.67), 0.3, metal=1.0)
make_mat('Eye', (0.02, 0.02, 0.02), 0.35)
make_mat('Mail', (0.2, 0.21, 0.23), 0.55, metal=0.75)


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


def resample(rows, n):
    """Linearly resample a list of equal-length tuples to n rows (more rings → room for surface detail)."""
    out = []
    for k in range(n):
        x = k / (n - 1) * (len(rows) - 1); i = min(len(rows) - 2, int(x)); u = x - i
        out.append(tuple(a + (b - a) * u for a, b in zip(rows[i], rows[i + 1])))
    return out


def tube(part, path, radii, mat, n=16, tip=None, cap=True, up_hint=V(0, 0, 1), tint=1.0, mod=None, grad=(1.0, 1.0), endcap=True):
    fr = frames(path, up_hint)
    verts, faces, tints = [], [], []
    L = len(path)
    for i, (p, (s, u)) in enumerate(zip(path, fr)):
        rx, ry = radii[i]
        g = grad[0] + (grad[1] - grad[0]) * i / max(1, L - 1)
        for j in range(n):
            a = TAU * j / n
            k = mod(i, a) if mod else 1.0
            verts.append(p + s * (math.cos(a) * rx * k) + u * (math.sin(a) * ry * k))
            tints.append((tint(i, j) if callable(tint) else tint) * g)
    for i in range(L - 1):
        for j in range(n):
            a, b = i * n + j, i * n + (j + 1) % n
            faces.append((a, b, b + n, a + n))
    t0 = tint(0, 0) if callable(tint) else tint
    if cap:
        c = len(verts); verts.append(path[0].copy()); tints.append(t0 * grad[0])
        for j in range(n):
            faces.append((c, (j + 1) % n, j))
    if endcap:
        end = tip if tip is not None else path[-1].copy()
        c = len(verts); verts.append(end); tints.append(t0 * grad[1])
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
            ph = TAU * s / seg
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
        a = TAU * i / n_around
        c = V(math.sin(a) * R[0], 0, math.cos(a) * R[1])
        out = V(math.sin(a), 0, math.cos(a))
        for j in range(n_sides):
            b = TAU * j / n_sides
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


def curtain(part, cy, y0, y1, r0, r1, a0, a1, mat, rows=8, cols=24, depth=(1.0, 1.0), mod=None, tint=1.0, thick=0.006):
    """Partial cylinder sheet hanging from y0 (radius r0) to y1 (radius r1), angles a0..a1 (0 = front, +Z).
    Built as a thin closed shell so it shades correctly from both sides. depth scales the z radius."""
    verts, faces, tints = [], [], []
    for layer, off in ((0, 0.0), (1, -thick)):
        for i in range(rows + 1):
            u = i / rows; y = y0 + (y1 - y0) * u; r = r0 + (r1 - r0) * u + off
            for j in range(cols + 1):
                a = a0 + (a1 - a0) * j / cols
                k = mod(i, j, u, a) if mod else 1.0
                verts.append(V(math.sin(a) * r * depth[0] * k, cy + y, math.cos(a) * r * depth[1] * k))
                tints.append(tint(i, j) if callable(tint) else tint)
    W = cols + 1; S = (rows + 1) * W
    for i in range(rows):
        for j in range(cols):
            a, b, c, d = i * W + j, i * W + j + 1, (i + 1) * W + j + 1, (i + 1) * W + j
            faces.append((a, b, c, d)); faces.append((S + d, S + c, S + b, S + a))
    for i in range(rows):  # side edges
        faces.append((i * W, (i + 1) * W, S + (i + 1) * W, S + i * W))
        faces.append((i * W + cols, S + i * W + cols, S + (i + 1) * W + cols, (i + 1) * W + cols))
    for j in range(cols):  # hem and top edges
        faces.append((rows * W + j, rows * W + j + 1, S + rows * W + j + 1, S + rows * W + j))
        faces.append((j, S + j, S + j + 1, j + 1))
    part.add(verts, faces, mat, tints)


def rivet(part, p, r=0.0075, mat='Iron'):
    ellipsoid(part, p, (r, r, r), mat, seg=6, rings=4)


def buckle(part, p, w=0.026, h=0.022, out=V(0, 0, 1)):
    """A small rectangular iron buckle frame facing `out`."""
    side = V(0, 1, 0).cross(out).normalized() if abs(out.y) < 0.9 else V(1, 0, 0)
    up = out.cross(side).normalized()
    corners = [p + side * (sx * w / 2) + up * (sy * h / 2) for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
    for k in range(4):
        tube(part, [corners[k], corners[(k + 1) % 4]], [(0.0035, 0.0035)] * 2, 'Iron', n=6, up_hint=out)
    tube(part, [p - up * (h / 2), p + up * (h / 2)], [(0.0025, 0.0025)] * 2, 'Iron', n=5, up_hint=out)  # tongue


# surface modifiers -------------------------------------------------
def diamond_quilt(freq, rows_per, depth=0.03):
    """Puffy diamond quilting: stitch lines along both diagonals, cells swell between them."""
    def m(i, a):
        u = a * freq / TAU; v = i / rows_per
        e1 = abs((u + v) - round(u + v)); e2 = abs((u - v) - round(u - v))
        st = min(e1, e2) * 2  # 0 on a stitch, 1 mid-cell
        return 1 - depth * 0.5 + depth * math.sqrt(st)
    return m


def channel_quilt(freq, depth=0.025):
    return lambda i, a: 1 - depth * 0.5 + depth * abs(math.sin(a * freq / 2))


def wrinkles(seed, amt=0.025, scale=5.0):
    return lambda i, a: 1 + amt * noise.noise(V(math.cos(a) * scale, i * 0.6 + seed, math.sin(a) * scale))


def combine(*ms):
    return lambda i, a: math.prod(m(i, a) for m in ms)


# ------------------------------------------------------------------ joints
OBJS = []


def empty(name, parent, offset):
    e = bpy.data.objects.new(name, None); scn.collection.objects.link(e)
    e.empty_display_size = 0.05
    if parent:
        e.parent = parent
    e.location = G(offset)
    return e


def finalize(part, name, parent, subdiv_len=0.045):
    bm = part.bm
    long_edges = [e for e in bm.edges if e.calc_length() > subdiv_len]
    if long_edges:  # give big flat panels enough vertices to carry baked shading
        bmesh.ops.subdivide_edges(bm, edges=long_edges, cuts=1, use_grid_fill=True)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    # box-projected UVs (about 6 repeats per metre) so the game can lay surface textures — scratches, smudges,
    # varying roughness — over the armour without needing hand-made unwraps
    uvl = bm.loops.layers.uv.new('UVMap')
    for f in bm.faces:
        n = f.normal; ax = max(range(3), key=lambda k: abs(n[k]))
        for lp in f.loops:
            co = lp.vert.co
            u, v = ((co.y, co.z), (co.x, co.z), (co.x, co.y))[ax]
            lp[uvl].uv = (u * 6.0, v * 6.0)
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    for m in MAT_ORDER:
        me.materials.append(MATS[m])
    me.color_attributes.active_color = me.color_attributes['Col']
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

# ------------------------------------------------------------------ hips: trousers seat, quilted coat skirt, belts, pouch, dagger
P = Part()
sec = resample([(-0.15, 0.15, 0.105), (-0.07, 0.168, 0.118), (0.02, 0.172, 0.122), (0.1, 0.168, 0.12), (0.16, 0.165, 0.118)], 9)
tube(P, [V(0, y, 0) for y, _, _ in sec], [(rx, rz) for _, rx, rz in sec], 'Cloth', n=24, tint=0.9, mod=wrinkles(3.0, 0.02))
# the gambeson continues as a quilted coat skirt to mid-thigh, slit front and back for walking and riding
skirt_mod = lambda i, j, u, a: (1 - 0.01 + 0.02 * abs(math.sin(j * math.pi / 2.5))) * (1 + 0.04 * u * noise.noise(V(a * 3, u * 2, 0.5)))
for a0, a1 in ((0.1, math.pi - 0.1), (math.pi + 0.1, TAU - 0.1)):
    curtain(P, 0.0, 0.04, -0.24, 0.168, 0.212, a0, a1, 'Cloth', rows=9, cols=40, depth=(1.0, 0.8), mod=skirt_mod, tint=0.92, thick=0.01)
torus(P, V(0, 0.075, 0), (0.183, 0.133), 0.024, 'Leather', n_around=40, squash=1.4, tint=1.1)  # belt
buckle(P, V(0, 0.075, 0.16), w=0.04, h=0.036)
plate(P, V(0.03, 0.075, 0.158), V(0.4, -1, 0.1), 0.035, 0.09, 0.005, 'Leather', out=V(0, 0, 1), flare=1.0, tint=1.1)  # strap end
# sword belt slung low across the hips, dropping toward the scabbard on the left
sb = [V(math.sin(a) * 0.192, 0.0 - 0.045 * max(0.0, math.sin(a)) - 0.012 * math.cos(a), math.cos(a) * 0.142) for a in (TAU * k / 48 for k in range(49))]
tube(P, sb, [(0.006, 0.02)] * len(sb), 'Leather', n=6, up_hint=V(0, 1, 0), cap=False, endcap=False, tint=0.95)
buckle(P, sb[0] + V(0, 0, 0.008), w=0.034, h=0.03)
for a in (0.9, 1.4):  # frog loops holding the scabbard
    p = V(math.sin(a) * 0.194, -0.045 * math.sin(a) - 0.012 * math.cos(a) - 0.035, math.cos(a) * 0.144)
    plate(P, p + V(0, 0.035, 0), V(0, -1, 0), 0.022, 0.06, 0.005, 'Leather', out=V(math.sin(a), 0, math.cos(a)), flare=1.0, tint=1.1)
ellipsoid(P, V(-0.18, -0.005, 0.1), (0.045, 0.055, 0.032), 'Leather', seg=12, rings=8, tint=1.15)  # pouch
plate(P, V(-0.18, 0.05, 0.13), V(0, -1, 0.15), 0.07, 0.05, 0.005, 'Leather', out=V(-0.3, 0, 1), flare=1.0, tint=1.25)  # pouch flap
# rondel dagger at the small of the back
dg = Matrix.Rotation(-0.5, 3, 'Z')
dbase = V(-0.08, 0.06, -0.165)
tube(P, [dbase + dg @ V(0, -0.02, 0), dbase + dg @ V(0, -0.22, 0)], [(0.017, 0.012), (0.01, 0.008)], 'Leather', n=8, up_hint=V(0, 0, 1), tip=dbase + dg @ V(0, -0.24, 0))
tube(P, [dbase + dg @ V(0, -0.01, 0), dbase + dg @ V(0, 0.09, 0)], [(0.011, 0.011)] * 2, 'Leather', n=8, up_hint=V(0, 0, 1), tint=1.2)
for yy in (-0.012, 0.1):
    ellipsoid(P, dbase + dg @ V(0, yy, 0), (0.024, 0.006, 0.024), 'Iron', seg=12, rings=6, rot=dg)
finalize(P, 'HipsMesh', hips)

# ------------------------------------------------------------------ spine: quilted gambeson, brigandine, mail collar, pauldrons
P = Part()
T = resample([(-0.04, 0.165, 0.115, 0.0), (0.08, 0.17, 0.12, 0.0), (0.2, 0.19, 0.13, 0.008), (0.32, 0.212, 0.136, 0.012),
              (0.42, 0.215, 0.13, 0.008), (0.49, 0.185, 0.112, 0.0), (0.53, 0.11, 0.082, 0.0)], 22)
chest = lambda i, a: (1 + 0.07 * max(0.0, math.sin(a)) ** 2 * math.exp(-((i - 13) / 5) ** 2)) * (1 - 0.05 * max(0.0, -math.sin(a)) ** 2)
tube(P, [V(0, y, z) for y, _, _, z in T], [(rx, rz) for _, rx, rz, _ in T], 'Cloth', n=48, tip=V(0, 0.56, 0),
     mod=combine(chest, diamond_quilt(14, 3.5, 0.035)), tint=0.95)
# brigandine: rows of overlapping plates under leather, each row a raised ledge, riveted
Bq = resample([(0.02, 0.182, 0.132), (0.14, 0.19, 0.138), (0.26, 0.207, 0.148), (0.36, 0.224, 0.152), (0.44, 0.217, 0.142)], 16)
lames = lambda i, a: (1 + 0.016 * ((i % 3) / 2)) * (1 + 0.06 * max(0.0, math.sin(a)) ** 2 * math.exp(-((i - 10) / 5) ** 2))
tube(P, [V(0, y, 0.012) for y, _, _ in Bq], [(rx, rz) for _, rx, rz in Bq], 'Leather', n=48, tip=V(0, 0.47, 0.01), mod=lames,
     tint=lambda i, j: 1.0 + 0.08 * ((i % 3) == 2))
for y, rx, rz in Bq[2:-1:3]:  # rivet rows along each plate ledge
    for k in range(-5, 6):
        a = k * 0.27
        for front in (1, -1):
            rivet(P, V(math.sin(a) * rx * 1.04, y, 0.012 + front * math.cos(a) * rz * 1.06), r=0.0065)
for y in (0.16, 0.3):  # buckled straps closing the brigandine at the side
    for sx in (-1, 1):
        buckle(P, V(sx * 0.215, y, 0.02), out=V(sx, 0, 0.15))
# mail collar spilling over the shoulders
mail_tint = lambda i, j: 0.88 + 0.22 * ((i + j) % 2)
MC = resample([(0.6, 0.082, 0.076), (0.56, 0.1, 0.09), (0.52, 0.15, 0.115), (0.48, 0.2, 0.135), (0.45, 0.218, 0.142)], 12)
tube(P, [V(0, y, 0) for y, _, _ in MC], [(rx, rz) for _, rx, rz in MC], 'Mail', n=72, cap=False, tint=mail_tint,
     mod=lambda i, a: 1 + 0.004 * math.cos(a * 36) * (-1) ** i, endcap=False)
# baldric strap across the chest
strap = [V(0.19, 0.47, 0.06), V(0.09, 0.37, 0.165), V(-0.04, 0.22, 0.17), V(-0.16, 0.06, 0.14)]
tube(P, strap, [(0.035, 0.008)] * len(strap), 'Leather', n=8, up_hint=V(0, 0, 1), tint=1.25)
for k in range(1, 3):
    rivet(P, strap[k] + V(0, 0, 0.01), r=0.006)
for sx in (-1, 1):  # spaulders: a rounded cop cupping the shoulder, two narrow lames wrapping down the outside of the arm
    rot = Matrix.Rotation(sx * -0.5, 3, 'Z')
    c = V(sx * 0.262, 0.528, 0.0)
    ellipsoid(P, c, (0.084, 0.078, 0.098), 'Steel', seg=32, rings=16, deform=lambda p: V(p.x, p.y * (0.25 if p.y < 0 else 1), p.z), rot=rot)
    for zz in (-0.06, 0.0, 0.06):
        rivet(P, c + rot @ V(0.0, 0.055, zz), r=0.0055)
    for k in (1, 2):
        rk = Matrix.Rotation(sx * (-1.0 - 0.18 * k), 3, 'Z')
        ck = V(sx * (0.3 + 0.008 * k), 0.49 - 0.04 * k, 0.0)
        ellipsoid(P, ck, (0.074 - 0.006 * k, 0.026, 0.088 - 0.006 * k), 'Steel', seg=28, rings=10,
                  deform=lambda p: V(p.x, p.y * (0.3 if p.y < 0 else 1), p.z), rot=rk, tint=0.95)
        rivet(P, ck + rk @ V(0.0, 0.02, 0.0), r=0.005)
finalize(P, 'SpineMesh', spine)

# ------------------------------------------------------------------ neck & head: bare-headed — face, shaggy hair, beard, a scar
P = Part()
tube(P, [V(0, -0.03, 0.0), V(0, 0.04, 0.004), V(0, 0.11, 0.008)], [(0.078, 0.08), (0.07, 0.073), (0.067, 0.07)], 'Skin', n=20)
ellipsoid(P, V(0, 0.035, 0.062), (0.016, 0.02, 0.014), 'Skin', seg=10, rings=8, tint=0.97)  # larynx
for sx in (-1, 1):  # the cords of the neck running up behind the ears
    tube(P, [V(sx * 0.05, -0.03, 0.035), V(sx * 0.062, 0.04, 0.0), V(sx * 0.066, 0.1, -0.03)], [(0.016, 0.02), (0.015, 0.018), (0.012, 0.014)], 'Skin', n=8, up_hint=V(0, 0, 1))
finalize(P, 'NeckMesh', neck)

P = Part()


def skull(p):  # one continuous head: broad cranium, flatter temples, a jaw that narrows and juts toward the chin
    t = max(0.0, -p.y / 0.135)
    x = p.x * (1 - 0.3 * t ** 1.4) * (0.96 if abs(p.y) < 0.04 else 1.0)
    z = p.z * (1 - 0.12 * t) + 0.03 * t * (1 if p.z > 0 else 0.2) + (0.012 if p.z < 0 and p.y > 0 else 0.0)
    return V(x, p.y, z)


ellipsoid(P, V(0, 0.088, 0.0), (0.1, 0.135, 0.112), 'Skin', seg=40, rings=28, deform=skull)
ellipsoid(P, V(0, 0.03, 0.04), (0.074, 0.06, 0.082), 'Skin', seg=24, rings=14)  # the mass of the jaw and cheeks
ellipsoid(P, V(0, 0.128, 0.083), (0.086, 0.019, 0.034), 'Skin', seg=20, rings=8, tint=0.93)  # brow ridge
for sx in (-1, 1):
    ellipsoid(P, V(sx * 0.054, 0.084, 0.07), (0.024, 0.014, 0.02), 'Skin', seg=12, rings=8, tint=1.02)  # cheekbones
    ellipsoid(P, V(sx * 0.038, 0.106, 0.092), (0.016, 0.011, 0.01), 'Eye', seg=14, rings=10)  # eyeballs, set back in their sockets
    ellipsoid(P, V(sx * 0.036, 0.106, 0.1015), (0.0062, 0.0062, 0.002), 'Hair', seg=10, rings=6)  # iris and pupil
    ellipsoid(P, V(sx * 0.038, 0.1155, 0.0955), (0.0195, 0.006, 0.0105), 'Skin', seg=12, rings=6, tint=0.88)  # upper lids, a little hooded
    ellipsoid(P, V(sx * 0.038, 0.0955, 0.094), (0.017, 0.003, 0.009), 'Skin', seg=10, rings=6, tint=0.85)  # lower lids / bags
    ellipsoid(P, V(sx * 0.042, 0.1255, 0.1), (0.028, 0.0075, 0.012), 'Hair', seg=12, rings=6, rot=Matrix.Rotation(sx * -0.14, 3, 'Z'))  # heavy brows
    ellipsoid(P, V(sx * 0.103, 0.09, -0.005), (0.015, 0.036, 0.026), 'Skin', seg=12, rings=8, tint=0.95)  # ears
    ellipsoid(P, V(sx * 0.108, 0.09, -0.002), (0.006, 0.022, 0.014), 'Skin', seg=8, rings=6, tint=0.8)  # ear folds
    ellipsoid(P, V(sx * 0.013, 0.061, 0.124), (0.01, 0.008, 0.008), 'Skin', seg=8, rings=6, tint=0.92)  # nostril wings
    ellipsoid(P, V(sx * 0.03, 0.05, 0.116), (0.034, 0.011, 0.013), 'Hair', seg=12, rings=6, rot=Matrix.Rotation(sx * 0.4, 3, 'Z'))  # moustache
tube(P, [V(0, 0.122, 0.104), V(0, 0.095, 0.121), V(0, 0.068, 0.132)], [(0.012, 0.011), (0.016, 0.015), (0.02, 0.016)], 'Skin', n=12, up_hint=V(0, 0, 1), tip=V(0, 0.058, 0.128))  # nose
ellipsoid(P, V(0.004, 0.098, 0.123), (0.008, 0.007, 0.006), 'Skin', seg=8, rings=6, tint=0.95)  # the bump of an old break
ellipsoid(P, V(0, 0.034, 0.108), (0.022, 0.007, 0.01), 'Skin', seg=12, rings=6, tint=0.72)  # lower lip
# an old scar: down through the left brow and across the cheekbone
scar = [V(0.058, 0.15, 0.093), V(0.054, 0.128, 0.104), V(0.058, 0.1, 0.099), V(0.066, 0.078, 0.088)]
tube(P, scar, [(0.0028, 0.002), (0.0034, 0.0026), (0.0034, 0.0026), (0.0026, 0.002)], 'Skin', n=6, up_hint=V(0, 0, 1), tint=0.62)


def shaggy(p, amt=0.22, sc=60.0):  # coarse hair: the surface frays in fine, downward-combed clumps
    n = noise.noise(V(p.x * sc, p.y * sc * 0.35, p.z * sc))
    return p * (1 + amt * n)


ellipsoid(P, V(0, 0.012, 0.062), (0.084, 0.062, 0.072), 'Hair', seg=40, rings=22,
          deform=lambda p: shaggy(V(p.x, p.y * (1.3 if p.y < 0 else 0.55), p.z), 0.12))  # beard


def hair_cap(p):  # hangs to the ears at the sides and back; in front it stops at the hairline, which dips to the temples
    y = p.y * (0.8 if p.y < 0 else 1.0)
    if p.z > 0:
        y = max(y, -0.07 + p.z * 0.9)
    q = V(p.x, y, p.z)
    locks = noise.noise(V(q.x * 22.0, q.y * 7.0, q.z * 22.0))  # broad, downward-combed locks
    return shaggy(q * (1 + 0.07 * locks), 0.06, 55.0)


ellipsoid(P, V(0, 0.118, -0.012), (0.109, 0.116, 0.123), 'Hair', seg=48, rings=30, deform=hair_cap)
ellipsoid(P, V(0, 0.062, -0.066), (0.094, 0.085, 0.058), 'Hair', seg=28, rings=16, deform=lambda p: shaggy(p, 0.11, 50.0))  # thick at the nape
for sx in (-1, 1):
    ellipsoid(P, V(sx * 0.089, 0.06, 0.034), (0.009, 0.04, 0.022), 'Hair', seg=10, rings=8, deform=lambda p: shaggy(p, 0.12, 70.0))  # sideburns into the beard
finalize(P, 'HeadMesh', head)

# ------------------------------------------------------------------ arms: quilted sleeves, couters, vambraces, gauntlets
for side, (sx, sh, el, ha) in arms.items():
    P = Part()
    U = resample([(0.03, 0.07, 0.068), (-0.05, 0.068, 0.064), (-0.13, 0.064, 0.06), (-0.21, 0.058, 0.056), (-0.3, 0.052, 0.05)], 14)
    delt = lambda i, a, sx=sx: 1 + 0.12 * max(0.0, math.cos(a)) ** 2 * math.exp(-(i / 4) ** 2)  # deltoid swells at the top of the arm
    tube(P, [V(0, y, 0) for y, _, _ in U], [(rx, rz) for _, rx, rz in U], 'Cloth', n=24, mod=combine(delt if sx > 0 else (lambda i, a: delt(i, a + math.pi)), channel_quilt(10)), tint=0.95)
    finalize(P, 'UpperArm' + side, sh)

    P = Part()
    F = resample([(0.02, 0.05, 0.05), (-0.08, 0.05, 0.047), (-0.18, 0.044, 0.04), (-0.26, 0.038, 0.034)], 8)
    tube(P, [V(0, y, 0) for y, _, _ in F], [(rx, rz) for _, rx, rz in F], 'Cloth', n=18, tint=0.95, mod=wrinkles(7 + sx, 0.04))
    vb = resample([(-0.06, 0.06, 0.057), (-0.14, 0.058, 0.053), (-0.235, 0.05, 0.046)], 8)
    tube(P, [V(0, y, 0) for y, _, _ in vb], [(rx, rz) for _, rx, rz in vb], 'Steel', n=28, tint=1.0,
         mod=lambda i, a: 1 + 0.03 * max(0.0, math.sin(a)) ** 8)  # a raised ridge down the back of the vambrace
    for y in (-0.08, -0.215):
        torus(P, V(0, y, 0), (0.061 if y > -0.1 else 0.053, 0.058 if y > -0.1 else 0.049), 0.007, 'Leather', n_around=24, n_sides=6, tint=1.2)
        buckle(P, V(sx * 0.062, y, 0.0), w=0.018, h=0.016, out=V(sx, 0, 0))
    ellipsoid(P, V(0, 0.0, -0.035), (0.056, 0.056, 0.032), 'Steel', seg=20, rings=12)  # couter
    torus(P, V(0, 0.0, -0.035), (0.05, 0.05), 0.004, 'Steel', n_around=20, n_sides=5)
    ellipsoid(P, V(sx * 0.047, 0.0, -0.035), (0.012, 0.038, 0.032), 'Steel', seg=12, rings=8)  # side wing
    rivet(P, V(sx * 0.06, 0.0, -0.035))
    finalize(P, 'Forearm' + side, el)

    P = Part()
    tube(P, [V(0, 0.09, 0), V(0, 0.05, 0), V(0, 0.02, 0)], [(0.058, 0.055), (0.05, 0.047), (0.045, 0.043)], 'Leather', n=16, tint=1.1, cap=False, endcap=False)  # flared gauntlet cuff
    torus(P, V(0, 0.088, 0), (0.058, 0.055), 0.004, 'Leather', n_around=18, n_sides=5, tint=1.3)  # stitched hem
    ellipsoid(P, V(0, -0.005, 0.0), (0.04, 0.05, 0.054), 'Leather', seg=18, rings=12)  # palm and back of hand
    gc = V(0, -0.012, 0)  # the grip runs along Z through here; fingers wrap round it from the knuckles to the palm
    for k, z in enumerate((-0.033, -0.011, 0.011, 0.033)):
        R = 0.034 - abs(z) * 0.08
        pts = [gc + V(sx * dx * R, dy * R, z) for dx, dy in ((-0.72, -0.55), (-0.45, -0.95), (0.15, -1.05), (0.7, -0.7), (0.9, -0.15))]
        tube(P, pts, [(0.0115, 0.0105), (0.011, 0.0105), (0.0105, 0.01), (0.01, 0.0095), (0.009, 0.0085)], 'Leather', n=10, up_hint=V(0, 0, 1), tint=1.05)
        for q in (1, 3):  # knuckle creases
            ellipsoid(P, pts[q], (0.0118, 0.0118, 0.0112), 'Leather', seg=8, rings=6, tint=1.12)
    ellipsoid(P, V(sx * 0.03, -0.006, 0.046), (0.016, 0.032, 0.016), 'Leather', seg=10, rings=8, rot=Matrix.Rotation(sx * 0.45, 3, 'Z'), tint=1.1)  # thumb
    for k in range(3):  # small steel plates over the back of the hand
        ellipsoid(P, V(-sx * 0.035, 0.03 - k * 0.022, 0.0), (0.012, 0.012, 0.045), 'Steel', seg=10, rings=6)
    finalize(P, 'Hand' + side + 'Mesh', ha)

# ------------------------------------------------------------------ legs: trousers, knee cops, strapped boots
for side, (sx, hp, kn) in legs.items():
    P = Part()
    TH = resample([(0.04, 0.09, 0.095), (-0.06, 0.088, 0.09), (-0.2, 0.078, 0.08), (-0.33, 0.066, 0.068), (-0.45, 0.058, 0.06)], 14)
    tube(P, [V(0, y, 0) for y, _, _ in TH], [(rx, rz) for _, rx, rz in TH], 'Cloth', n=24, tint=0.85, mod=wrinkles(11 + sx * 3, 0.035, 3.0))
    finalize(P, 'Thigh' + side, hp)

    P = Part()
    tube(P, [V(0, 0.04, 0), V(0, -0.04, 0)], [(0.06, 0.062), (0.058, 0.06)], 'Cloth', n=20, tint=0.8, mod=wrinkles(20 + sx, 0.06, 4.0))  # trouser at the knee
    ellipsoid(P, V(0, 0.0, 0.05), (0.05, 0.06, 0.03), 'Steel', seg=20, rings=12)  # poleyn
    ellipsoid(P, V(sx * 0.045, 0.0, 0.03), (0.012, 0.04, 0.03), 'Steel', seg=10, rings=6)
    torus(P, V(0, 0.0, 0.0), (0.066, 0.066), 0.006, 'Leather', n_around=22, n_sides=5, tint=1.2)
    BO = resample([(-0.05, 0.072, 0.074), (-0.075, 0.064, 0.066), (-0.18, 0.062, 0.068), (-0.3, 0.054, 0.058), (-0.39, 0.05, 0.053)], 12)
    tube(P, [V(0, y, 0) for y, _, _ in BO], [(rx, rz) for _, rx, rz in BO], 'Boot', n=20, mod=wrinkles(30 + sx, 0.03, 2.5))
    torus(P, V(0, -0.05, 0), (0.072, 0.074), 0.012, 'Boot', n_around=26, squash=2.6, tint=1.25)  # turned-down cuff
    for y in (-0.22, -0.33):  # buckled straps round the ankle
        torus(P, V(0, y, 0), (0.063 if y > -0.25 else 0.057, 0.069 if y > -0.25 else 0.061), 0.007, 'Leather', n_around=24, n_sides=6, tint=1.3)
        buckle(P, V(sx * 0.064, y, 0.01), w=0.017, h=0.016, out=V(sx, 0, 0.2))
    FT = [V(0, -0.405, -0.078), V(0, -0.41, -0.01), V(0, -0.418, 0.08), V(0, -0.424, 0.15)]
    tube(P, FT, [(0.047, 0.043), (0.05, 0.039), (0.051, 0.031), (0.041, 0.025)], 'Boot', n=18, up_hint=V(0, 1, 0), tip=V(0, -0.426, 0.182))
    tube(P, [V(0, -0.442, -0.085), V(0, -0.443, 0.175)], [(0.052, 0.008), (0.046, 0.008)], 'Leather', n=12, up_hint=V(0, 1, 0), tint=0.6)  # sole
    tube(P, [V(0, -0.44, -0.085), V(0, -0.44, -0.03)], [(0.045, 0.014), (0.045, 0.014)], 'Leather', n=10, up_hint=V(0, 1, 0), tint=0.55)  # heel
    finalize(P, 'Shin' + side, kn)

# ------------------------------------------------------------------ sword (grip at origin, blade along +Z) and scabbard
P = Part()
tube(P, [V(0, 0, -0.1), V(0, 0, 0.1)], [(0.02, 0.02), (0.021, 0.021)], 'Leather', n=12, up_hint=V(0, 1, 0), tint=1.0)
for z in (-0.07, -0.035, 0.0, 0.035, 0.07):
    ellipsoid(P, V(0, 0, z), (0.023, 0.023, 0.009), 'Leather', seg=10, rings=4, tint=1.2)  # wire-wrap ridges
ellipsoid(P, V(0, 0, -0.125), (0.038, 0.038, 0.016), 'Iron', seg=18, rings=8, rot=Matrix.Rotation(math.pi / 2, 3, 'Y'))  # wheel pommel
guard = [V(-0.13, -0.012, 0.11), V(-0.06, 0, 0.112), V(0.06, 0, 0.112), V(0.13, -0.012, 0.11)]
tube(P, guard, [(0.016, 0.012), (0.018, 0.014), (0.018, 0.014), (0.016, 0.012)], 'Iron', n=8, up_hint=V(0, 1, 0), tip=V(0.14, -0.016, 0.11))
BL = [(0.125, 0.03), (0.4, 0.027), (0.7, 0.024), (0.92, 0.018), (1.0, 0.01)]
tube(P, [V(0, 0, z) for z, _ in BL], [(w, 0.0065) for _, w in BL], 'Metal', n=4, up_hint=V(0, 1, 0), tip=V(0, 0, 1.06))  # diamond-section blade
tube(P, [V(0, 0, 0.13), V(0, 0, 0.75)], [(0.006, 0.0075), (0.004, 0.0072)], 'Iron', n=6, up_hint=V(0, 1, 0), tip=V(0, 0, 0.8))  # fuller
finalize(P, 'Sword', None, subdiv_len=10)

P = Part()
SC = [(0.12, 0.042, 0.019), (0.5, 0.038, 0.017), (0.95, 0.03, 0.014)]
tube(P, [V(0, 0, z) for z, _, _ in SC], [(w, t) for _, w, t in SC], 'Leather', n=12, up_hint=V(0, 1, 0), tip=V(0, 0, 1.02))
tube(P, [V(0, 0, 0.11), V(0, 0, 0.16)], [(0.047, 0.023), (0.046, 0.022)], 'Iron', n=12, up_hint=V(0, 1, 0))  # locket
tube(P, [V(0, 0, 0.9), V(0, 0, 0.99)], [(0.034, 0.017), (0.025, 0.013)], 'Iron', n=12, up_hint=V(0, 1, 0), tip=V(0, 0, 1.035))  # chape
finalize(P, 'Scabbard', None)

# ------------------------------------------------------------------ realism pass: baked AO + weathering into the vertex colours
def bake_and_weather():
    rest = {}
    pose = {'ShoulderL': (0, 0, 0.42), 'ShoulderR': (0, 0, -0.42), 'HipL': (0, 0, 0.1), 'HipR': (0, 0, -0.1)}  # open the arms so the torso isn't shadowed by them
    for k, (x, y, z) in pose.items():
        ob = bpy.data.objects[k]; rest[k] = tuple(ob.rotation_euler); ob.rotation_euler = (x, -z, y)
    for k in ('Sword', 'Scabbard'):
        bpy.data.objects[k].location = (10, 0, 0)  # out of the way
    world = bpy.data.worlds.new('BakeWorld'); scn.world = world
    world.light_settings.distance = 0.12
    scn.render.engine = 'CYCLES'; scn.cycles.device = 'CPU'; scn.cycles.samples = 48
    scn.render.bake.target = 'VERTEX_COLORS'
    for ob in OBJS:
        ob.data.color_attributes.new('AO', 'FLOAT_COLOR', 'POINT')
        ob.data.color_attributes.active_color = ob.data.color_attributes['AO']
    bpy.ops.object.select_all(action='DESELECT')
    for ob in OBJS:
        ob.select_set(True)
    bpy.context.view_layer.objects.active = OBJS[0]
    bpy.ops.object.bake(type='AO')
    vals = [d.color[0] for ob in OBJS for d in ob.data.color_attributes['AO'].data]
    print('AO bake: min %.2f mean %.2f max %.2f' % (min(vals), sum(vals) / len(vals), max(vals)))
    bpy.context.view_layer.update()
    dust = Vector((0.78, 0.7, 0.58)); rust = Vector((0.8, 0.52, 0.36))
    for ob in OBJS:
        me = ob.data; col = me.color_attributes['Col'].data; ao = me.color_attributes['AO'].data
        vmat = [0] * len(me.vertices)
        for poly in me.polygons:
            for vi in poly.vertices:
                vmat[vi] = poly.material_index
        mw = ob.matrix_world
        for i, v in enumerate(me.vertices):
            w = mw @ v.co  # blender space, Z up
            a = ao[i].color[0]
            occ = 0.32 + 0.68 * (max(0.0, min(1.0, a)) ** 0.85)
            c = Vector(col[i].color[:3]) * occ
            c *= 1 + 0.13 * noise.noise(w * 9.0) + 0.06 * noise.noise(w * 40.0)  # grime and blotches
            mat = MAT_ORDER[vmat[i]]
            if ob.name not in ('Sword', 'Scabbard'):
                k = max(0.0, min(1.0, (0.5 - w.z) / 0.45)) * 0.75  # road dust creeping up from the boots
                c = Vector(ci * (1 - k + k * di) for ci, di in zip(c, dust))
            if mat in ('Steel', 'Iron', 'Mail'):
                r = max(0.0, min(1.0, (1 - a) * 0.9 + 0.35 * noise.noise(w * 14.0)))  # rust settles where it stays damp
                c = Vector(ci * (1 - r + r * ri) for ci, ri in zip(c, rust))
            col[i].color = (*c, 1.0)
        me.color_attributes.remove(me.color_attributes['AO'])
        me.color_attributes.active_color = me.color_attributes['Col']
    for k, r in rest.items():
        bpy.data.objects[k].rotation_euler = r
    for k in ('Sword', 'Scabbard'):
        bpy.data.objects[k].location = (0, 0, 0)


bake_and_weather()

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
    for k, (x, y, z) in pose.items():  # game euler (x, y, z) -> blender: rotate about game Y == blender Z
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
    for name, pos, tgt in (('front3q', (1.6, -2.6, 1.5), (0, 0, 1.05)), ('back3q', (-1.8, 2.4, 1.6), (0, 0, 1.05)), ('face', (0.55, -1.25, 1.88), (0.06, 0, 1.79)), ('faceside', (1.3, -0.25, 1.85), (0.06, 0, 1.79)),
                           ('hands', (0.6, -1.0, 1.2), (-0.2, 0, 1.0))):
        cam.location = pos
        cam.rotation_euler = (Vector(tgt) - Vector(pos)).to_track_quat('-Z', 'Y').to_euler()
        scn.render.filepath = os.path.join(PREVIEW, f'hero_{name}.png')
        bpy.ops.render.render(write_still=True)
    print('PREVIEW', PREVIEW)
