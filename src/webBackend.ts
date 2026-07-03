// ブラウザ版の本番バックエンド。
// File System Access API で実際のローカルフォルダを読み取り(読み取り専用)、
// EXIF/サムネイル/スコアをブラウザ内(IndexedDB + canvas)で処理する。
// 写真は一切ネットワーク送信しない。Rust版(src-tauri/src/lib.rs)と同じコマンド体系を実装する。

import { openDB, type IDBPDatabase } from "idb";
import exifr from "exifr";

export const webSupported =
  typeof window !== "undefined" && "showDirectoryPicker" in window;

type Kind = "image" | "raw" | "heic";

type PhotoRec = {
  id: number;
  relPath: string; // "旅/2011/IMG_0001.jpg"
  pathParts: string[]; // ["旅","2011","IMG_0001.jpg"]
  fileName: string;
  folder: string; // 直近の親フォルダ名
  size: number;
  mtime: number;
  kind: Kind;
  takenAt: string | null; // "YYYY-MM-DD HH:MM:SS"
  cameraModel: string | null;
  orientation: number | null;
  gpsLat: number | null;
  gpsLon: number | null;
  status: "present" | "missing";
  hasThumb: boolean;
};

type ScoreRec = {
  photoId: number;
  burstSize: number;
  burstId: number;
  scenery: number | null;
  faces: number; // 常に-1(ブラウザでは顔検出なし)
};

type TriageRec = { photoId: number; decision: "keep" | "later" | "skip"; decidedAt: number };
type ShioriRec = { id: number; title: string; note: string; takenLabel: string; createdAt: string };
type ShioriPhotoRec = { shioriId: number; photoId: number; position: number };

const RAW_EXTS = new Set(["cr2", "cr3", "nef", "arw", "orf", "rw2", "dng", "raf", "pef", "srw"]);
const IMG_EXTS = new Set(["jpg", "jpeg", "png", "tif", "tiff"]);
const HEIC_EXTS = new Set(["heic", "heif"]);

function kindOf(name: string): Kind | null {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (IMG_EXTS.has(ext)) return "image";
  if (RAW_EXTS.has(ext)) return "raw";
  if (HEIC_EXTS.has(ext)) return "heic";
  return null;
}

// ---- IndexedDB ----

let dbp: Promise<IDBPDatabase> | null = null;
function db() {
  if (!dbp) {
    dbp = openDB("shosai", 1, {
      upgrade(d) {
        const photos = d.createObjectStore("photos", { keyPath: "id" });
        photos.createIndex("relPath", "relPath", { unique: true });
        d.createObjectStore("triage", { keyPath: "photoId" });
        d.createObjectStore("scores", { keyPath: "photoId" });
        d.createObjectStore("thumbs", { keyPath: "photoId" }); // value: { photoId, blob }
        d.createObjectStore("shiori", { keyPath: "id" });
        const sp = d.createObjectStore("shioriPhotos", { keyPath: ["shioriId", "photoId"] });
        sp.createIndex("shioriId", "shioriId");
        d.createObjectStore("meta", { keyPath: "key" });
      },
    });
  }
  return dbp;
}

async function metaGet<T>(key: string): Promise<T | undefined> {
  const row = await (await db()).get("meta", key);
  return row?.value as T | undefined;
}
async function metaSet(key: string, value: unknown) {
  await (await db()).put("meta", { key, value });
}

// ---- イベント ----

const listeners = new Map<string, Set<(p: any) => void>>();
export function webListen(event: string, cb: (p: any) => void): () => void {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event)!.add(cb);
  return () => listeners.get(event)?.delete(cb);
}
function emit(event: string, payload: any) {
  listeners.get(event)?.forEach((cb) => cb(payload));
}

// ---- ルートフォルダ ----

let rootHandle: FileSystemDirectoryHandle | null = null;
let scanning = false;
let cancelFlag = false;

export async function webPickDirectory(): Promise<string | null> {
  if (!webSupported) {
    throw new Error(
      "このブラウザはフォルダの読み取りに対応していません。ChromeまたはEdge、あるいはデスクトップ版アプリをお使いください。"
    );
  }
  // showDirectoryPicker はユーザー操作直後に呼ぶ必要があるため、awaitより先に実行
  const handle = await (window as any).showDirectoryPicker({ mode: "read" });
  rootHandle = handle;
  await metaSet("rootName", handle.name);
  // ハンドルはIndexedDBに保存でき、次回起動時に権限を再要求して再開できる
  await metaSet("rootHandle", handle);
  return handle.name;
}

