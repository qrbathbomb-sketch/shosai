# -*- coding: utf-8 -*-
import sys, subprocess
from PIL import Image, ImageDraw, ImageFont

W, H, FPS, DUR = 1080, 1920, 30, 60.0
FONT = "/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf"
TITLE = "世界一オーロラが見える街"

# (start, end, [line1, line2])
CARDS = [
    (0.5,  5.0,  ["オーロラを見たいなら", "北へ行けばいいと思ってない？"]),
    (5.0,  10.0, ["こっちがノルウェーのトロムソ", "北緯69度"]),
    (10.0, 14.5, ["そしてこっちが", "カナダのイエローナイフ"]),
    (14.5, 20.0, ["北緯62度", "トロムソより700km以上も南"]),
    (20.0, 25.5, ["なのにオーロラが見える確率は", "イエローナイフの方が高い"]),
    (25.5, 31.0, ["理由は地磁気の北極が", "カナダ側に寄っているから"]),
    (31.0, 36.0, ["地理的には南でも", "地磁気緯度は約68度"]),
    (36.0, 41.0, ["つまりオーロラベルトの", "ほぼ真下にある"]),
    (41.0, 45.5, ["さらに内陸で乾燥していて", "晴天率が高い"]),
    (45.5, 50.0, ["湖のほとりで山が無く", "地平線まで見渡せる"]),
    (50.0, 55.0, ["3泊すれば95%以上の確率で", "これが見られる"]),
    (55.0, 58.0, ["あなたは見に行きたい？"]),
    (58.0, 60.0, ["コメントで教えて"]),
]

f_title = ImageFont.truetype(FONT, 58)
f_cap   = ImageFont.truetype(FONT, 66)

def measure(d, txt, font, sw):
    b = d.textbbox((0, 0), txt, font=font, stroke_width=sw)
    return b[2] - b[0], b[3] - b[1]

# --- 固定の黒帯タイトルを一度だけ作る ---
_probe = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
tw, th = measure(_probe, TITLE, f_title, 2)
PAD_X, PAD_Y = 34, 22
box_w, box_h = tw + PAD_X * 2, th + PAD_Y * 2
box_x, box_y = (W - box_w) // 2, 168

title_layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
dt = ImageDraw.Draw(title_layer)
dt.rounded_rectangle([box_x, box_y, box_x + box_w, box_y + box_h],
                     radius=16, fill=(10, 10, 10, 235))
for dx, dy in ((-2, 0), (2, 0), (0, -2), (0, 2), (-1, -1), (1, 1), (0, 0)):
    dt.text((W // 2 + dx, box_y + box_h // 2 + dy), TITLE, font=f_title,
            fill=(255, 255, 255, 255), anchor="mm")

CAP_Y = 700          # キャプション1行目の中心
LINE_H = 96
REVEAL = 0.55        # タイプライターに使う秒数

def card_at(t):
    for s, e, lines in CARDS:
        if s <= t < e:
            return s, e, lines
    return None

def render(t):
    img = title_layer.copy()
    c = card_at(t)
    if c:
        s, e, lines = c
        full = "".join(lines)
        n = len(full)
        prog = (t - s) / REVEAL
        shown = n if prog >= 1.0 else max(1, int(n * prog))
        d = ImageDraw.Draw(img)
        used = 0
        for i, line in enumerate(lines):
            if used >= shown:
                break
            part = line[: max(0, shown - used)]
            used += len(line)
            if not part:
                continue
            y = CAP_Y + i * LINE_H
            d.text((W // 2, y), part, font=f_cap, fill=(255, 255, 255, 255),
                   anchor="mm", stroke_width=9, stroke_fill=(0, 0, 0, 255))
            for dx, dy in ((-2, 0), (2, 0), (0, -2), (0, 2), (-1, -1), (1, 1), (0, 0)):
                d.text((W // 2 + dx, y + dy), part, font=f_cap,
                       fill=(255, 255, 255, 255), anchor="mm")
    return img

FF = "/usr/local/lib/python3.11/dist-packages/imageio_ffmpeg/binaries/ffmpeg-linux-x86_64-v7.0.2"
OUT = "/tmp/claude-0/-home-user-shosai/b1aa29f8-f81e-5edb-8dad-b975802c6224/scratchpad/out"
subprocess.run(["mkdir", "-p", OUT], check=True)

cmd = [FF, "-y", "-hide_banner", "-loglevel", "error",
       "-f", "rawvideo", "-pix_fmt", "rgba", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
       "-filter_complex",
       f"color=c=0x00FF00:s={W}x{H}:r={FPS}[g];"
       f"color=c=0x141C28:s={W}x{H}:r={FPS}[d];"
       "[0:v]split=2[a][b];"
       "[g][a]overlay=shortest=1,format=yuv420p[green];"
       "[d][b]overlay=shortest=1,format=yuv420p[prev]",
       "-map", "[green]", "-c:v", "libx264", "-preset", "medium", "-crf", "16",
       "-t", str(DUR), f"{OUT}/telop_greenscreen.mp4",
       "-map", "[prev]", "-c:v", "libx264", "-preset", "medium", "-crf", "20",
       "-t", str(DUR), f"{OUT}/telop_preview.mp4"]

p = subprocess.Popen(cmd, stdin=subprocess.PIPE)
total = int(DUR * FPS)
for i in range(total):
    p.stdin.write(render(i / FPS).tobytes())
    if i % 300 == 0:
        print(f"{i}/{total}", file=sys.stderr, flush=True)
p.stdin.close()
print("ffmpeg rc =", p.wait())
