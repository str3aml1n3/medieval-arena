# The game icon: a gold sword over the Thornbeak's three red claw marks on a dark iron heater shield.
# Writes favicon.ico (16-256 px), apple-touch-icon.png (180 px) and icon-512.png.
# Usage: python3 tools/build_icon.py <output folder>   (needs Pillow)
from PIL import Image, ImageDraw, ImageFilter
import sys
S = 1024
def icon():
    im = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    # heater shield: dark iron with a gold rim
    def shield(inset):
        w0, w1, top, mid, bot = 120 + inset, S - 120 - inset, 70 + inset, 560, S - 50 - inset
        pts = [(w0, top), (w1, top), (w1, mid)]
        import math
        mid = top + (bot - top) * 0.42
        for i in range(1, 25):  # convex lower edge sweeping in to the point (a heater shield)
            a = i / 24 * math.pi / 2
            pts.append((S / 2 + (w1 - S / 2) * math.cos(a) ** 0.8, mid + (bot - mid) * math.sin(a)))
        for i in range(23, 0, -1):
            a = i / 24 * math.pi / 2
            pts.append((S / 2 - (S / 2 - w0) * math.cos(a) ** 0.8, mid + (bot - mid) * math.sin(a)))
        pts.append((w0, mid))
        return pts
    d.polygon(shield(0), fill=(214, 170, 92, 255))           # gold rim
    d.polygon(shield(34), fill=(58, 30, 22, 255))            # dark rim shadow
    d.polygon(shield(48), fill=(34, 24, 20, 255))            # iron field
    # subtle lit top-left of the field
    glow = Image.new('L', (S, S), 0); g = ImageDraw.Draw(glow)
    g.ellipse((150, 60, 700, 520), fill=70); glow = glow.filter(ImageFilter.GaussianBlur(120))
    mask = Image.new('L', (S, S), 0); ImageDraw.Draw(mask).polygon(shield(48), fill=255)
    from PIL import ImageChops
    glow = ImageChops.multiply(glow, mask)
    im.paste((120, 92, 70, 255), (0, 0), glow)
    # three red claw slashes behind the sword (the Thornbeak's mark)
    for k, off in enumerate((-150, 0, 150)):
        sl = Image.new('L', (S, S), 0); sd = ImageDraw.Draw(sl)
        x0 = S / 2 + off
        sd.polygon([(x0 - 120, 250), (x0 - 70, 230), (x0 + 130, 720), (x0 + 95, 740)], fill=255)
        sl = ImageChops.multiply(sl.filter(ImageFilter.GaussianBlur(3)), mask)
        im.paste((168, 30, 22, 255), (0, 0), sl)
    # sword, point down, gold-steel
    cx = S / 2
    d.polygon([(cx - 34, 300), (cx + 34, 300), (cx + 34, 760), (cx, 880), (cx - 34, 760)], fill=(232, 222, 200, 255))  # blade
    d.polygon([(cx, 300), (cx + 34, 300), (cx + 34, 760), (cx, 880)], fill=(176, 166, 150, 255))                          # shaded half (diamond section)
    d.rounded_rectangle((cx - 170, 250, cx + 170, 302), radius=20, fill=(222, 178, 96, 255))                            # crossguard
    d.rectangle((cx - 22, 120, cx + 22, 252), fill=(92, 56, 34, 255))                                                   # grip
    for y in range(132, 250, 26): d.line((cx - 22, y, cx + 22, y + 12), fill=(60, 36, 22, 255), width=8)
    d.ellipse((cx - 52, 62, cx + 52, 150), fill=(222, 178, 96, 255))                                                     # wheel pommel
    d.ellipse((cx - 22, 92, cx + 22, 122), fill=(150, 108, 52, 255))
    return im
big = icon()
sizes = [16, 24, 32, 48, 64, 128, 256]
out = sys.argv[1]
frames = []
for s in sizes:
    f = big.resize((s, s), Image.LANCZOS)
    if s <= 32:  # small sizes: a touch of sharpening so the sword stays readable
        f = f.filter(ImageFilter.UnsharpMask(radius=1, percent=80, threshold=1))
    frames.append(f)
frames[-1].save(out + '/favicon.ico', sizes=[(s, s) for s in sizes], append_images=frames[:-1])
big.resize((180, 180), Image.LANCZOS).save(out + '/apple-touch-icon.png')
big.resize((512, 512), Image.LANCZOS).save(out + '/icon-512.png')


