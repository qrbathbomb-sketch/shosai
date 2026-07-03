//! おまかせセレクト用のスコアリング。
//! 高価なML基盤は使わず、安価で確実なシグナルを組み合わせる:
//! - 連写検出: 撮影時刻が近い写真の塊(良い撮影スポットの示唆)。EXIFのみ
//! - 風景らしさ: サムネイルの色解析(空・緑・彩度)。512pxサムネで十分軽い
//! - 顔検出: rustface(純Rust・オフライン)。人が写っていない=風景候補
//!
//! 結果はphoto_scoresにキャッシュし、再計算しない。

use rusqlite::{params, Connection};
use std::path::Path;

use crate::Result;

/// 連写とみなす撮影間隔(秒)
const BURST_GAP_SECS: i64 = 180;

static FACE_MODEL: &[u8] = include_bytes!("../assets/seeta_fd_frontal_v1.0.bin");

#[derive(Debug, Clone, serde::Serialize)]
pub struct ScoredPhoto {
    pub photo_id: i64,
    pub burst_size: i64,
    pub scenery: f64,
    pub faces: i64,
    pub score: f64,
}

/// taken_atを"エポック秒もどき"へ(同日内の比較にしか使わない)
fn ts_of(taken_at: &str) -> Option<i64> {
    if taken_at.len() < 19 {
        return None;
    }
    let d: i64 = taken_at[8..10].parse().ok()?;
    let h: i64 = taken_at[11..13].parse().ok()?;
    let m: i64 = taken_at[14..16].parse().ok()?;
    let s: i64 = taken_at[17..19].parse().ok()?;
    Some(((d * 24 + h) * 60 + m) * 60 + s)
}

