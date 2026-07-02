//! EXIF読み取り(kamadak-exif)。必要項目のみ抽出する。

use std::fs::File;
use std::io::BufReader;
use std::path::Path;

#[derive(Debug, Default, Clone)]
pub struct ExifSummary {
    pub taken_at: Option<String>, // "YYYY-MM-DD HH:MM:SS"
    pub camera_model: Option<String>,
    pub gps_lat: Option<f64>,
    pub gps_lon: Option<f64>,
    pub orientation: Option<i64>,
}

/// EXIFが読めないファイルはDefault(全てNone)を返し、走査を止めない。
pub fn read_exif(path: &Path) -> ExifSummary {
    let file = match File::open(path) {
        Ok(f) => f,
        Err(_) => return ExifSummary::default(),
    };
    let mut reader = BufReader::new(file);
    let exif = match exif::Reader::new().read_from_container(&mut reader) {
        Ok(e) => e,
        Err(_) => return ExifSummary::default(),
    };

    let mut s = ExifSummary::default();

    for tag in [exif::Tag::DateTimeOriginal, exif::Tag::DateTime] {
        if let Some(f) = exif.get_field(tag, exif::In::PRIMARY) {
            let raw = f.display_value().to_string();
            if let Some(norm) = normalize_datetime(&raw) {
                s.taken_at = Some(norm);
                break;
            }
        }
    }

    if let Some(f) = exif.get_field(exif::Tag::Model, exif::In::PRIMARY) {
        let m = f.display_value().to_string().trim_matches('"').trim().to_string();
        if !m.is_empty() {
            s.camera_model = Some(m);
        }
    }

    if let Some(f) = exif.get_field(exif::Tag::Orientation, exif::In::PRIMARY) {
        if let Some(v) = f.value.get_uint(0) {
            s.orientation = Some(v as i64);
        }
    }

    s.gps_lat = gps_coord(&exif, exif::Tag::GPSLatitude, exif::Tag::GPSLatitudeRef, "S");
    s.gps_lon = gps_coord(&exif, exif::Tag::GPSLongitude, exif::Tag::GPSLongitudeRef, "W");

    s
}

/// "2011:10:09 14:00:00" / "2011-10-09 14:00:00" → "2011-10-09 14:00:00"
fn normalize_datetime(raw: &str) -> Option<String> {
    let t = raw.trim();
    if t.len() < 19 {
        return None;
    }
    let date = &t[0..10];
    let time = &t[11..19];
    let date = date.replace(':', "-");
    // 簡易妥当性チェック
    let ok_date = date.as_bytes()[4] == b'-' && date.as_bytes()[7] == b'-';
    let ok_time = time.as_bytes()[2] == b':' && time.as_bytes()[5] == b':';
    if ok_date && ok_time && date[0..4].chars().all(|c| c.is_ascii_digit()) {
        Some(format!("{} {}", date, time))
    } else {
        None
    }
}

fn gps_coord(exif: &exif::Exif, tag: exif::Tag, ref_tag: exif::Tag, neg_ref: &str) -> Option<f64> {
    let field = exif.get_field(tag, exif::In::PRIMARY)?;
    let vals = match &field.value {
        exif::Value::Rational(v) if v.len() >= 3 => v,
        _ => return None,
    };
    let deg = vals[0].to_f64();
    let min = vals[1].to_f64();
    let sec = vals[2].to_f64();
    let mut coord = deg + min / 60.0 + sec / 3600.0;
    if let Some(r) = exif.get_field(ref_tag, exif::In::PRIMARY) {
        let rv = r.display_value().to_string();
        if rv.contains(neg_ref) {
            coord = -coord;
        }
    }
    Some(coord)
}
