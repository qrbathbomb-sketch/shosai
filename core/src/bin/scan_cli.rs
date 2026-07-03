//! Phase 1 検証用CLI。
//! 使い方: scan_cli <走査フォルダ> [--db <path>] [--data <アプリデータdir>] [--thumbs] [--report]

use rusqlite::Connection;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Instant;

use shosai_core::{db, scan, thumb};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() {
        eprintln!("usage: scan_cli <folder> [--data <dir>] [--thumbs] [--report]");
        std::process::exit(1);
    }
    let root = PathBuf::from(&args[0]);
    let mut data_dir = PathBuf::from("./shosai-data");
    let mut do_thumbs = false;
    let mut do_report = false;
    let mut batch_rounds = 0usize;
    let mut auto_n = 0usize;
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--data" => {
                i += 1;
                data_dir = PathBuf::from(&args[i]);
            }
            "--thumbs" => do_thumbs = true,
            "--report" => do_report = true,
            "--batch" => {
                i += 1;
                batch_rounds = args[i].parse().unwrap_or(1);
            }
            "--auto" => {
                i += 1;
                auto_n = args[i].parse().unwrap_or(8);
            }
            other => {
                eprintln!("unknown arg: {}", other);
                std::process::exit(1);
            }
        }
        i += 1;
    }

    let db_path = data_dir.join("shosai.db");
    let mut conn = db::open(&db_path).expect("db open failed");

    let cancel = Arc::new(AtomicBool::new(false));
    {
        let cancel = cancel.clone();
        let _ = ctrlc_lite(move || cancel.store(true, std::sync::atomic::Ordering::Relaxed));
    }

    let t0 = Instant::now();
    let stats = scan::scan_root(&mut conn, &root, &cancel, &|ev| match ev {
        scan::ScanEvent::Started { root } => println!("走査開始: {}", root),
        scan::ScanEvent::Progress { files_seen, indexed } => {
            println!("  ... {} ファイル確認 / {} 件インデックス", files_seen, indexed)
        }
        scan::ScanEvent::FoundYear { year } => println!("  ★ {}年の写真が見つかりました", year),
        scan::ScanEvent::Finished { .. } => {}
    })
    .expect("scan failed");
    println!(
        "走査完了 ({:.2}s): 新規{} 更新{} 変更なし{} RAW{} HEIC{} エラー{} 消失{}{}",
        t0.elapsed().as_secs_f64(),
        stats.images_new,
        stats.images_updated,
        stats.unchanged,
        stats.raw_count,
        stats.heic_count,
        stats.errors,
        stats.marked_missing,
        if stats.cancelled { " (中断)" } else { "" }
    );

    if do_thumbs {
        let t1 = Instant::now();
        let n = generate_thumbs(&mut conn, &data_dir).expect("thumbs failed");
        println!("サムネイル {} 件生成 ({:.2}s)", n, t1.elapsed().as_secs_f64());
    }

    if do_report {
        report(&conn).expect("report failed");
    }

    // おまかせセレクトの検証
    if auto_n > 0 {
        use std::time::Instant;
        let t = Instant::now();
        shosai_core::score::compute_bursts(&conn, None).expect("bursts failed");
        let scored = shosai_core::score::compute_visual_scores(&conn, &data_dir, 10_000)
            .expect("visual scores failed");
        println!(
            "\n== おまかせセレクト (視覚スコア{}件計算, {:.1}s) ==",
            scored,
            t.elapsed().as_secs_f64()
        );
        let picks = shosai_core::score::auto_select(&conn, None, auto_n).expect("auto_select failed");
        for sp in &picks {
            let (rel, taken): (String, Option<String>) = conn
                .query_row(
                    "SELECT rel_path, taken_at FROM photos WHERE id=?1",
                    [sp.photo_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .unwrap();
            let name = rel.rsplit('/').next().unwrap_or(&rel);
            println!(
                "  score={:.2} scenery={:.2} burst={} faces={} | {} | {}",
                sp.score,
                sp.scenery,
                sp.burst_size,
                sp.faces,
                taken.as_deref().unwrap_or("-"),
                name
            );
        }
    }

    // 発掘束の検証: 束を取得→全てskip扱い→次の束、を繰り返す
    if batch_rounds > 0 {
        let today = "2026-07-03"; // 「N年前の今月」テスト用に固定
        for round in 1..=batch_rounds {
            match shosai_core::batch::next_batch(&conn, today).expect("batch failed") {
                Some(b) => {
                    println!(
                        "\n== 発掘束 {} : [{}] {} {} ({}枚) ==",
                        round, b.theme, b.title, b.subtitle, b.photos.len()
                    );
                    for p in &b.photos {
                        println!("  {} | {} | {}", p.taken_at.as_deref().unwrap_or("日付なし"), p.folder, p.file_name);
                        db::set_triage(&conn, p.id, "skip").unwrap();
                    }
                }
                None => {
                    println!("\n== 発掘束 {} : 候補が尽きました ==", round);
                    break;
                }
            }
        }
    }
}

/// present状態のimage写真でサムネイル未生成のものを処理する
fn generate_thumbs(conn: &mut Connection, data_dir: &PathBuf) -> shosai_core::Result<u64> {
    let rows: Vec<(i64, String, String, Option<i64>)> = {
        let mut stmt = conn.prepare(
            "SELECT p.id, v.last_mount_path, p.rel_path, p.orientation
             FROM photos p JOIN volumes v ON v.id = p.volume_id
             WHERE p.status='present' AND p.kind='image' AND p.thumb_path IS NULL",
        )?;
        let it = stmt.query_map([], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })?;
        it.collect::<std::result::Result<Vec<_>, _>>()?
    };
    let mut n = 0;
    for (id, mount, rel, orientation) in rows {
        let abs = PathBuf::from(mount).join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
        match thumb::generate(&abs, orientation, data_dir, id) {
            Ok(thumb_rel) => {
                db::set_thumb_path(conn, id, &thumb_rel)?;
                n += 1;
            }
            Err(e) => eprintln!("thumb失敗 id={}: {}", id, e),
        }
    }
    Ok(n)
}

