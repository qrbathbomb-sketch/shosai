# 写真の書斎 (shosai)

## 一行説明

ローカルドライブに眠っている大量の写真を、負担なく少しずつ「発掘」し、本人の一言を添えた小さな作品「しおり」に変えていくデスクトップアプリ(開発中)。

## ブラウザ版

https://qrbathbomb-sketch.github.io/shosai/ (Chrome/Edgeで、自分のローカルフォルダをそのまま読み取れる。写真はブラウザ内だけで処理し送信しない。デスクトップ版と同じ機能)

## 主な機能

- **フォルダを1つ選ぶだけで開始**: 読み取り専用走査(移動・変更・削除は一切しない)
- **「今日の発掘」**: 撮影日・フォルダ構造から毎回少数の写真をテーマ付きで提示(例: N年前の今月、ある一日の記録)
- **3択トリアージ**: 残したい / あとで / 今回は違う
- **行き先を選んで発掘**: 年・キーワード・枚数(5/10/20)を指定
- **おまかせセレクト**: 連写検出(EXIF時刻) + 風景色解析(空・緑・彩度) + 顔検出(デスクトップ版のみ, rustface, オフライン)で景色の良い写真候補を自動選抜
- **しおり**: 写真1〜3枚+一言から作る1ページの小さな作品。「書斎の棚」に蓄積

## 安全原則

- 元写真は読み取り専用
- 選んだフォルダ以外は走査しない
- ネットワーク送信なし(完全オフライン)
- 派生物(DB・サムネイル)はOSのアプリデータ領域のみ
- アプリを削除しても元写真に影響なし

## 技術構成

- Tauri 2 (デスクトップ)
- React + TypeScript + Vite
- Rust (walkdir, rayon, rusqlite, kamadak-exif, image, blake3, rustface)
- SQLite (デスクトップ)
- ブラウザ版: File System Access API + IndexedDB + exifr + canvas (同じUI・同じ機能、写真はブラウザ内のみ)

## 開発コマンド

```bash
npm install
npm run tauri dev                                              # デスクトップアプリ起動

npm run dev                                                     # ブラウザ版 (http://localhost:1420/、Chrome/Edge)

cargo run -p shosai-core --bin gen_test_photos -- <出力フォルダ>  # EXIF付きテスト写真生成

cargo run -p shosai-core --bin scan_cli -- <フォルダ> --data <データdir> --thumbs --report  # 走査エンジン単体テスト

cargo run -p shosai-core --bin scan_cli -- <フォルダ> --data <データdir> --thumbs --auto 8   # おまかせセレクト検証
```

## 対応形式

JPEG/PNG/TIFF (RAW/HEICは検出・計数のみ、対応予定)

## ステータス

MVP開発中。Windows/macOS向け。インストーラはGitHub Releasesから(タグpushで自動ビルド)

## ライセンス

MIT。ただし core/assets/seeta_fd_frontal_v1.0.bin はSeetaFace Engine由来のモデル(BSD, https://github.com/atomashpolskiy/rustface 経由)で、そのライセンス条件に従う
