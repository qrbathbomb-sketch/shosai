//! SQLiteスキーマとアクセス。写真の実体は保存しない(参照情報のみ)。

use rusqlite::{params, Connection};
use std::path::Path;

use crate::Result;

pub fn open(path: &Path) -> Result<Connection> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    migrate(&conn)?;
    Ok(conn)
}

fn migrate(conn: &Connection) -> Result<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version < 1 {
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS volumes (
                id INTEGER PRIMARY KEY,
                uuid TEXT NOT NULL UNIQUE,
                label TEXT,
                last_mount_path TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            -- ユーザーが選択した走査ルート(ボリューム内相対パス)
            CREATE TABLE IF NOT EXISTS roots (
                id INTEGER PRIMARY KEY,
                volume_id INTEGER NOT NULL REFERENCES volumes(id),
                rel_path TEXT NOT NULL,
                display_path TEXT NOT NULL,
                added_at TEXT NOT NULL DEFAULT (datetime('now')),
                UNIQUE(volume_id, rel_path)
            );

            CREATE TABLE IF NOT EXISTS photos (
                id INTEGER PRIMARY KEY,
                volume_id INTEGER NOT NULL REFERENCES volumes(id),
                rel_path TEXT NOT NULL,          -- ボリューム基準・'/'区切り
                file_size INTEGER NOT NULL,
                mtime INTEGER NOT NULL,          -- unix秒
                kind TEXT NOT NULL CHECK (kind IN ('image','raw','heic')),
                taken_at TEXT,                   -- 'YYYY-MM-DD HH:MM:SS' (EXIF由来)
                camera_model TEXT,
                gps_lat REAL,
                gps_lon REAL,
                orientation INTEGER,             -- EXIF Orientation (1-8)
                partial_hash TEXT,               -- blake3(先頭64K+末尾64K+size)
                status TEXT NOT NULL DEFAULT 'present' CHECK (status IN ('present','missing')),
                thumb_path TEXT,                 -- アプリデータ領域内の相対パス
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                UNIQUE(volume_id, rel_path)
            );
            CREATE INDEX IF NOT EXISTS idx_photos_taken_at ON photos(taken_at);
            CREATE INDEX IF NOT EXISTS idx_photos_status ON photos(status);

            PRAGMA user_version = 1;
            "#,
        )?;
    }
    if version < 2 {
        conn.execute_batch(
            r#"
            -- 3択トリアージ。写真1枚につき最新の判断のみ保持。
            -- keep=残したい / later=あとで / skip=今回は違う
            CREATE TABLE IF NOT EXISTS triage (
                photo_id INTEGER PRIMARY KEY REFERENCES photos(id),
                decision TEXT NOT NULL CHECK (decision IN ('keep','later','skip')),
                decided_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            PRAGMA user_version = 2;
            "#,
        )?;
    }
    Ok(())
}

pub fn set_triage(conn: &Connection, photo_id: i64, decision: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO triage (photo_id, decision) VALUES (?1, ?2)
         ON CONFLICT(photo_id) DO UPDATE SET decision=?2, decided_at=datetime('now')",
        params![photo_id, decision],
    )?;
    Ok(())
}

pub fn upsert_volume(conn: &Connection, uuid: &str, label: &str, mount_path: &str) -> Result<i64> {
    conn.execute(
        "INSERT INTO volumes (uuid, label, last_mount_path) VALUES (?1, ?2, ?3)
         ON CONFLICT(uuid) DO UPDATE SET label = ?2, last_mount_path = ?3",
        params![uuid, label, mount_path],
    )?;
    let id = conn.query_row(
        "SELECT id FROM volumes WHERE uuid = ?1",
        params![uuid],
        |r| r.get(0),
    )?;
    Ok(id)
}

pub fn upsert_root(conn: &Connection, volume_id: i64, rel_path: &str, display: &str) -> Result<i64> {
    conn.execute(
        "INSERT INTO roots (volume_id, rel_path, display_path) VALUES (?1, ?2, ?3)
         ON CONFLICT(volume_id, rel_path) DO UPDATE SET display_path = ?3",
        params![volume_id, rel_path, display],
    )?;
    let id = conn.query_row(
        "SELECT id FROM roots WHERE volume_id = ?1 AND rel_path = ?2",
        params![volume_id, rel_path],
        |r| r.get(0),
    )?;
    Ok(id)
}