async function ensureRoot(): Promise<FileSystemDirectoryHandle | null> {
  if (rootHandle) return rootHandle;
  const h = await metaGet<FileSystemDirectoryHandle>("rootHandle");
  if (!h) return null;
  const perm = await (h as any).queryPermission?.({ mode: "read" });
  if (perm !== "granted") {
    const req = await (h as any).requestPermission?.({ mode: "read" });
    if (req !== "granted") return null;
  }
  rootHandle = h;
  return h;
}

/** ルートフォルダに今アクセスできるか(ドライブ切断・権限喪失の検知)。
 *  権限プロンプトは出さない: メモリにハンドルが無ければ楽観的にtrueを返し、
 *  実際の失敗は各操作(サムネ再生成/PDF)のエラーで穏やかに伝える。 */
async function isRootConnected(): Promise<boolean> {
  if (!rootHandle) return true;
  try {
    const perm = await (rootHandle as any).queryPermission?.({ mode: "read" });
    if (perm === "denied") return false;
    // 1件読めれば接続中とみなす(取り外し済みドライブはここで例外)
    const it = (rootHandle as any).entries?.();
    if (it) await it.next();
    return true;
  } catch {
    return false;
  }
}

/** relPathの元ファイルを取得(読み取りのみ)。ドライブ/権限喪失時はnull */
async function fileOf(rec: Pick<PhotoRec, "pathParts">): Promise<File | null> {
  const root = await ensureRoot();
  if (!root) return null;
  try {
    let dir: FileSystemDirectoryHandle = root;
    for (let i = 0; i < rec.pathParts.length - 1; i++) {
      dir = await dir.getDirectoryHandle(rec.pathParts[i]);
    }
    const fh = await dir.getFileHandle(rec.pathParts[rec.pathParts.length - 1]);
    return await fh.getFile();
  } catch {
    return null;
  }
}

// ---- 画像処理(canvas) ----

async function makeThumbBlob(file: File, maxEdge: number): Promise<Blob | null> {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close();
    return await canvas.convertToBlob({ type: "image/jpeg", quality: 0.8 });
  } catch {
    return null;
  }
}

/** サムネイルBlobから風景らしさ(0..1)。空(上部)・緑・彩度で判定。Rust score.rsと同アルゴリズム */
async function sceneryOf(blob: Blob): Promise<number | null> {
  try {
    const bmp = await createImageBitmap(blob);
    const w = bmp.width;
    const h = bmp.height;
    if (!w || !h) return null;
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    const data = ctx.getImageData(0, 0, w, h).data;
    const topH = Math.floor(h * 0.4);
    let sky = 0;
    let topN = 0;
    let green = 0;
    let colorful = 0;
    let n = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const sat = max === 0 ? 0 : (max - min) / max;
        n++;
        colorful += sat;
        if (y < topH) {
          topN++;
          const bright = (r + g + b) / 3;
          const blueSky = b > r + 20 && b >= g && bright > 90;
          const whiteSky = bright > 200 && sat < 0.12;
          if (blueSky || whiteSky) sky++;
        }
        if (g > r + 12 && g > b + 12) green++;
      }
    }
    const skyF = topN > 0 ? sky / topN : 0;
    const greenF = green / n;
    const satF = colorful / n;
    const s =
      Math.min(skyF * 1.6, 1) * 0.5 +
      Math.min(greenF * 2.5, 1) * 0.35 +
      (Math.min(satF, 0.6) / 0.6) * 0.15;
    return Math.min(s, 1);
  } catch {
    return null;
  }
}

// ---- EXIF ----

