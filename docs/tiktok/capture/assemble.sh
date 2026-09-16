#!/usr/bin/env bash
# Earth Studio の連番PNG、または画面録画を TikTok 用の 9:16 / 30fps / 60秒 に組む。
#
#   ./assemble.sh footage/ out.mp4        # 連番PNG のディレクトリ
#   ./assemble.sh screen.mov out.mp4      # 画面録画ファイル
#
# 環境変数:
#   CROP=1    16:9 の素材をセンタークロップして 9:16 にする（既定: 自動判定）
#   DUR=60    尺（秒）
#   FPS=30    フレームレート
set -euo pipefail

SRC="${1:?使い方: ./assemble.sh <連番PNGのディレクトリ | 動画ファイル> <出力.mp4>}"
OUT="${2:?出力ファイル名を指定してください}"
FPS="${FPS:-30}"
DUR="${DUR:-60}"
W=1080
H=1920

command -v ffmpeg >/dev/null || { echo "ffmpeg が見つかりません。brew install ffmpeg"; exit 1; }

# 9:16 に収める。素材が横長ならセンタークロップ、縦長なら短辺基準でフィット。
VF="scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,fps=${FPS}"

if [ -d "$SRC" ]; then
  # 連番PNG。Earth Studio の既定は footage_000.png 形式
  PATTERN=$(find "$SRC" -maxdepth 1 -name '*.png' | head -1 | sed -E 's/[0-9]+\.png$/%04d.png/')
  FIRST=$(find "$SRC" -maxdepth 1 -name '*.png' | sort | head -1)
  START=$(basename "$FIRST" | grep -oE '[0-9]+\.png$' | grep -oE '^[0-9]+' | sed 's/^0*//')
  echo "連番PNG: ${PATTERN}  開始番号: ${START:-0}"
  ffmpeg -y -hide_banner \
    -framerate "$FPS" -start_number "${START:-0}" -i "$PATTERN" \
    -vf "$VF" -t "$DUR" \
    -c:v libx264 -preset slow -crf 17 -pix_fmt yuv420p -movflags +faststart \
    "$OUT"
else
  echo "動画ファイル: $SRC"
  ffmpeg -y -hide_banner \
    -i "$SRC" \
    -vf "$VF" -t "$DUR" \
    -c:v libx264 -preset slow -crf 17 -pix_fmt yuv420p -movflags +faststart \
    -an "$OUT"
fi

echo "---"
ffmpeg -hide_banner -i "$OUT" 2>&1 | grep -E 'Duration|Stream'
echo "完成: $OUT"
