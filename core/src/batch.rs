//! 発掘束: 毎回少数の写真をテーマ付きで提示する。
//! 画像認識は使わず、撮影日とフォルダ構造だけで束を作る(安価で確実)。
//!
//! 候補プール = present かつ image かつ 未トリアージ
//!   (「あとで」は7日経過で再登場、「残したい」「今回は違う」は再提示しない)

use rusqlite::{params, Connection};

use crate::Result;

pub const BATCH_MAX: usize = 8;
pub const BATCH_MIN: usize = 3;

#[derive(Debug, Clone, serde::Serialize)]
pub struct BatchPhoto {
    pub id: i64,
    pub rel_path: String,
    pub file_name: String,
    pub folder: String,
    pub taken_at: Option<String>,
    pub camera_model: Option<String>,
    pub thumb_path: Option<String>,
    pub orientation: Option<i64>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Batch {
    pub theme: String,    // 機械可読: years_ago_month / one_day / folder / random
    pub title: String,    // 例: 「15年前の今月」
    pub subtitle: String, // 例: 「2011年7月」
    pub photos: Vec<BatchPhoto>,
}

/// 候補プールのWHERE句(photos p / LEFT JOIN triage t 前提)
const POOL_COND: &str = "p.kind='image' AND p.status='present'
    AND (t.photo_id IS NULL OR (t.decision='later' AND t.decided_at < datetime('now','-7 day')))";

fn pool_query(extra_cond: &str) -> String {
    format!(
        "SELECT p.id, p.rel_path, p.taken_at, p.camera_model, p.thumb_path, p.orientation
         FROM photos p LEFT JOIN triage t ON t.photo_id = p.id
         WHERE {} {} ORDER BY p.taken_at",
        POOL_COND, extra_cond
    )
}

fn fetch_photos(conn: &Connection, extra_cond: &str, params_: &[&dyn rusqlite::ToSql]) -> Result<Vec<BatchPhoto>> {
    let mut stmt = conn.prepare(&pool_query(extra_cond))?;
    let rows = stmt.query_map(params_, |r| {
        let rel_path: String = r.get(1)?;
        let (folder, file_name) = split_rel(&rel_path);
        Ok(BatchPhoto {
            id: r.get(0)?,
            rel_path: rel_path.clone(),
            file_name,
            folder,
            taken_at: r.get(2)?,
            camera_model: r.get(3)?,
            thumb_path: r.get(4)?,
            orientation: r.get(5)?,
        })
    })?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

fn split_rel(rel: &str) -> (String, String) {
    match rel.rsplit_once('/') {
        Some((dir, name)) => {
            let folder = dir.rsplit_once('/').map(|(_, f)| f).unwrap_or(dir);
            (folder.to_string(), name.to_string())
        }
        None => (String::new(), rel.to_string()),
    }
}

/// 件数が多い場合は撮影順を保ったまま均等に間引く
fn sample_spread(mut photos: Vec<BatchPhoto>, max: usize) -> Vec<BatchPhoto> {
    if photos.len() <= max {
        return photos;
    }
    let n = photos.len();
    let mut out = Vec::with_capacity(max);
    for i in 0..max {
        let idx = i * (n - 1) / (max - 1);
        out.push(photos[idx].clone());
    }
    // cloneで作ったので元は破棄
    photos.clear();
    out
}

/// 行き先指定の発掘束。年・フォルダ名キーワード・枚数をユーザーが選ぶ。
pub struct BatchFilter {
    pub year: Option<String>,        // "2019"
    pub keyword: Option<String>,     // フォルダ/ファイル名に含まれる語 (例: 祭)
    pub limit: usize,                // 5 / 10 / 20
}

pub fn custom_batch(conn: &Connection, f: &BatchFilter) -> Result<Option<Batch>> {
    let mut conds = String::new();
    let mut params_: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    if let Some(y) = &f.year {
        params_.push(Box::new(y.clone()));
        conds.push_str(&format!(" AND substr(p.taken_at,1,4) = ?{}", params_.len()));
    }
    if let Some(kw) = &f.keyword {
        let kw = kw.trim();
        if !kw.is_empty() {
            params_.push(Box::new(format!("%{}%", kw)));
            conds.push_str(&format!(" AND p.rel_path LIKE ?{}", params_.len()));
        }
    }
    let refs: Vec<&dyn rusqlite::ToSql> = params_.iter().map(|b| b.as_ref()).collect();
    let photos = fetch_photos(conn, &conds, &refs)?;
    if photos.is_empty() {
        return Ok(None);
    }
    let limit = f.limit.clamp(1, 30);
    let title = match (&f.year, &f.keyword) {
        (Some(y), Some(k)) if !k.trim().is_empty() => format!("{}年・「{}」", y, k.trim()),
        (Some(y), _) => format!("{}年の写真", y),
        (None, Some(k)) if !k.trim().is_empty() => format!("「{}」の写真", k.trim()),
        _ => "えらんだ写真".to_string(),
    };
    Ok(Some(Batch {
        theme: "custom".into(),
        title,
        subtitle: String::new(),
        photos: sample_spread(photos, limit),
    }))
}

/// 候補が残っている年の一覧(行き先選択UI用)
pub fn pool_years(conn: &Connection) -> Result<Vec<(String, i64)>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT substr(p.taken_at,1,4) y, COUNT(*)
         FROM photos p LEFT JOIN triage t ON t.photo_id = p.id
         WHERE {} AND p.taken_at IS NOT NULL GROUP BY y ORDER BY y",
        POOL_COND
    ))?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

