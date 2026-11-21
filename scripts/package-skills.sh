#!/usr/bin/env bash
# skills/ 以下の各スキルを、ChatGPT / Claude.ai にそのままアップロードできる zip にする。
# 使い方: scripts/package-skills.sh [出力先ディレクトリ(既定: skills-dist)]
set -euo pipefail
cd "$(dirname "$0")/.."
out="${1:-skills-dist}"
rm -rf "$out" && mkdir -p "$out"
out="$(cd "$out" && pwd)"
for dir in skills/*/; do
  name="$(basename "$dir")"
  [ -f "$dir/SKILL.md" ] || { echo "skip: $name (SKILL.md なし)"; continue; }
  (cd skills && zip -qr "$out/$name.zip" "$name" -x '*.DS_Store')
  echo "packed: $out/$name.zip"
done
