//! サムネイル生成。長辺512px、JPEG q80、アプリデータ領域へ書き出す。
//! 元写真は読むだけ。EXIF Orientationを反映する。

use image::imageops;
use std::path::{Path, PathBuf};

use crate::Result;

pub const THUMB_LONG_EDGE: u32 = 512;

/// photo_id をファイル名にして out_dir/thumbs/ 配下へ生成。生成済みならスキップ。
/// 戻り値は out_dir 基準の相対パス。
pub fn generate(
    src: &Path,
    orientation: Option<i64>,
    out_dir: &Path,
    photo_id: i64,
) -> Result<String> {
    let rel = format!("thumbs/{}.jpg", photo_id);
    let dest = out_dir.join(&rel);
    if dest.exists() {
        return Ok(rel);
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let img = image::open(src)?;
    let (w, h) = (img.width(), img.height());
    let (nw, nh) = if w >= h {
        let nw = THUMB_LONG_EDGE.min(w);
        (nw, (h as u64 * nw as u64 / w as u64).max(1) as u32)
    } else {
        let nh = THUMB_LONG_EDGE.min(h);
        ((w as u64 * nh as u64 / h as u64).max(1) as u32, nh)
    };
    let mut resized = img.resize(nw, nh, imageops::FilterType::Triangle);

    // EXIF Orientation (1=そのまま, 3=180°, 6=右90°, 8=左90°, 2/4/5/7=ミラー系)
    resized = match orientation.unwrap_or(1) {
        2 => resized.fliph(),
        3 => resized.rotate180(),
        4 => resized.flipv(),
        5 => resized.rotate90().fliph(),
        6 => resized.rotate90(),
        7 => resized.rotate270().fliph(),
        8 => resized.rotate270(),
        _ => resized,
    };

    // 一時ファイルに書いてからrename(中断時の壊れたサムネイル防止)
    let tmp: PathBuf = dest.with_extension("jpg.tmp");
    {
        let mut out = std::io::BufWriter::new(std::fs::File::create(&tmp)?);
        let enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 80);
        resized.write_with_encoder(enc)?;
    }
    std::fs::rename(&tmp, &dest)?;
    Ok(rel)
}
