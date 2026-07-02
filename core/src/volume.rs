//! ボリューム識別。ドライブレター/マウントポイント変更に耐えるため、
//! ボリュームUUID(mac) / ボリュームシリアル(Windows) + ボリューム基準の相対パスで保存する。

use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct VolumeInfo {
    pub uuid: String,
    pub label: String,
    /// 相対パス解決の基準(絶対パス復元は mount_point + rel_path)
    pub mount_point: PathBuf,
    /// 走査時に絶対パスから取り除く接頭辞。通常はmount_pointと同じだが、
    /// macOSのfirmlink(/Users → /System/Volumes/Data/Users)では "/" になる。
    pub strip_base: PathBuf,
}

/// 指定パスが属するボリュームを特定する。特定できない場合はパスベースのフォールバック。
pub fn identify(path: &Path) -> VolumeInfo {
    if let Some(mut v) = platform_identify(path) {
        if path.strip_prefix(&v.mount_point).is_ok() {
            v.strip_base = v.mount_point.clone();
            return v;
        }
        // firmlink等: mount_point + (先頭'/'を除いたpath) が実在するなら "/" 基準で扱う
        if let Ok(rel) = path.strip_prefix("/") {
            if v.mount_point.join(rel).exists() {
                v.strip_base = PathBuf::from("/");
                return v;
            }
        }
    }
    fallback(path)
}

fn fallback(path: &Path) -> VolumeInfo {
    // UUIDが取れない環境でも動作は継続する(識別子はマウントパス由来)
    let root = mount_root_guess(path);
    VolumeInfo {
        uuid: format!("path:{}", root.to_string_lossy()),
        label: root
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "root".to_string()),
        strip_base: root.clone(),
        mount_point: root,
    }
}

fn mount_root_guess(path: &Path) -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        let p = path.to_string_lossy();
        if let Some(rest) = p.strip_prefix("/Volumes/") {
            if let Some(name) = rest.split('/').next() {
                return PathBuf::from(format!("/Volumes/{}", name));
            }
        }
        PathBuf::from("/")
    }
    #[cfg(windows)]
    {
        // "C:\..." → "C:\"
        let mut comps = path.components();
        if let Some(std::path::Component::Prefix(pre)) = comps.next() {
            let mut root = PathBuf::from(pre.as_os_str());
            root.push("\\");
            return root;
        }
        PathBuf::from("C:\\")
    }
    #[cfg(all(not(target_os = "macos"), not(windows)))]
    {
        let _ = path;
        PathBuf::from("/")
    }
}

#[cfg(target_os = "macos")]
fn platform_identify(path: &Path) -> Option<VolumeInfo> {
    // diskutil infoはマウントポイント指定が必要なので、まずdfで解決する
    let mount = df_mount_point(path)?;
    let out = std::process::Command::new("diskutil")
        .arg("info")
        .arg(&mount)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut uuid = None;
    let mut label = None;
    let mut mount = None;
    for line in text.lines() {
        let line = line.trim();
        if let Some(v) = line.strip_prefix("Volume UUID:") {
            uuid = Some(v.trim().to_string());
        } else if let Some(v) = line.strip_prefix("Volume Name:") {
            label = Some(v.trim().to_string());
        } else if let Some(v) = line.strip_prefix("Mount Point:") {
            mount = Some(PathBuf::from(v.trim()));
        }
    }
    let mount = mount?;
    Some(VolumeInfo {
        uuid: uuid?,
        label: label.unwrap_or_default(),
        strip_base: mount.clone(),
        mount_point: mount,
    })
}

/// `df -P <path>` の出力からマウントポイントを取り出す(スペース入りボリューム名対応)。
#[cfg(target_os = "macos")]
fn df_mount_point(path: &Path) -> Option<PathBuf> {
    let out = std::process::Command::new("df")
        .arg("-P")
        .arg(path)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text.lines().nth(1)?;
    // Capacity列("...%")の直後以降がマウントポイント
    let pct = line.find('%')?;
    let mount = line[pct + 1..].trim();
    if mount.is_empty() {
        None
    } else {
        Some(PathBuf::from(mount))
    }
}

#[cfg(windows)]
fn platform_identify(path: &Path) -> Option<VolumeInfo> {
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use windows_sys::Win32::Storage::FileSystem::{
        GetVolumeInformationW, GetVolumePathNameW,
    };

    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut root_buf = [0u16; 512];
    let ok = unsafe { GetVolumePathNameW(wide.as_ptr(), root_buf.as_mut_ptr(), root_buf.len() as u32) };
    if ok == 0 {
        return None;
    }
    let root_len = root_buf.iter().position(|&c| c == 0).unwrap_or(0);
    let root = std::ffi::OsString::from_wide(&root_buf[..root_len]);
    let root_wide: Vec<u16> = root.encode_wide().chain(Some(0)).collect();

    let mut name_buf = [0u16; 256];
    let mut serial: u32 = 0;
    let mut max_len: u32 = 0;
    let mut flags: u32 = 0;
    let ok = unsafe {
        GetVolumeInformationW(
            root_wide.as_ptr(),
            name_buf.as_mut_ptr(),
            name_buf.len() as u32,
            &mut serial,
            &mut max_len,
            &mut flags,
            std::ptr::null_mut(),
            0,
        )
    };
    if ok == 0 {
        return None;
    }
    let name_len = name_buf.iter().position(|&c| c == 0).unwrap_or(0);
    let label = String::from_utf16_lossy(&name_buf[..name_len]);
    let mount = PathBuf::from(root);
    Some(VolumeInfo {
        uuid: format!("winserial:{:08X}", serial),
        label,
        strip_base: mount.clone(),
        mount_point: mount,
    })
}

#[cfg(all(not(target_os = "macos"), not(windows)))]
fn platform_identify(_path: &Path) -> Option<VolumeInfo> {
    None
}

/// 絶対パス → ボリューム基準の相対パス('/'区切り、クロスプラットフォーム共通形式)
pub fn to_rel_path(vol: &VolumeInfo, abs: &Path) -> Option<String> {
    let rel = abs.strip_prefix(&vol.strip_base).ok()?;
    let s = rel
        .components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/");
    Some(s)
}
