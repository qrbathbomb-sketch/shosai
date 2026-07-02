//! 部分ハッシュ: blake3(先頭64KB + 末尾64KB + ファイルサイズ)。
//! 移動・改名の追跡と再インデックス用。全体ハッシュは使わない(コスト対効果)。

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

const CHUNK: u64 = 64 * 1024;

pub fn partial_hash(path: &Path, file_size: u64) -> std::io::Result<String> {
    let mut f = File::open(path)?;
    let mut hasher = blake3::Hasher::new();
    let mut buf = vec![0u8; CHUNK as usize];

    let head = f.read(&mut buf)?;
    hasher.update(&buf[..head]);

    if file_size > CHUNK * 2 {
        f.seek(SeekFrom::End(-(CHUNK as i64)))?;
        let tail = f.read(&mut buf)?;
        hasher.update(&buf[..tail]);
    }
    hasher.update(&file_size.to_le_bytes());
    Ok(hasher.finalize().to_hex().to_string())
}