/// (file_size, mtime) が一致すれば変更なしとみなす(差分走査の一次キー)。
pub fn find_unchanged(conn: &Connection, volume_id: i64, rel_path: &str) -> Result<Option<(i64, i64, i64)>> {
    let row = conn
        .query_row(
            "SELECT id, file_size, mtime FROM photos WHERE volume_id = ?1 AND rel_path = ?2",
            params![volume_id, rel_path],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other),
        })?;
    Ok(row)
}

pub struct PhotoUpsert<'a> {
    pub volume_id: i64,
    pub rel_path: &'a str,
    pub file_size: i64,
    pub mtime: i64,
    pub kind: &'a str,
    pub taken_at: Option<String>,
    pub camera_model: Option<String>,
    pub gps_lat: Option<f64>,
    pub gps_lon: Option<f64>,
    pub orientation: Option<i64>,
    pub partial_hash: Option<String>,
}

pub fn upsert_photo(conn: &Connection, p: &PhotoUpsert) -> Result<i64> {
    conn.execute(
        "INSERT INTO photos (volume_id, rel_path, file_size, mtime, kind, taken_at,
             camera_model, gps_lat, gps_lon, orientation, partial_hash, status)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,'present')
         ON CONFLICT(volume_id, rel_path) DO UPDATE SET
             file_size=?3, mtime=?4, kind=?5, taken_at=?6, camera_model=?7,
             gps_lat=?8, gps_lon=?9, orientation=?10, partial_hash=?11,
             status='present', updated_at=datetime('now')",
        params![
            p.volume_id, p.rel_path, p.file_size, p.mtime, p.kind, p.taken_at,
            p.camera_model, p.gps_lat, p.gps_lon, p.orientation, p.partial_hash
        ],
    )?;
    let id = conn.query_row(
        "SELECT id FROM photos WHERE volume_id = ?1 AND rel_path = ?2",
        params![p.volume_id, p.rel_path],
        |r| r.get(0),
    )?;
    Ok(id)
}

pub fn touch_present(conn: &Connection, id: i64) -> Result<()> {
    conn.execute(
        "UPDATE photos SET status='present', updated_at=datetime('now') WHERE id=?1 AND status!='present'",
        params![id],
    )?;
    Ok(())
}

/// 走査で見つからなかったファイルをmissingへ。削除はしない(元写真の移動・消失に備えて保持)。
pub fn mark_missing_except(
    conn: &Connection,
    volume_id: i64,
    root_rel_prefix: &str,
    seen_ids: &[i64],
) -> Result<usize> {
    // seen_idsを一時テーブルに入れて差分を取る
    conn.execute_batch("CREATE TEMP TABLE IF NOT EXISTS seen_ids (id INTEGER PRIMARY KEY); DELETE FROM seen_ids;")?;
    {
        let mut stmt = conn.prepare("INSERT OR IGNORE INTO seen_ids (id) VALUES (?1)")?;
        for id in seen_ids {
            stmt.execute(params![id])?;
        }
    }
    let prefix = if root_rel_prefix.is_empty() {
        "".to_string()
    } else {
        format!("{}/", root_rel_prefix)
    };
    let n = conn.execute(
        "UPDATE photos SET status='missing', updated_at=datetime('now')
         WHERE volume_id = ?1 AND status = 'present'
           AND (?2 = '' OR rel_path LIKE ?2 || '%')
           AND id NOT IN (SELECT id FROM seen_ids)",
        params![volume_id, prefix],
    )?;
    conn.execute_batch("DELETE FROM seen_ids;")?;
    Ok(n)
}

pub fn set_thumb_path(conn: &Connection, photo_id: i64, thumb_rel: &str) -> Result<()> {
    conn.execute(
        "UPDATE photos SET thumb_path = ?2, updated_at=datetime('now') WHERE id = ?1",
        params![photo_id, thumb_rel],
    )?;
    Ok(())
}
