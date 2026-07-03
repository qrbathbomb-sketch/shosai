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