fn report(conn: &Connection) -> shosai_core::Result<()> {
    println!("\n== 年別レポート ==");
    let mut stmt = conn.prepare(
        "SELECT substr(taken_at,1,4) AS y, COUNT(*) FROM photos
         WHERE status='present' AND taken_at IS NOT NULL GROUP BY y ORDER BY y",
    )?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
    for row in rows {
        let (y, c) = row?;
        println!("  {}年: {}枚", y, c);
    }
    let (no_date, missing): (i64, i64) = conn.query_row(
        "SELECT
           (SELECT COUNT(*) FROM photos WHERE status='present' AND taken_at IS NULL),
           (SELECT COUNT(*) FROM photos WHERE status='missing')",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    println!("  撮影日不明: {}枚 / 消失: {}枚", no_date, missing);
    Ok(())
}

/// 依存を増やさない簡易Ctrl-Cハンドラ(失敗しても走査は動く)
fn ctrlc_lite<F: Fn() + Send + 'static>(f: F) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::sync::Mutex;
        static HANDLER: Mutex<Option<Box<dyn Fn() + Send>>> = Mutex::new(None);
        *HANDLER.lock().unwrap() = Some(Box::new(f));
        extern "C" fn on_sigint(_: i32) {
            if let Ok(g) = HANDLER.lock() {
                if let Some(h) = g.as_ref() {
                    h();
                }
            }
        }
        unsafe {
            libc_signal(2, on_sigint as *const () as usize);
        }
        Ok(())
    }
    #[cfg(not(unix))]
    {
        let _ = f;
        Ok(())
    }
}

#[cfg(unix)]
unsafe fn libc_signal(sig: i32, handler: usize) {
    unsafe extern "C" {
        fn signal(sig: i32, handler: usize) -> usize;
    }
    unsafe {
        signal(sig, handler);
    }
}
