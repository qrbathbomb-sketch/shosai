//! shosai-core: 走査・DB・サムネイルのコア。
//!
//! 安全原則: 元写真は読み取り専用。このクレートが書き込むのは
//! アプリデータ領域(DB・サムネイル)とテストデータ生成先のみ。

pub mod batch;
pub mod db;
pub mod exif_read;
pub mod hash;
pub mod scan;
pub mod score;
pub mod thumb;
pub mod volume;

use thiserror::Error;

#[derive(Debug, Error)]
pub enum CoreError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("db error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("image error: {0}")]
    Image(#[from] image::ImageError),
    #[error("{0}")]
    Other(String),
}

pub type Result<T> = std::result::Result<T, CoreError>;

/// 対応ファイル種別。RAW/HEICはMVPでは計数のみ(サムネイル・EXIFなし)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileKind {
    Image,
    Raw,
    Heic,
}

impl FileKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            FileKind::Image => "image",
            FileKind::Raw => "raw",
            FileKind::Heic => "heic",
        }
    }

    pub fn from_ext(ext: &str) -> Option<FileKind> {
        let e = ext.to_ascii_lowercase();
        match e.as_str() {
            "jpg" | "jpeg" | "png" | "tif" | "tiff" => Some(FileKind::Image),
            "cr2" | "cr3" | "nef" | "arw" | "orf" | "rw2" | "dng" | "raf" | "pef" | "srw" => {
                Some(FileKind::Raw)
            }
            "heic" | "heif" => Some(FileKind::Heic),
            _ => None,
        }
    }
}
