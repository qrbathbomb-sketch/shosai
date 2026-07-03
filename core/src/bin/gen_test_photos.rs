//! テスト写真生成(開発専用)。指定フォルダにEXIF付きJPEG等を作る。
//! 使い方: gen_test_photos <出力フォルダ>

use image::{ImageBuffer, Rgb};
use little_exif::exif_tag::ExifTag;
use little_exif::filetype::FileExtension;
use little_exif::metadata::Metadata;
use std::path::{Path, PathBuf};

struct Set {
    folder: &'static str,
    date: &'static str, // "YYYY:MM:DD"
    count: usize,
    hue: f32,
}

fn main() {
    let out = std::env::args().nth(1).expect("usage: gen_test_photos <folder>");
    let out = PathBuf::from(out);

    let sets = [
        Set { folder: "2009-05 京都の旅", date: "2009:05:12", count: 5, hue: 0.0 },
        Set { folder: "2011-10 秋祭り", date: "2011:10:09", count: 6, hue: 0.08 },
        Set { folder: "2013-08 富士山", date: "2013:08:03", count: 5, hue: 0.55 },
        Set { folder: "2016-04 桜", date: "2016:04:02", count: 4, hue: 0.9 },
        Set { folder: "2019-11 競馬場", date: "2019:11:24", count: 5, hue: 0.3 },
        Set { folder: "2022-07 夏の旅", date: "2022:07:18", count: 5, hue: 0.13 },
    ];

    for s in &sets {
        let dir = out.join(s.folder);
        std::fs::create_dir_all(&dir).unwrap();
        for i in 0..s.count {
            let path = dir.join(format!("IMG_{:04}.jpg", i + 1));
            let hour = 9 + i;
            write_jpeg_with_exif(
                &path,
                s.hue + i as f32 * 0.02,
                &format!("{} {:02}:{:02}:00", s.date, hour, i * 7 % 60),
                "TEST-CAM X100",
            );
        }
    }

    // EXIFなしJPEG
    let no_exif_dir = out.join("2013-08 富士山");
    write_plain_jpeg(&no_exif_dir.join("scan_old_print.jpg"), 0.6);

    // PNG (EXIFなしが普通)
    write_png(&out.join("2016-04 桜").join("screenshot.png"));

    // 偽RAW/HEIC (中身はダミー。計数のみの確認用)
    let raw_dir = out.join("2022-07 夏の旅");
    std::fs::write(raw_dir.join("IMG_9001.CR2"), b"fake raw data for count test").unwrap();
    std::fs::write(raw_dir.join("IMG_9002.CR2"), b"fake raw data for count test").unwrap();
    let phone = out.join("スマホ");
    std::fs::create_dir_all(&phone).unwrap();
    std::fs::write(phone.join("IMG_0001.HEIC"), b"fake heic").unwrap();
    write_jpeg_with_exif(&phone.join("IMG_0002.jpg"), 0.7, "2024:01:02 12:30:00", "PHONE-13");
    // 対象外ファイル(無視されることの確認)
    std::fs::write(out.join("メモ.txt"), "not a photo").unwrap();

    // 連写セット(1分間隔×5枚): おまかせセレクトのburst検出用
    let burst_dir = out.join("2019-11 競馬場");
    for i in 0..5 {
        write_jpeg_with_exif(
            &burst_dir.join(format!("BURST_{:04}.jpg", i + 1)),
            0.31,
            &format!("2019:11:24 13:{:02}:00", 10 + i),
            "TEST-CAM X100",
        );
    }
    // 空+緑の「風景」画像: scenery score上位に来るはず
    let sky = ImageBuffer::from_fn(640, 480, |_x, y| {
        if y < 200 {
            Rgb([110u8, 160, 235]) // 青空
        } else {
            Rgb([70u8, 140, 60]) // 緑の丘
        }
    });
    let sky_path = out.join("2013-08 富士山").join("VIEW_0001.jpg");
    sky.save(&sky_path).unwrap();
    let mut meta = Metadata::new();
    meta.set_tag(ExifTag::DateTimeOriginal("2013:08:03 15:00:00".to_string()));
    meta.write_to_file(&sky_path).unwrap();

    println!("テスト写真を生成しました: {}", out.display());
}

fn gradient(hue: f32) -> ImageBuffer<Rgb<u8>, Vec<u8>> {
    let (w, h) = (640u32, 480u32);
    ImageBuffer::from_fn(w, h, |x, y| {
        let fx = x as f32 / w as f32;
        let fy = y as f32 / h as f32;
        let r = ((hue + fx * 0.5).fract() * 255.0) as u8;
        let g = ((fy * 0.8 + hue).fract() * 255.0) as u8;
        let b = ((fx * fy + 0.2).fract() * 255.0) as u8;
        Rgb([r, g, b])
    })
}

fn write_plain_jpeg(path: &Path, hue: f32) {
    gradient(hue).save(path).unwrap();
}

fn write_png(path: &Path) {
    gradient(0.4).save(path).unwrap();
}

fn write_jpeg_with_exif(path: &Path, hue: f32, datetime: &str, model: &str) {
    write_plain_jpeg(path, hue);
    let mut meta = Metadata::new();
    meta.set_tag(ExifTag::DateTimeOriginal(datetime.to_string()));
    meta.set_tag(ExifTag::Model(model.to_string()));
    meta.write_to_file(path)
        .unwrap_or_else(|e| panic!("exif write failed for {:?}: {:?}", path, e));
    let _ = FileExtension::JPEG;
}
