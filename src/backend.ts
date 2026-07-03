// バックエンド差し替え層。App.tsxはこのモジュールだけを使い、環境を意識しない。
// Tauri内 → Rustコマンド / ブラウザ → webBackend(File System Access APIで実フォルダを読む)。
// どちらも同じコマンド体系・同じ機能。写真はネットワーク送信しない。

import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import {
  webCall,
  webListen,
  webPickDirectory,
  webPhotoLocation,
  webPhotoJpegBytes,
} from "./webBackend";

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
export const isWeb = !isTauri;

export async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (isTauri) return invoke<T>(cmd, args);
  return webCall<T>(cmd, args ?? {});
}

export async function on(event: string, cb: (payload: any) => void): Promise<() => void> {
  if (isTauri) return listen(event, (ev) => cb(ev.payload));
  return webListen(event, cb);
}

export async function pickDirectory(): Promise<string | null> {
  if (isTauri) {
    const dir = await open({
      directory: true,
      title: "写真が入っているフォルダやドライブを選んでください",
    });
    return typeof dir === "string" ? dir : null;
  }
  return webPickDirectory();
}

export function fileSrc(path: string): string {
  if (path.startsWith("http") || path.startsWith("blob:")) return path;
  return isTauri ? convertFileSrc(path) : path;
}

/** 写真の実フォルダを開く。ブラウザではOSフォルダを開けないため場所を案内する */
export async function revealPhoto(photoId: number): Promise<string | null> {
  if (isTauri) {
    await invoke("reveal_photo", { photoId });
    return null; // 成功: フォルダが開いた
  }
  return webPhotoLocation(photoId); // 場所文字列を返す(UIが表示)
}

/** PDF用の高解像度JPEGバイト列。元写真から1600pxで読み直す */
export async function photoJpegBytes(p: { id: number }): Promise<Uint8Array> {
  if (isTauri) {
    const b64 = await invoke<string>("get_photo_jpeg", { photoId: p.id, maxEdge: 1600 });
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  return webPhotoJpegBytes(p.id);
}

/** PDF保存。Tauriは保存ダイアログ→書き込み、ブラウザはダウンロード。falseはキャンセル */
export async function savePdf(fileName: string, bytes: Uint8Array): Promise<boolean> {
  if (isTauri) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const path = await save({
      defaultPath: fileName,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (!path) return false;
    let bin = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    await invoke("save_binary", { path, dataBase64: btoa(bin) });
    return true;
  }
  const blob = new Blob([bytes.buffer as ArrayBuffer], { type: "application/pdf" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(a.href);
  return true;
}
