// Tauriコマンド層。coreの機能をUIへ橋渡しする。
// 元写真は読み取り専用(coreの原則をそのまま引き継ぐ)。

use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager, State};

use shosai_core::{batch, db, scan, thumb};

struct AppState {
    data_dir: PathBuf,
    db_path: PathBuf,
    conn: Mutex<rusqlite::Connection>,
    scanning: Arc<AtomicBool>,
    cancel: Arc<AtomicBool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct YearCount {
    year: String,
    count: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Overview {
    total_photos: i64,
    kept: i64,
    raw_heic: i64,
    shiori_count: i64,
    years: Vec<YearCount>,
    roots: Vec<String>,
    scanning: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PhotoOut {
    id: i64,
    file_name: String,
    folder: String,
    taken_at: Option<String>,
    camera_model: Option<String>,
    thumb_abs: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct BatchOut {
    theme: String,
    title: String,
    subtitle: String,
    photos: Vec<PhotoOut>,
}

type CmdResult<T> = Result<T, String>;

fn err_str<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

#[tauri::command]
fn get_overview(state: State<AppState>) -> CmdResult<Overview> {
    let conn = state.conn.lock().map_err(err_str)?;
    let (total, raw_heic): (i64, i64) = conn
        .query_row(
            "SELECT
               (SELECT COUNT(*) FROM photos WHERE status='present' AND kind='image'),
               (SELECT COUNT(*) FROM photos WHERE status='present' AND kind!='image')",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(err_str)?;
    let kept: i64 = conn
        .query_row("SELECT COUNT(*) FROM triage WHERE decision='keep'", [], |r| r.get(0))
        .map_err(err_str)?;
    let shiori_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM shiori", [], |r| r.get(0))
        .map_err(err_str)?;
    let mut stmt = conn
        .prepare(
            "SELECT substr(taken_at,1,4) y, COUNT(*) FROM photos
             WHERE status='present' AND taken_at IS NOT NULL GROUP BY y ORDER BY y",
        )
        .map_err(err_str)?;
    let years = stmt
        .query_map([], |r| {
            Ok(YearCount { year: r.get(0)?, count: r.get(1)? })
        })
        .map_err(err_str)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err_str)?;
    let mut stmt = conn.prepare("SELECT display_path FROM roots ORDER BY added_at").map_err(err_str)?;
    let roots = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(err_str)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err_str)?;
    Ok(Overview {
        total_photos: total,
        kept,
        raw_heic,
        shiori_count,
        years,
        roots,
        scanning: state.scanning.load(Ordering::Relaxed),
    })
}

#[tauri::command]
fn start_scan(app: tauri::AppHandle, state: State<AppState>, path: String) -> CmdResult<()> {
    if state.scanning.swap(true, Ordering::SeqCst) {
        return Err("すでに読み取り中です".into());
    }
    state.cancel.store(false, Ordering::SeqCst);
    let db_path = state.db_path.clone();
    let data_dir = state.data_dir.clone();
    let scanning = state.scanning.clone();
    let cancel = state.cancel.clone();

    std::thread::spawn(move || {
        let result = (|| -> shosai_core::Result<()> {
            // 走査スレッドは自前の接続を持つ(WALで並行可)
            let mut conn = db::open(&db_path)?;
            let app2 = app.clone();
            scan::scan_root(&mut conn, PathBuf::from(&path).as_path(), &cancel, &move |ev| {
                let _ = app2.emit("scan-event", &ev);
            })?;

            // 走査後、サムネイル未生成分を背景生成(中断可)
            let rows: Vec<(i64, String, String, Option<i64>)> = {
                let mut stmt = conn.prepare(
                    "SELECT p.id, v.last_mount_path, p.rel_path, p.orientation
                     FROM photos p JOIN volumes v ON v.id = p.volume_id
                     WHERE p.status='present' AND p.kind='image' AND p.thumb_path IS NULL",
                )?;
                let it = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?;
                it.collect::<std::result::Result<Vec<_>, _>>()?
            };
            let total = rows.len();
            for (i, (id, mount, rel, orientation)) in rows.into_iter().enumerate() {
                if cancel.load(Ordering::Relaxed) {
                    break;
                }
                let abs = PathBuf::from(&mount).join(&rel);
                if let Ok(thumb_rel) = thumb::generate(&abs, orientation, &data_dir, id) {
                    let _ = db::set_thumb_path(&conn, id, &thumb_rel);
                }
                if (i + 1) % 20 == 0 || i + 1 == total {
                    let _ = app.emit("thumb-progress", serde_json::json!({"done": i + 1, "total": total}));
                }
            }
            Ok(())
        })();
        if let Err(e) = result {
            let _ = app.emit("scan-error", e.to_string());
        }
        scanning.store(false, Ordering::SeqCst);
        let _ = app.emit("scan-idle", ());
    });
    Ok(())
}

#[tauri::command]
fn cancel_scan(state: State<AppState>) {
    state.cancel.store(true, Ordering::SeqCst);
}

#[tauri::command]
fn next_batch(state: State<AppState>) -> CmdResult<Option<BatchOut>> {
    let conn = state.conn.lock().map_err(err_str)?;
    let today = today_local();
    let b = match batch::next_batch(&conn, &today).map_err(err_str)? {
        Some(b) => b,
        None => return Ok(None),
    };
    // この束の写真だけはサムネイルを同期生成(背景生成が未完了でも発掘は動く)
    let mut photos = Vec::with_capacity(b.photos.len());
    for p in b.photos {
        let thumb_rel = match p.thumb_path {
            Some(t) => Some(t),
            None => {
                let abs_src: Option<(String, String)> = conn
                    .query_row(
                        "SELECT v.last_mount_path, p.rel_path FROM photos p
                         JOIN volumes v ON v.id = p.volume_id WHERE p.id = ?1",
                        [p.id],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .ok();
                abs_src.and_then(|(mount, rel)| {
                    let abs = PathBuf::from(mount).join(rel);
                    match thumb::generate(&abs, p.orientation, &state.data_dir, p.id) {
                        Ok(t) => {
                            let _ = db::set_thumb_path(&conn, p.id, &t);
                            Some(t)
                        }
                        Err(_) => None,
                    }
                })
            }
        };
        photos.push(PhotoOut {
            id: p.id,
            file_name: p.file_name,
            folder: p.folder,
            taken_at: p.taken_at,
            camera_model: p.camera_model,
            thumb_abs: thumb_rel.map(|t| state.data_dir.join(t).to_string_lossy().to_string()),
        });
    }
    Ok(Some(BatchOut {
        theme: b.theme,
        title: b.title,
        subtitle: b.subtitle,
        photos,
    }))
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ShioriOut {
    id: i64,
    title: String,
    note: String,
    taken_label: String,
    created_at: String,
    photos: Vec<PhotoOut>,
}

#[tauri::command]
fn create_shiori(
    state: State<AppState>,
    title: String,
    note: String,
    taken_label: String,
    photo_ids: Vec<i64>,
) -> CmdResult<i64> {
    if photo_ids.is_empty() || photo_ids.len() > 3 {
        return Err("写真は1〜3枚選んでください".into());
    }
    let conn = state.conn.lock().map_err(err_str)?;
    db::create_shiori(&conn, title.trim(), note.trim(), &taken_label, &photo_ids).map_err(err_str)
}

fn shiori_photos(
    conn: &rusqlite::Connection,
    data_dir: &PathBuf,
    shiori_id: i64,
) -> CmdResult<Vec<PhotoOut>> {
    let mut stmt = conn
        .prepare(
            "SELECT p.id, p.rel_path, p.taken_at, p.camera_model, p.thumb_path
             FROM shiori_photos sp JOIN photos p ON p.id = sp.photo_id
             WHERE sp.shiori_id = ?1 ORDER BY sp.position",
        )
        .map_err(err_str)?;
    let rows = stmt
        .query_map([shiori_id], |r| {
            let rel: String = r.get(1)?;
            let (folder, file_name) = match rel.rsplit_once('/') {
                Some((dir, name)) => (
                    dir.rsplit_once('/').map(|(_, f)| f).unwrap_or(dir).to_string(),
                    name.to_string(),
                ),
                None => (String::new(), rel.clone()),
            };
            let thumb: Option<String> = r.get(4)?;
            Ok(PhotoOut {
                id: r.get(0)?,
                file_name,
                folder,
                taken_at: r.get(2)?,
                camera_model: r.get(3)?,
                thumb_abs: thumb.map(|t| data_dir.join(t).to_string_lossy().to_string()),
            })
        })
        .map_err(err_str)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(err_str)
}

#[tauri::command]
fn list_shiori(state: State<AppState>) -> CmdResult<Vec<ShioriOut>> {
    let conn = state.conn.lock().map_err(err_str)?;
    let heads: Vec<(i64, String, String, String, String)> = {
        let mut stmt = conn
            .prepare("SELECT id, title, note, taken_label, created_at FROM shiori ORDER BY created_at DESC, id DESC")
            .map_err(err_str)?;
        let it = stmt
            .query_map([], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
            })
            .map_err(err_str)?;
        it.collect::<Result<Vec<_>, _>>().map_err(err_str)?
    };
    let mut out = Vec::with_capacity(heads.len());
    for (id, title, note, taken_label, created_at) in heads {
        out.push(ShioriOut {
            id,
            title,
            note,
            taken_label,
            created_at,
            photos: shiori_photos(&conn, &state.data_dir, id)?,
        });
    }
    Ok(out)
}

#[tauri::command]
fn triage_photo(state: State<AppState>, photo_id: i64, decision: String) -> CmdResult<()> {
    if !["keep", "later", "skip"].contains(&decision.as_str()) {
        return Err("invalid decision".into());
    }
    let conn = state.conn.lock().map_err(err_str)?;
    db::set_triage(&conn, photo_id, &decision).map_err(err_str)
}

/// ローカル日付 "YYYY-MM-DD"。JST想定の簡易実装(UTC+9)。
/// 発掘テーマの選定にしか使わないため数時間のずれは許容。
fn today_local() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let secs = now + 9 * 3600;
    let days = secs / 86400;
    let (y, m, d) = civil_from_days(days as i64);
    format!("{:04}-{:02}-{:02}", y, m, d)
}

// Howard Hinnant の civil_from_days アルゴリズム
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let db_path = data_dir.join("shosai.db");
            let conn = db::open(&db_path).map_err(|e| format!("DB初期化失敗: {}", e))?;
            app.manage(AppState {
                data_dir,
                db_path,
                conn: Mutex::new(conn),
                scanning: Arc::new(AtomicBool::new(false)),
                cancel: Arc::new(AtomicBool::new(false)),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_overview,
            start_scan,
            cancel_scan,
            next_batch,
            triage_photo,
            create_shiori,
            list_shiori
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
