"""Draws the Jivvy Life logo (1024px PNG). Rendered at 4x and downsampled for smooth edges."""
from PIL import Image, ImageDraw

S = 4                      # supersampling factor
N = 1024 * S
def p(v): return int(v * S)

def gradient(size, c1, c2):
    """Diagonal top-left -> bottom-right gradient."""
    g = Image.new("RGB", (256, 256))
    px = g.load()
    for y in range(256):
        for x in range(256):
            t = (x + y) / 510
            px[x, y] = tuple(round(a + (b - a) * t) for a, b in zip(c1, c2))
    return g.resize((size, size), Image.BICUBIC)

img = Image.new("RGBA", (N, N), (0, 0, 0, 0))
mask = Image.new("L", (N, N), 0)
ImageDraw.Draw(mask).rounded_rectangle([p(40), p(40), p(984), p(984)], radius=p(220), fill=255)
img.paste(gradient(N, (99, 102, 241), (139, 92, 246)), (0, 0), mask)   # indigo-500 -> violet-500

d = ImageDraw.Draw(img)
white = (255, 255, 255, 255)
w = 128                                               # stroke width
# "J": stem, then a hook curving left along the bottom, with rounded caps.
d.rectangle([p(600 - w / 2), p(250), p(600 + w / 2), p(620)], fill=white)
cx, cy, r_out = 466, 620, 134 + w / 2                  # hook centre; outer radius
d.arc([p(cx - r_out), p(cy - r_out), p(cx + r_out), p(cy + r_out)], 0, 180, fill=white, width=p(w))
d.ellipse([p(600 - w / 2), p(250 - w / 2), p(600 + w / 2), p(250 + w / 2)], fill=white)
lx = cx - (r_out - w / 2)
d.ellipse([p(lx - w / 2), p(cy - w / 2), p(lx + w / 2), p(cy + w / 2)], fill=white)

# Spark: a four-point star, top right.
sx, sy, R, r = 790, 300, 96, 26
amber = (251, 191, 36, 255)
d.polygon([(p(sx), p(sy - R)), (p(sx + r), p(sy - r)), (p(sx + R), p(sy)), (p(sx + r), p(sy + r)),
           (p(sx), p(sy + R)), (p(sx - r), p(sy + r)), (p(sx - R), p(sy)), (p(sx - r), p(sy - r))], fill=amber)

img.resize((1024, 1024), Image.LANCZOS).save("logo-1024.png")
print("wrote logo-1024.png")