/// 次の発掘束を返す。候補が尽きたらNone。
/// today: "YYYY-MM-DD" (テスト可能にするため引数で受ける)
pub fn next_batch(conn: &Connection, today: &str) -> Result<Option<Batch>> {
    let this_year: i32 = today[0..4].parse().unwrap_or(2026);
    let this_month = &today[5..7];

    // テーマ1: N年前の今月 (同じ月・過去の年で3枚以上ある年月を無作為に1つ)
    let ym: Option<String> = conn
        .query_row(
            &format!(
                "SELECT substr(p.taken_at,1,7) ym
                 FROM photos p LEFT JOIN triage t ON t.photo_id = p.id
                 WHERE {} AND p.taken_at IS NOT NULL
                   AND substr(p.taken_at,6,2) = ?1 AND substr(p.taken_at,1,4) < ?2
                 GROUP BY ym HAVING COUNT(*) >= ?3
                 ORDER BY RANDOM() LIMIT 1",
                POOL_COND
            ),
            params![this_month, this_year.to_string(), BATCH_MIN as i64],
            |r| r.get(0),
        )
        .ok();
    if let Some(ym) = ym {
        let photos = fetch_photos(conn, "AND substr(p.taken_at,1,7) = ?1", &[&ym])?;
        let year: i32 = ym[0..4].parse().unwrap_or(this_year);
        let month: u32 = ym[5..7].parse().unwrap_or(1);
        return Ok(Some(Batch {
            theme: "years_ago_month".into(),
            title: format!("{}年前の今月", this_year - year),
            subtitle: format!("{}年{}月", year, month),
            photos: sample_spread(photos, BATCH_MAX),
        }));
    }

    // テーマ2: ある一日 (4枚以上撮った日を無作為に1つ)
    let day: Option<String> = conn
        .query_row(
            &format!(
                "SELECT substr(p.taken_at,1,10) d
                 FROM photos p LEFT JOIN triage t ON t.photo_id = p.id
                 WHERE {} AND p.taken_at IS NOT NULL
                 GROUP BY d HAVING COUNT(*) >= 4
                 ORDER BY RANDOM() LIMIT 1",
                POOL_COND
            ),
            [],
            |r| r.get(0),
        )
        .ok();
    if let Some(d) = day {
        let photos = fetch_photos(conn, "AND substr(p.taken_at,1,10) = ?1", &[&d])?;
        let (y, m, dd) = (&d[0..4], &d[5..7], &d[8..10]);
        return Ok(Some(Batch {
            theme: "one_day".into(),
            title: "ある一日の記録".into(),
            subtitle: format!(
                "{}年{}月{}日",
                y,
                m.trim_start_matches('0'),
                dd.trim_start_matches('0')
            ),
            photos: sample_spread(photos, BATCH_MAX),
        }));
    }

    // テーマ3: 同じフォルダ (Rust側でグループ化。プールは(id,rel_path)のみで軽量)
    {
        let mut stmt = conn.prepare(&format!(
            "SELECT p.rel_path FROM photos p LEFT JOIN triage t ON t.photo_id = p.id WHERE {}",
            POOL_COND
        ))?;
        let rels: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let mut by_dir: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
        for rel in &rels {
            if let Some((dir, _)) = rel.rsplit_once('/') {
                *by_dir.entry(dir.to_string()).or_insert(0) += 1;
            }
        }
        let mut dirs: Vec<(String, usize)> =
            by_dir.into_iter().filter(|(_, c)| *c >= BATCH_MIN).collect();
        dirs.sort();
        if !dirs.is_empty() {
            // 擬似乱数(依存追加なし): 現在時刻ナノ秒で選ぶ
            let idx = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.subsec_nanos() as usize)
                .unwrap_or(0)
                % dirs.len();
            let dir = &dirs[idx].0;
            let like = format!("{}/%", dir.replace('%', "\\%").replace('_', "\\_"));
            let photos = fetch_photos(
                conn,
                "AND p.rel_path LIKE ?1 ESCAPE '\\' AND instr(substr(p.rel_path, length(?2)+1), '/') = 0",
                &[&like, &format!("{}/", dir)],
            )?;
            if photos.len() >= BATCH_MIN {
                let folder_name = dir.rsplit_once('/').map(|(_, f)| f).unwrap_or(dir);
                return Ok(Some(Batch {
                    theme: "folder".into(),
                    title: "アルバムから".into(),
                    subtitle: folder_name.to_string(),
                    photos: sample_spread(photos, BATCH_MAX),
                }));
            }
        }
    }

    // フォールバック: 眠っていた写真たち(撮影日不明も含む、無作為)
    let mut stmt = conn.prepare(&format!(
        "SELECT p.id, p.rel_path, p.taken_at, p.camera_model, p.thumb_path, p.orientation
         FROM photos p LEFT JOIN triage t ON t.photo_id = p.id
         WHERE {} ORDER BY RANDOM() LIMIT {}",
        POOL_COND, BATCH_MAX
    ))?;
    let rows = stmt.query_map([], |r| {
        let rel_path: String = r.get(1)?;
        let (folder, file_name) = split_rel(&rel_path);
        Ok(BatchPhoto {
            id: r.get(0)?,
            rel_path,
            file_name,
            folder,
            taken_at: r.get(2)?,
            camera_model: r.get(3)?,
            thumb_path: r.get(4)?,
            orientation: r.get(5)?,
        })
    })?;
    let photos: Vec<BatchPhoto> = rows.collect::<std::result::Result<Vec<_>, _>>()?;
    if photos.is_empty() {
        return Ok(None);
    }
    Ok(Some(Batch {
        theme: "random".into(),
        title: "眠っていた写真たち".into(),
        subtitle: String::new(),
        photos,
    }))
}