function pad(n: number) {
  return String(n).padStart(2, "0");
}
function toTakenAt(d: Date | undefined): string | null {
  if (!d || isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes()
  )}:${pad(d.getSeconds())}`;
}

// ---- 走査 ----

async function* walk(
  dir: FileSystemDirectoryHandle,
  parts: string[]
): AsyncGenerator<{ handle: FileSystemFileHandle; parts: string[] }> {
  for await (const [name, entry] of (dir as any).entries() as AsyncIterable<
    [string, FileSystemHandle]
  >) {
    if (entry.kind === "directory") {
      yield* walk(entry as FileSystemDirectoryHandle, [...parts, name]);
    } else {
      yield { handle: entry as FileSystemFileHandle, parts: [...parts, name] };
    }
  }
}

async function startScan() {
  if (scanning) return;
  const root = await ensureRoot();
  if (!root) {
    emit("scan-error", "フォルダにアクセスできません。もう一度選び直してください。");
    emit("scan-idle", {});
    return;
  }
  scanning = true;
  cancelFlag = false;
  emit("scan-event", { Started: { root: root.name } });

  const d = await db();
  const relIndex = d.transaction("photos").store.index("relPath");
  let nextId = 1;
  {
    // 既存IDの最大値+1
    const all = await d.getAllKeys("photos");
    for (const k of all) nextId = Math.max(nextId, (k as number) + 1);
  }

  let filesSeen = 0;
  let indexed = 0;
  const seenYears = new Set<number>();
  const thumbQueue: PhotoRec[] = [];

  for await (const { handle, parts } of walk(root, [])) {
    if (cancelFlag) break;
    const kind = kindOf(handle.name);
    if (!kind) continue;
    filesSeen++;

    const relPath = parts.join("/");
    let file: File;
    try {
      file = await handle.getFile();
    } catch {
      continue;
    }

    // 差分: relPath一致かつsize/mtime一致ならスキップ
    const existing = (await relIndex.get(relPath)) as PhotoRec | undefined;
    if (existing && existing.size === file.size && existing.mtime === file.lastModified) {
      if (existing.status !== "present") {
        existing.status = "present";
        await d.put("photos", existing);
      }
      indexed++;
      if (existing.takenAt) seenYears.add(Number(existing.takenAt.slice(0, 4)));
      continue;
    }

    let takenAt: string | null = null;
    let cameraModel: string | null = null;
    let orientation: number | null = null;
    let gpsLat: number | null = null;
    let gpsLon: number | null = null;
    if (kind === "image") {
      try {
        const ex = await exifr.parse(file, {
          pick: ["DateTimeOriginal", "CreateDate", "Model", "Orientation", "latitude", "longitude"],
          gps: true,
        });
        if (ex) {
          takenAt = toTakenAt(ex.DateTimeOriginal ?? ex.CreateDate);
          cameraModel = ex.Model ? String(ex.Model).trim() : null;
          orientation = typeof ex.Orientation === "number" ? ex.Orientation : null;
          gpsLat = typeof ex.latitude === "number" ? ex.latitude : null;
          gpsLon = typeof ex.longitude === "number" ? ex.longitude : null;
        }
      } catch {
        /* EXIFなしでも継続 */
      }
    }

    const rec: PhotoRec = {
      id: existing?.id ?? nextId++,
      relPath,
      pathParts: parts,
      fileName: parts[parts.length - 1],
      folder: parts.length >= 2 ? parts[parts.length - 2] : "",
      size: file.size,
      mtime: file.lastModified,
      kind,
      takenAt,
      cameraModel,
      orientation,
      gpsLat,
      gpsLon,
      status: "present",
      hasThumb: existing?.hasThumb ?? false,
    };
    await d.put("photos", rec);
    indexed++;
    if (takenAt) {
      const y = Number(takenAt.slice(0, 4));
      if (!seenYears.has(y)) {
        seenYears.add(y);
        emit("scan-event", { FoundYear: { year: y } });
      }
    }
    if (kind === "image" && !rec.hasThumb) thumbQueue.push(rec);

    if (filesSeen % 25 === 0) {
      emit("scan-event", { Progress: { files_seen: filesSeen, indexed } });
      await new Promise((r) => setTimeout(r, 0)); // UIに制御を返す
    }
  }

  emit("scan-event", { Finished: { stats: { files_seen: filesSeen } } });

  // サムネイル生成(背景・中断可)
  const total = thumbQueue.length;
  for (let i = 0; i < thumbQueue.length; i++) {
    if (cancelFlag) break;
    const rec = thumbQueue[i];
    const file = await fileOf(rec);
    if (file) {
      const blob = await makeThumbBlob(file, 512);
      if (blob) {
        await d.put("thumbs", { photoId: rec.id, blob });
        rec.hasThumb = true;
        await d.put("photos", rec);
      }
    }
    if ((i + 1) % 10 === 0 || i + 1 === total) {
      emit("thumb-progress", { done: i + 1, total });
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  // サムネイル後、おまかせセレクト用スコアを背景採点
  await runScoring();

  scanning = false;
  emit("scan-idle", {});
}

// ---- 背景スコアリング ----

let scoring = false;

/** 連写+風景スコアを全写真に少しずつ付与。score-progressを通知。中断可 */
async function runScoring() {
  const d = await db();
  await computeBursts();
  const scorable = (await allPhotos()).filter(
    (p) => p.status === "present" && p.kind === "image" && p.hasThumb
  );
  const total = scorable.length;
  let done = (await d.getAll("scores") as ScoreRec[]).filter((s) => s.scenery != null).length;
  while (true) {
    if (cancelFlag) break;
    const n = await computeVisualScores(40);
    if (n === 0) break;
    done += n;
    emit("score-progress", { done, total });
    await new Promise((r) => setTimeout(r, 0));
  }
}

/** 背景採点を開始(走査/採点中なら何もしない)。UIがホーム表示時に呼ぶ */
async function ensureScoring() {
  if (scanning || scoring) return;
  scoring = true;
  try {
    await runScoring();
  } finally {
    scoring = false;
    emit("score-idle", {});
  }
}

// ---- サムネイルURLキャッシュ ----

const thumbUrlCache = new Map<number, string>();
async function thumbUrl(photoId: number, hasThumb: boolean): Promise<string | null> {
  if (!hasThumb) return null;
  const cached = thumbUrlCache.get(photoId);
  if (cached) return cached;
  const row = await (await db()).get("thumbs", photoId);
  if (!row?.blob) return null;
  const url = URL.createObjectURL(row.blob);
  thumbUrlCache.set(photoId, url);
  return url;
}

// ---- 発掘ロジック(Rust batch.rs の移植) ----

type PhotoOut = {
  id: number;
  fileName: string;
  folder: string;
  takenAt: string | null;
  cameraModel: string | null;
  thumbAbs: string | null;
};

async function toOut(rec: PhotoRec): Promise<PhotoOut> {
  return {
    id: rec.id,
    fileName: rec.fileName,
    folder: rec.folder,
    takenAt: rec.takenAt,
    cameraModel: rec.cameraModel,
    thumbAbs: await thumbUrl(rec.id, rec.hasThumb),
  };
}

function spread<T>(arr: T[], max: number): T[] {
  if (arr.length <= max) return arr;
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(arr[Math.floor((i * (arr.length - 1)) / (max - 1))]);
  return out;
}

const now = () => Date.now();
const DAY = 86400_000;

async function allPhotos(): Promise<PhotoRec[]> {
  return (await (await db()).getAll("photos")) as PhotoRec[];
}
async function triageMap(): Promise<Map<number, TriageRec>> {
  const rows = (await (await db()).getAll("triage")) as TriageRec[];
  return new Map(rows.map((r) => [r.photoId, r]));
}

/** 候補プール: present画像で、keep/skip除外、laterは7日経過で復帰 */
async function pool(): Promise<PhotoRec[]> {
  const tri = await triageMap();
  return (await allPhotos()).filter((p) => {
    if (p.status !== "present" || p.kind !== "image") return false;
    const t = tri.get(p.id);
    if (!t) return true;
    if (t.decision === "later" && now() - t.decidedAt > 7 * DAY) return true;
    return false;
  });
}

function tsOfDay(takenAt: string): number | null {
  if (takenAt.length < 19) return null;
  const d = Number(takenAt.slice(8, 10));
  const h = Number(takenAt.slice(11, 13));
  const m = Number(takenAt.slice(14, 16));
  const s = Number(takenAt.slice(17, 19));
  return ((d * 24 + h) * 60 + m) * 60 + s;
}

async function makeBatch(theme: string, title: string, subtitle: string, ps: PhotoRec[], max = 8) {
  const chosen = spread(ps, max);
  return { theme, title, subtitle, photos: await Promise.all(chosen.map(toOut)) };
}

const THIS_YEAR = new Date().getFullYear();
const THIS_MONTH = new Date().getMonth() + 1;

async function nextBatch() {
  const cand = await pool();
  if (cand.length === 0) return null;

  // N年前の今月
  const sameMonth = cand.filter(
    (p) =>
      p.takenAt &&
      Number(p.takenAt.slice(5, 7)) === THIS_MONTH &&
      Number(p.takenAt.slice(0, 4)) < THIS_YEAR
  );
  if (sameMonth.length >= 3) {
    // 年月ごとにまとめ、3枚以上ある最古の年月を選ぶ
    const byYm = new Map<string, PhotoRec[]>();
    for (const p of sameMonth) {
      const ym = p.takenAt!.slice(0, 7);
      byYm.set(ym, [...(byYm.get(ym) ?? []), p]);
    }
    const groups = [...byYm.entries()].filter(([, v]) => v.length >= 3).sort();
    if (groups.length > 0) {
      const [ym, g] = groups[Math.floor(Math.random() * groups.length)];
      const year = Number(ym.slice(0, 4));
      return makeBatch("years_ago_month", `${THIS_YEAR - year}年前の今月`, `${year}年${THIS_MONTH}月`, g);
    }
  }

  // ある一日(4枚以上)
  const byDay = new Map<string, PhotoRec[]>();
  for (const p of cand) {
    if (!p.takenAt) continue;
    const day = p.takenAt.slice(0, 10);
    byDay.set(day, [...(byDay.get(day) ?? []), p]);
  }
  const days = [...byDay.entries()].filter(([, v]) => v.length >= 4);
  if (days.length > 0) {
    const [day, g] = days[Math.floor(Math.random() * days.length)];
    const [y, m, dd] = [day.slice(0, 4), Number(day.slice(5, 7)), Number(day.slice(8, 10))];
    return makeBatch("one_day", "ある一日の記録", `${y}年${m}月${dd}日`, g);
  }

  // 同じフォルダ(3枚以上)
  const byFolder = new Map<string, PhotoRec[]>();
  for (const p of cand) {
    if (!p.folder) continue;
    byFolder.set(p.folder, [...(byFolder.get(p.folder) ?? []), p]);
  }
  const folders = [...byFolder.entries()].filter(([, v]) => v.length >= 3);
  if (folders.length > 0) {
    const [folder, g] = folders[Math.floor(Math.random() * folders.length)];
    return makeBatch("folder", "アルバムから", folder, g);
  }

  // フォールバック: 無作為
  const shuffled = [...cand].sort(() => Math.random() - 0.5).slice(0, 8);
  return makeBatch("random", "眠っていた写真たち", "", shuffled);
}

async function customBatch(year: string | null, keyword: string | null, limit: number) {
  let cand = await pool();
  if (year) cand = cand.filter((p) => p.takenAt?.startsWith(year));
  const kw = (keyword ?? "").trim();
  if (kw) cand = cand.filter((p) => p.relPath.includes(kw));
  if (cand.length === 0) return null;
  const title =
    year && kw
      ? `${year}年・「${kw}」`
      : year
      ? `${year}年の写真`
      : kw
      ? `「${kw}」の写真`
      : "えらんだ写真";
  return makeBatch("custom", title, "", cand, Math.min(Math.max(limit, 1), 30));
}

// ---- スコア(連写・風景) ----

async function computeBursts() {
  const d = await db();
  const imgs = (await allPhotos())
    .filter((p) => p.status === "present" && p.kind === "image" && p.takenAt)
    .sort((a, b) => a.takenAt!.localeCompare(b.takenAt!));
  const chains: PhotoRec[][] = [];
  let cur: PhotoRec[] = [];
  let last: { day: string; ts: number } | null = null;
  for (const p of imgs) {
    const day = p.takenAt!.slice(0, 10);
    const ts = tsOfDay(p.takenAt!);
    if (ts == null) continue;
    const cont = last && last.day === day && ts - last.ts <= 180;
    if (cont) cur.push(p);
    else {
      if (cur.length) chains.push(cur);
      cur = [p];
    }
    last = { day, ts };
  }
  if (cur.length) chains.push(cur);
  for (const chain of chains) {
    for (const p of chain) {
      const prev = (await d.get("scores", p.id)) as ScoreRec | undefined;
      await d.put("scores", {
        photoId: p.id,
        burstSize: chain.length,
        burstId: chain[0].id,
        scenery: prev?.scenery ?? null,
        faces: -1,
      });
    }
  }
}

/** 風景スコア未計算の写真を最大limit件処理 */
async function computeVisualScores(limit: number) {
  const d = await db();
  const photos = (await allPhotos()).filter(
    (p) => p.status === "present" && p.kind === "image" && p.hasThumb
  );
  let done = 0;
  for (const p of photos) {
    if (done >= limit) break;
    const sc = (await d.get("scores", p.id)) as ScoreRec | undefined;
    if (sc && sc.scenery != null) continue;
    const row = await d.get("thumbs", p.id);
    const scenery = row?.blob ? (await sceneryOf(row.blob)) ?? 0 : 0;
    await d.put("scores", {
      photoId: p.id,
      burstSize: sc?.burstSize ?? 1,
      burstId: sc?.burstId ?? p.id,
      scenery,
      faces: -1,
    });
    done++;
  }
  return done;
}

async function autoSelect(year: string | null, limit: number) {
  // スコアは背景採点(runScoring)が付与。ここは連写だけ確定し既存スコアで即選抜
  await computeBursts();
  const d = await db();
  const tri = await triageMap();
  const scores = new Map<number, ScoreRec>(
    ((await d.getAll("scores")) as ScoreRec[]).map((s) => [s.photoId, s])
  );
  let cand = (await allPhotos()).filter((p) => {
    if (p.status !== "present" || p.kind !== "image" || !p.hasThumb) return false;
    const t = tri.get(p.id);
    return !t || t.decision !== "skip";
  });
  if (year) cand = cand.filter((p) => p.takenAt?.startsWith(year));

  const scored = cand.map((p) => {
    const s = scores.get(p.id);
    const burst = s?.burstSize ?? 1;
    const scenery = s?.scenery ?? 0;
    const burstBonus = Math.min(Math.log(burst) / Math.log(3), 1.5) * 0.3;
    const score = scenery * 0.6 + burstBonus; // faces=-1 → ボーナス0
    return { p, score, burstId: s?.burstId ?? p.id };
  });
  scored.sort((a, b) => b.score - a.score);

  const usedBursts = new Set<number>();
  const perDay = new Map<string, number>();
  const picks: PhotoRec[] = [];
  for (const { p, burstId } of scored) {
    if (usedBursts.has(burstId)) continue;
    const day = p.takenAt?.slice(0, 10) ?? "?";
    if ((perDay.get(day) ?? 0) >= 3) continue;
    usedBursts.add(burstId);
    perDay.set(day, (perDay.get(day) ?? 0) + 1);
    picks.push(p);
    if (picks.length >= limit) break;
  }
  if (picks.length === 0) return null;
  return makeBatch(
    "auto",
    "おまかせセレクト",
    year ? `${year}年` : "",
    picks,
    Math.min(Math.max(limit, 1), 30)
  );
}

// ---- コマンドディスパッチ(Rust invokeと同じ体系) ----

export async function webCall<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const d = await db();
  switch (cmd) {
    case "get_overview": {
      const photos = await allPhotos();
      const present = photos.filter((p) => p.status === "present");
      const totalPhotos = present.filter((p) => p.kind === "image").length;
      const rawHeic = present.filter((p) => p.kind !== "image").length;
      const tri = (await d.getAll("triage")) as TriageRec[];
      const kept = tri.filter((t) => t.decision === "keep").length;
      const shioriCount = (await d.count("shiori")) as number;
      const yearsMap = new Map<string, number>();
      for (const p of present) {
        if (p.kind === "image" && p.takenAt) {
          const y = p.takenAt.slice(0, 4);
          yearsMap.set(y, (yearsMap.get(y) ?? 0) + 1);
        }
      }
      const rootName = await metaGet<string>("rootName");
      const hasRoot = rootHandle != null || (await metaGet("rootHandle")) != null;
      const roots =
        hasRoot && rootName ? [{ name: rootName, connected: await isRootConnected() }] : [];
      return {
        totalPhotos,
        kept,
        rawHeic,
        shioriCount,
        years: [...yearsMap.entries()].sort().map(([year, count]) => ({ year, count })),
        roots,
        scanning,
      } as T;
    }
    case "start_scan":
      startScan(); // 非同期・awaitしない
      return undefined as T;
    case "cancel_scan":
      cancelFlag = true;
      return undefined as T;
    case "ensure_scoring":
      ensureScoring(); // 非同期・awaitしない
      return undefined as T;
    case "next_batch":
      return (await nextBatch()) as T;
    case "custom_batch":
      return (await customBatch(
        (args.year as string | null) ?? null,
        (args.keyword as string | null) ?? null,
        Number(args.limit) || 10
      )) as T;
    case "pool_years": {
      const m = new Map<string, number>();
      for (const p of await pool()) {
        if (p.takenAt) {
          const y = p.takenAt.slice(0, 4);
          m.set(y, (m.get(y) ?? 0) + 1);
        }
      }
      return [...m.entries()].sort().map(([year, count]) => ({ year, count })) as T;
    }
    case "auto_select_batch": {
      const res = await autoSelect((args.year as string | null) ?? null, Number(args.limit) || 10);
      ensureScoring(); // 背景採点を(まだなら)起動し、次回以降の質を上げる
      return res as T;
    }
    case "triage_photo": {
      await d.put("triage", {
        photoId: Number(args.photoId),
        decision: args.decision as TriageRec["decision"],
        decidedAt: now(),
      });
      return undefined as T;
    }
    case "list_kept": {
      const tri = await triageMap();
      const kept = (await allPhotos())
        .filter((p) => p.status === "present" && tri.get(p.id)?.decision === "keep")
        .sort((a, b) => (a.takenAt ?? "").localeCompare(b.takenAt ?? ""));
      return (await Promise.all(kept.map(toOut))) as T;
    }
    case "create_shiori": {
      const ids = (args.photoIds as number[]) ?? [];
      let sid = 1;
      for (const k of await d.getAllKeys("shiori")) sid = Math.max(sid, (k as number) + 1);
      const rec: ShioriRec = {
        id: sid,
        title: String(args.title ?? "").trim(),
        note: String(args.note ?? "").trim(),
        takenLabel: String(args.takenLabel ?? ""),
        createdAt: new Date().toISOString(),
      };
      await d.put("shiori", rec);
      for (let i = 0; i < ids.length; i++) {
        await d.put("shioriPhotos", { shioriId: sid, photoId: ids[i], position: i } as ShioriPhotoRec);
      }
      return sid as T;
    }
    case "list_shiori": {
      const shioris = ((await d.getAll("shiori")) as ShioriRec[]).sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt)
      );
      const photosById = new Map((await allPhotos()).map((p) => [p.id, p]));
      const out = [];
      for (const s of shioris) {
        const links = ((await d.getAllFromIndex("shioriPhotos", "shioriId", s.id)) as ShioriPhotoRec[]).sort(
          (a, b) => a.position - b.position
        );
        const photos = [];
        for (const l of links) {
          const p = photosById.get(l.photoId);
          if (p) photos.push(await toOut(p));
        }
        out.push({ ...s, photos });
      }
      return out as T;
    }
    default:
      throw new Error(`web未対応コマンド: ${cmd}`);
  }
}

/** 写真の入っているフォルダ情報(ブラウザではOSフォルダは開けないため、場所を返す) */
export async function webPhotoLocation(photoId: number): Promise<string | null> {
  const rec = (await (await db()).get("photos", photoId)) as PhotoRec | undefined;
  if (!rec) return null;
  const rootName = (await metaGet<string>("rootName")) ?? "";
  return [rootName, ...rec.pathParts].join("/");
}

/** PDF用の高解像度JPEG。元ファイルを読み直して1600pxへ */
export async function webPhotoJpegBytes(photoId: number): Promise<Uint8Array> {
  const rec = (await (await db()).get("photos", photoId)) as PhotoRec | undefined;
  if (!rec) throw new Error("写真が見つかりません");
  const file = await fileOf(rec);
  if (!file) throw new Error("元写真にアクセスできません(フォルダの選び直しが必要かもしれません)");
  const blob = await makeThumbBlob(file, 1600);
  if (!blob) throw new Error("画像を変換できませんでした");
  return new Uint8Array(await blob.arrayBuffer());
}
