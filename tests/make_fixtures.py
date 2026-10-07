"""Synthetic ULD tag images for pipeline smoke tests.
These are NOT a substitute for real photos: they prove the plumbing works,
not that OCR accuracy is acceptable on real containers."""
import random, sys, json
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageEnhance
import numpy as np

random.seed(7); np.random.seed(7)
BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
COND = "/usr/share/fonts/truetype/dejavu/DejaVuSansCondensed-Bold.ttf"
W, H = 1280, 720

def panel(base=200, ribs=False):
    a = np.full((H, W), base, dtype=np.float32)
    a += np.linspace(-18, 18, W)[None, :]           # uneven lighting
    a += np.random.normal(0, 4, (H, W))             # sensor noise
    if ribs:
        for x in range(0, W, 90): a[:, x:x+3] -= 25
    for _ in range(40):                              # scratches
        x, y = random.randrange(W), random.randrange(H)
        a[y:y+1, x:x+random.randrange(20, 160)] -= random.randrange(10, 30)
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8)).convert("RGB")

def spaced(draw, xy, text, font, fill, spacing):
    x, y = xy
    for ch in text:
        draw.text((x, y), ch, font=font, fill=fill)
        x += draw.textlength(ch, font=font) + spacing
    return x

def stencil(img, box, gap=3):
    """Cut bridges through the lettering like a stencil."""
    d = ImageDraw.Draw(img); x0, y0, x1, y1 = box
    bg = img.getpixel((x0 - 4, y0 - 4))
    d.rectangle([x0, (y0 + y1) // 2 - gap // 2, x1, (y0 + y1) // 2 + gap // 2], fill=bg)

def make(name, uld, size=110, spacing=14, pos=(170, 290), base=200, ink=(25, 25, 30), font=BOLD,
         extra=True, rot=0, blur=0, dim=1.0, glare=False, ribs=False, sten=False, uld2=None, invert=False):
    img = panel(base, ribs)
    if invert:
        img = Image.new("RGB", (W, H), (20, 45, 110)); ink = (240, 240, 240)
    d = ImageDraw.Draw(img); f = ImageFont.truetype(font, size)
    x_end = spaced(d, pos, uld, f, ink, spacing)
    if sten: stencil(img, (pos[0], pos[1] + int(size * .22), int(x_end), pos[1] + int(size * 1.0)))
    if uld2:
        spaced(d, (pos[0] + 40, pos[1] + size + 120), uld2, ImageFont.truetype(font, int(size * .8)), ink, spacing)
    if extra:
        small = ImageFont.truetype(COND, 34)
        d.text((pos[0], pos[1] - 110), "TELEPORT   MAX GROSS WT 1588 KG", font=small, fill=ink)
        d.text((pos[0], H - 110), "TARE 82 KG    IATA LD3", font=small, fill=ink)
    if rot: img = img.rotate(rot, resample=Image.BICUBIC, fillcolor=(base,) * 3)
    if blur: img = img.filter(ImageFilter.GaussianBlur(blur))
    if dim != 1.0: img = ImageEnhance.Brightness(img).enhance(dim)
    if glare:
        a = np.asarray(img).astype(np.float32)
        yy, xx = np.mgrid[0:H, 0:W]
        a += (260 * np.exp(-(((xx - 900) / 170) ** 2 + ((yy - 300) / 120) ** 2)))[..., None]
        img = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))
    img.save(f"fixtures/{name}.png")

cases = [
    ("clean_ai", dict(uld="AKE1234AI"), ["AKE1234AI"]),
    ("clean_std", dict(uld="AKE79210R7", size=100), ["AKE79210R7"]),
    ("aay_small", dict(uld="AAY56789MH", size=64, spacing=8, pos=(380, 330)), ["AAY56789MH"]),
    ("akh_stencil", dict(uld="AKH24680SV".replace("0SV", "SV"), sten=True), ["AKH2468SV"]),
    ("wide_spacing", dict(uld="AKE33735R7", size=90, spacing=34, pos=(90, 300)), ["AKE33735R7"]),
    ("rotated", dict(uld="AKE10586MH", rot=6, size=95), ["AKE10586MH"]),
    ("blurred", dict(uld="AKE45012D7", blur=2.2, size=100), ["AKE45012D7"]),
    ("low_light", dict(uld="AAY30117AK", dim=0.28, size=100), ["AAY30117AK"]),
    ("glare", dict(uld="AKE77410MH", glare=True, size=95), ["AKE77410MH"]),
    ("ribbed", dict(uld="AKE60233AK", ribs=True, size=100), ["AKE60233AK"]),
    ("inverted", dict(uld="AKH5521AI", invert=True), ["AKH5521AI"]),
    ("pallet", dict(uld="PMC12345MH", size=100), ["PMC12345MH"]),
    ("two_ulds", dict(uld="AKE1234AI", uld2="AAY56789MH", size=90, pos=(170, 150), extra=False), ["AKE1234AI", "AAY56789MH"]),
    ("sugg", dict(uld="AKE5678A1"), ["AKE5678A1"]),
    ("review", dict(uld="AAY22222XX", size=100), ["AAY22222XX"]),
    ("rej", dict(uld="AKE30303MH", size=100), ["AKE30303MH"]),
    ("no_uld", dict(uld="CARGO ONLY", size=90), []),
]
manifest = []
# "glare" washes out part of the number on purpose: the correct outcome is
# an unreadable (INVALID) result that staff can edit, never a guessed number.
for name, kw, expect in cases:
    make(name, **kw)
    manifest.append({"name": name, "expect": [] if name == "glare" else expect, **({"unreadable": True} if name == "glare" else {})})
json.dump(manifest, open("fixtures/manifest.json", "w"), indent=1)
print(len(manifest), "fixtures")