/// 連写グループを計算してphoto_scoresへ書き込む(全対象、EXIFのみで安価)。
/// 戻り値: 各photo_idのburst_size。
pub fn compute_bursts(conn: &Connection, year: Option<&str>) -> Result<()> {
    let mut sql = String::from(
        "SELECT id, taken_at FROM photos
         WHERE status='present' AND kind='image' AND taken_at IS NOT NULL",
    );
    if year.is_some() {
        sql.push_str(" AND substr(taken_at,1,4) = ?1");
    }
    sql.push_str(" ORDER BY taken_at");
    let mut stmt = conn.prepare(&sql)?;
    let rows: Vec<(i64, String)> = if let Some(y) = year {
        stmt.query_map(params![y], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<std::result::Result<_, _>>()?
    } else {
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<std::result::Result<_, _>>()?
    };

    // 同じ月日の連続撮影をチェーン化
    let mut chains: Vec<Vec<i64>> = Vec::new();
    let mut cur: Vec<i64> = Vec::new();
    let mut last: Option<(String, i64)> = None; // (YYYY-MM-DD, ts)
    for (id, taken) in &rows {
        let day = taken[0..10].to_string();
        let ts = match ts_of(taken) {
            Some(t) => t,
            None => continue,
        };
        let cont = matches!(&last, Some((d, t)) if *d == day && ts - t <= BURST_GAP_SECS);
        if cont {
            cur.push(*id);
        } else {
            if !cur.is_empty() {
                chains.push(std::mem::take(&mut cur));
            }
            cur.push(*id);
        }
        last = Some((day, ts));
    }
    if !cur.is_empty() {
        chains.push(cur);
    }

    let mut up = conn.prepare(
        "INSERT INTO photo_scores (photo_id, burst_size, burst_id) VALUES (?1, ?2, ?3)
         ON CONFLICT(photo_id) DO UPDATE SET burst_size = ?2, burst_id = ?3",
    )?;
    for chain in &chains {
        for id in chain {
            up.execute(params![id, chain.len() as i64, chain[0]])?;
        }
    }
    Ok(())
}

/// サムネイルの色から風景らしさ(0..1)。空(上部の青/白)・緑・彩度で判定。
pub fn scenery_score(thumb_path: &Path) -> Option<f64> {
    let img = image::open(thumb_path).ok()?.to_rgb8();
    let (w, h) = img.dimensions();
    if w == 0 || h == 0 {
        return None;
    }
    let top_h = (h as f64 * 0.4) as u32;
    let (mut sky, mut top_n) = (0u64, 0u64);
    let (mut green, mut colorful, mut n) = (0u64, 0f64, 0u64);
    for (x, y, p) in img.enumerate_pixels() {
        let (r, g, b) = (p[0] as i32, p[1] as i32, p[2] as i32);
        let max = r.max(g).max(b);
        let min = r.min(g).min(b);
        let sat = if max == 0 { 0.0 } else { (max - min) as f64 / max as f64 };
        n += 1;
        colorful += sat;
        if y < top_h {
            top_n += 1;
            let bright = (r + g + b) / 3;
            let blue_sky = b > r + 20 && b >= g && bright > 90;
            let white_sky = bright > 200 && sat < 0.12;
            if blue_sky || white_sky {
                sky += 1;
            }
        }
        if g > r + 12 && g > b + 12 {
            green += 1;
        }
        let _ = x;
    }
    let sky_f = if top_n > 0 { sky as f64 / top_n as f64 } else { 0.0 };
    let green_f = green as f64 / n as f64;
    let sat_f = colorful / n as f64;
    // 空か緑がしっかりあれば風景の可能性が高い。彩度は補助
    let s = (sky_f * 1.6).min(1.0) * 0.5 + (green_f * 2.5).min(1.0) * 0.35 + sat_f.min(0.6) / 0.6 * 0.15;
    Some(s.min(1.0))
}

/// 顔検出(サムネイル上)。エラー時はNone(スコア計算は継続)。
pub fn count_faces(thumb_path: &Path) -> Option<i64> {
    let model = rustface::model::read_model(std::io::Cursor::new(FACE_MODEL)).ok()?;
    let mut detector = rustface::create_detector_with_model(model);
    detector.set_min_face_size(24);
    detector.set_score_thresh(2.0);
    detector.set_pyramid_scale_factor(0.8);
    detector.set_slide_window_step(4, 4);
    let gray = image::open(thumb_path).ok()?.to_luma8();
    let (w, h) = gray.dimensions();
    let mut img = rustface::ImageData::new(gray.as_raw(), w, h);
    Some(detector.detect(&mut img).len() as i64)
}

/// 未スコアの写真にscenery/facesを付与する(サムネイル必須)。
/// 重い処理なのでlimitで刻めるようにする。戻り値=処理件数。
pub fn compute_visual_scores(conn: &Connection, data_dir: &Path, limit: usize) -> Result<usize> {
    let rows: Vec<(i64, String)> = {
        let mut stmt = conn.prepare(
            "SELECT p.id, p.thumb_path FROM photos p
             LEFT JOIN photo_scores s ON s.photo_id = p.id
             WHERE p.status='present' AND p.kind='image' AND p.thumb_path IS NOT NULL
               AND (s.photo_id IS NULL OR s.scenery IS NULL)
             LIMIT ?1",
        )?;
        let it = stmt.query_map([limit as i64], |r| Ok((r.get(0)?, r.get(1)?)))?;
        it.collect::<std::result::Result<_, _>>()?
    };
    let mut n = 0;
    for (id, thumb_rel) in rows {
        let thumb = data_dir.join(&thumb_rel);
        let scenery = scenery_score(&thumb).unwrap_or(0.0);
        let faces = count_faces(&thumb).unwrap_or(-1); // -1 = 判定不能
        conn.execute(
            "INSERT INTO photo_scores (photo_id, burst_size, scenery, faces, computed_at)
             VALUES (?1, 1, ?2, ?3, datetime('now'))
             ON CONFLICT(photo_id) DO UPDATE SET scenery=?2, faces=?3, computed_at=datetime('now')",
            params![id, scenery, faces],
        )?;
        n += 1;
    }
    Ok(n)
}

/// おまかせセレクト: スコア上位から、連写グループにつき1枚・1日3枚までの分散で選ぶ。
pub fn auto_select(conn: &Connection, year: Option<&str>, limit: usize) -> Result<Vec<ScoredPhoto>> {
    let mut sql = String::from(
        "SELECT p.id, COALESCE(s.burst_size,1), COALESCE(s.scenery,0), COALESCE(s.faces,-1),
                COALESCE(p.taken_at,''), COALESCE(s.burst_id, p.id)
         FROM photos p
         LEFT JOIN photo_scores s ON s.photo_id = p.id
         LEFT JOIN triage t ON t.photo_id = p.id
         WHERE p.status='present' AND p.kind='image' AND p.thumb_path IS NOT NULL
           AND (t.photo_id IS NULL OR t.decision != 'skip')",
    );
    if year.is_some() {
        sql.push_str(" AND substr(p.taken_at,1,4) = ?1");
    }
    let mut stmt = conn.prepare(&sql)?;
    let map = |r: &rusqlite::Row| -> rusqlite::Result<(i64, i64, f64, i64, String, i64)> {
        Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?))
    };
    let rows: Vec<(i64, i64, f64, i64, String, i64)> = if let Some(y) = year {
        stmt.query_map(params![y], map)?.collect::<std::result::Result<_, _>>()?
    } else {
        stmt.query_map([], map)?.collect::<std::result::Result<_, _>>()?
    };

    let mut scored: Vec<(ScoredPhoto, String, i64)> = rows
        .into_iter()
        .map(|(id, burst, scenery, faces, taken, burst_id)| {
            let burst_bonus = ((burst as f64).ln() / 3.0f64.ln()).min(1.5) * 0.3;
            let face_bonus = match faces {
                0 => 0.25,
                -1 => 0.0,
                _ => -0.3, // 人物写真は風景ポートフォリオから外す
            };
            let score = scenery * 0.6 + burst_bonus + face_bonus;
            (
                ScoredPhoto { photo_id: id, burst_size: burst, scenery, faces, score },
                taken,
                burst_id,
            )
        })
        .collect();
    scored.sort_by(|a, b| b.0.score.partial_cmp(&a.0.score).unwrap_or(std::cmp::Ordering::Equal));

    // 分散: 連写グループにつき1枚、同じ日は最大3枚
    let mut per_day: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut used_bursts: std::collections::HashSet<i64> = std::collections::HashSet::new();
    let mut out = Vec::new();
    for (sp, taken, burst_id) in scored {
        if !used_bursts.insert(burst_id) {
            continue;
        }
        let day = if taken.len() >= 10 { taken[0..10].to_string() } else { "unknown".into() };
        let c = per_day.entry(day).or_insert(0);
        if *c >= 3 {
            continue;
        }
        *c += 1;
        out.push(sp);
        if out.len() >= limit {
            break;
        }
    }
    Ok(out)
}
