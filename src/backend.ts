// バックエンド差し替え層。
// Tauri内 → Rustコマンド / ブラウザ(デモ) → demoBackendのサンプルデータ。
// App.tsxはこのモジュールだけを使い、環境を意識しない。

import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { demoCall, demoListen } from "./demoBackend";

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
export const isDemo = !isTauri;

export async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (isTauri) return invoke<T>(cmd, args);
  return demoCall<T>(cmd, args ?? {});
}

export async function on(
  event: string,
  cb: (payload: any) => void
): Promise<() => void> {
  if (isTauri) {
    const un = await listen(event, (ev) => cb(ev.payload));
    return un;
  }
  return demoListen(event, cb);
}

export async function pickDirectory(): Promise<string | null> {
  if (isTauri) {
    const dir = await open({
      directory: true,
      title: "写真が入っているフォルダやドライブを選んでください",
    });
    return typeof dir === "string" ? dir : null;
  }
  return "デモ写真(サンプル)";
}

export function fileSrc(path: string): string {
  if (path.startsWith("http")) return path;
  return isTauri ? convertFileSrc(path) : path;
}

/** 写真の実フォルダをFinder/Explorerで開く。デモではfalseを返す(UIが案内を表示) */
export async function revealPhoto(photoId: number): Promise<boolean> {
  if (isTauri) {
    await invoke("reveal_photo", { photoId });
    return true;
  }
  return false;
}

/** PDF用の高解像度画像バイト列。Tauriは元写真から1600px、デモは大きめのサンプルを取得 */
export async function photoJpegBytes(p: { id: number; thumbAbs: string | null }): Promise<Uint8Array> {
  if (isTauri) {
    const b64 = await invoke<string>("get_photo_jpeg", { photoId: p.id, maxEdge: 1600 });
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  const url = (p.thumbAbs ?? "").replace("/640/480", "/1200/900");
  const res = await fetch(url);
  if (!res.ok) throw new Error("画像を取得できませんでした");
  return new Uint8Array(await res.arrayBuffer());
}

/** PDF保存。Tauriは保存ダイアログ→書き込み、デモはブラウザダウンロード。falseはキャンセル */
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
  console.log(`[demo] PDF生成: ${fileName} (${bytes.length} bytes)`);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(a.href);
  return true;
}
