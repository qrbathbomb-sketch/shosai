//! 走査エンジン。
//! - 元ファイルはopen(読み取り)のみ。シンボリックリンクは辿らない。
//! - 冪等: (size, mtime)一致はスキップ → 再実行がそのまま差分走査・中断再開になる。
//! - 重い処理(EXIF・ハッシュ)はrayonで並列、DB書き込みは単一スレッドでバッチ。

use rayon::prelude::*;
use rusqlite::Connection;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::SystemTime;
use walkdir::WalkDir;

use crate::db::{self, PhotoUpsert};
use crate::exif_read;
use crate::hash;
use crate::volume;
use crate::{FileKind, Result};

#[derive(Debug, Default, Clone, serde::Serialize)]
pub struct ScanStats {
    pub files_seen: u64,
    pub images_new: u64,
    pub images_updated: u64,
    pub unchanged: u64,
    pub raw_count: u64,
    pub heic_count: u64,
    pub errors: u64,
    pub marked_missing: u64,
    pub cancelled: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
pub enum ScanEvent {
    Started { root: String },
    Progress { files_seen: u64, indexed: u64 },
    FoundYear { year: i32 },
    Finished { stats: ScanStats },
}

pub type ProgressFn = dyn Fn(ScanEvent) + Send + Sync;

struct Candidate {
    abs: PathBuf,
    rel: String,
    size: u64,
    mtime: i64,
    kind: FileKind,
}

struct Processed {
    cand: Candidate,
    exif: exif_read::ExifSummary,
    partial_hash: Option<String>,
}

/// rootを走査してDBへインデックスする。何度実行しても安全(冪等)。
pub fn scan_root(
    conn: &mut Connection,
    root: &Path,
    cancel: &Arc<AtomicBool>,
    progress: &ProgressFn,
) -> Result<ScanStats> {
    let root = root.canonicalize()?;
    let vol = volume::identify(&root);
    let volume_id = db::upsert_volume(
        conn,
        &vol.uuid,
        &vol.label,
        &vol.mount_point.to_string_lossy(),
    )?;
    let root_rel = volume::to_rel_path(&vol, &root).unwrap_or_default();
    db::upsert_root(conn, volume_id, &root_rel, &root.to_string_lossy())?;

    progress(ScanEvent::Started {
        root: root.to_string_lossy().to_string(),
    });

    let mut stats = ScanStats::default();
    let mut seen_ids: Vec<i64> = Vec::new();
    let mut to_process: Vec<Candidate> = Vec::new();

    // 1) 列挙 + 差分判定(DBアクセスは単一スレッド)
    for entry in WalkDir::new(&root).follow_links(false).into_iter() {
        if cancel.load(Ordering::Relaxed) {
            stats.cancelled = true;
            break;
        }
        let entry = match entry {
            Ok(e) => e,
            Err(_) => {
                stats.errors += 1;
                continue;
            }
        };
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let ext = match path.extension().and_then(|e| e.to_str()) {
            Some(e) => e,
            None => continue,
        };
        let kind = match FileKind::from_ext(ext) {
            Some(k) => k,
            None => continue,
        };
        stats.files_seen += 1;
        match kind {
            FileKind::Raw => stats.raw_count += 1,
            FileKind::Heic => stats.heic_count += 1,
            FileKind::Image => {}
        }

        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => {
                stats.errors += 1;
                continue;
            }
        };
        let size = meta.len();
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);

        let rel = match volume::to_rel_path(&vol, path) {
            Some(r) => r,
            None => {
                stats.errors += 1;
                continue;
            }
        };

        match db::find_unchanged(conn, volume_id, &rel)? {
            Some((id, db_size, db_mtime)) if db_size == size as i64 && db_mtime == mtime => {
                stats.unchanged += 1;
                db::touch_present(conn, id)?;
                seen_ids.push(id);
            }
            existing => {
                if existing.is_some() {
                    stats.images_updated += 1;
                } else {
                    stats.images_new += 1;
                }
                to_process.push(Candidate {
                    abs: path.to_path_buf(),
                    rel,
                    size,
                    mtime,
                    kind,
                });
            }
        }

        if stats.files_seen % 500 == 0 {
            progress(ScanEvent::Progress {
                files_seen: stats.files_seen,
                indexed: seen_ids.len() as u64,
            });
        }
    }

    // 2) EXIF・部分ハッシュを並列処理(チャンク単位でDBへバッチ書き込み)
    let mut reported_years: std::collections::HashSet<i32> = std::collections::HashSet::new();
    for chunk in to_process.chunks(256) {
        if cancel.load(Ordering::Relaxed) {
            stats.cancelled = true;
            break;
        }
        let processed: Vec<Processed> = chunk
            .par_iter()
            .map(|c| {
                let exif = if c.kind == FileKind::Image {
                    exif_read::read_exif(&c.abs)
                } else {
                    exif_read::ExifSummary::default()
                };
                let partial_hash = hash::partial_hash(&c.abs, c.size).ok();
                Processed {
                    cand: Candidate {
                        abs: c.abs.clone(),
                        rel: c.rel.clone(),
                        size: c.size,
                        mtime: c.mtime,
                        kind: c.kind,
                    },
                    exif,
                    partial_hash,
                }
            })
            .collect();

        let tx = conn.transaction()?;
        for p in &processed {
            let id = db::upsert_photo(
                &tx,
                &PhotoUpsert {
                    volume_id,
                    rel_path: &p.cand.rel,
                    file_size: p.cand.size as i64,
                    mtime: p.cand.mtime,
                    kind: p.cand.kind.as_str(),
                    taken_at: p.exif.taken_at.clone(),
                    camera_model: p.exif.camera_model.clone(),
                    gps_lat: p.exif.gps_lat,
                    gps_lon: p.exif.gps_lon,
                    orientation: p.exif.orientation,
                    partial_hash: p.partial_hash.clone(),
                },
            )?;
            seen_ids.push(id);
            if let Some(t) = &p.exif.taken_at {
                if let Ok(year) = t[0..4].parse::<i32>() {
                    if reported_years.insert(year) {
                        progress(ScanEvent::FoundYear { year });
                    }
                }
            }
        }
        tx.commit()?;
        progress(ScanEvent::Progress {
            files_seen: stats.files_seen,
            indexed: seen_ids.len() as u64,
        });
    }

    // 3) 消えたファイルをmissingへ(キャンセル時はスキップ: 未走査分を誤ってmissingにしない)
    if !stats.cancelled {
        stats.marked_missing =
            db::mark_missing_except(conn, volume_id, &root_rel, &seen_ids)? as u64;
    }

    progress(ScanEvent::Finished {
        stats: stats.clone(),
    });
    Ok(stats)
}
