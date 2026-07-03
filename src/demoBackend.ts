// ブラウザデモ用バックエンド。Rust側コマンドの挙動をサンプルデータで再現する。
// 実アプリの安全原則(ローカル読み取り専用)を体験者に伝えるため、UIは共通のまま。

type DemoPhoto = {
  id: number;
  fileName: string;
  folder: string;
  takenAt: string | null;
  cameraModel: string | null;
  thumbAbs: string;
  scenery: number; // 0..1 風景らしさ(デモでは擬似値)
  burstKey: string; // 連写グループ(デモではフォルダ+時分で近似)
};

type Decision = "keep" | "later" | "skip";

const now = new Date();
const THIS_YEAR = now.getFullYear();
const THIS_MONTH = now.getMonth() + 1;

let seq = 1;
function photo(
  folder: string,
  date: string,
  time: string,
  scenery: number,
  seed?: string
): DemoPhoto {
  const id = seq++;
  return {
    id,
    fileName: `IMG_${String(id).padStart(4, "0")}.jpg`,
    folder,
    takenAt: `${date} ${time}`,
    cameraModel: "DEMO-CAM X100",
    thumbAbs: `https://picsum.photos/seed/${seed ?? `shosai${id}`}/640/480`,
    scenery,
    burstKey: `${folder}/${date} ${time.slice(0, 4)}`,
  };
}

function series(
  folder: string,
  date: string,
  startHour: number,
  n: number,
  scenery: number[]
): DemoPhoto[] {
  return Array.from({ length: n }, (_, i) =>
    photo(
      folder,
      date,
      `${String(startHour + Math.floor(i / 2)).padStart(2, "0")}:${String((i * 17) % 60).padStart(2, "0")}:00`,
      scenery[i % scenery.length]
    )
  );
}

// 「N年前の今月」テーマが体験できるよう、今月の過去写真を必ず含める
const monthStr = String(THIS_MONTH).padStart(2, "0");

const photos: DemoPhoto[] = [
  ...series("2009-05 京都の旅", "2009-05-12", 9, 5, [0.55, 0.4, 0.7, 0.3, 0.6]),
  ...series("2011-10 秋祭り", "2011-10-09", 10, 6, [0.35, 0.3, 0.5, 0.25, 0.4, 0.45]),
  ...series("2013-08 富士山", "2013-08-03", 8, 6, [0.9, 0.85, 0.7, 0.95, 0.6, 0.8]),
  ...series("2016-04 桜", "2016-04-02", 11, 4, [0.75, 0.65, 0.7, 0.6]),
  ...series(`${THIS_YEAR - 4}-${monthStr} 海辺の旅`, `${THIS_YEAR - 4}-${monthStr}-18`, 9, 5, [
    0.8, 0.85, 0.75, 0.9, 0.7,
  ]),
  ...series("2019-11 競馬場", "2019-11-24", 12, 5, [0.45, 0.4, 0.5, 0.35, 0.42]),
  // 連写(同じ時分に5枚): 良い撮影スポットの再現
  ...Array.from({ length: 5 }, (_, i) =>
    photo("2019-11 競馬場", "2019-11-24", `13:1${i}:00`, 0.62, `burst${i}`)
  ).map((p) => ({ ...p, burstKey: "2019-11 競馬場/burst" })),
  ...series("2024-01 初詣", "2024-01-02", 10, 3, [0.3, 0.35, 0.4]),
];

const triage = new Map<number, Decision>();
type DemoShiori = {
  id: number;
  title: string;
  note: string;
  takenLabel: string;
  createdAt: string;
  photos: DemoPhoto[];
};
const shioriList: DemoShiori[] = [];
let shioriSeq = 1;
let scanned = false;
let scanning = false;

// ---- イベント ----
const listeners = new Map<string, Set<(payload: any) => void>>();

export function demoListen(event: string, cb: (payload: any) => void): () => void {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event)!.add(cb);
  return () => listeners.get(event)?.delete(cb);
}

function emit(event: string, payload: any) {
  listeners.get(event)?.forEach((cb) => cb(payload));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function simulateScan() {
  if (scanning) return;
  scanning = true;
  emit("scan-event", { Started: { root: "デモ写真(サンプル)" } });
  const years = [...new Set(photos.map((p) => p.takenAt!.slice(0, 4)))].sort();
  let seen = 0;
  for (const y of years) {
    await sleep(350);
    seen += Math.floor(photos.length / years.length);
    emit("scan-event", { FoundYear: { year: Number(y) } });
    emit("scan-event", { Progress: { files_seen: seen, indexed: seen } });
  }
  await sleep(400);
  emit("scan-event", {
    Finished: { stats: { files_seen: photos.length } },
  });
  scanned = true;
  scanning = false;
  emit("scan-idle", {});
}

// ---- 発掘ロジック(Rust側の簡易移植) ----

function pool(): DemoPhoto[] {
  return scanned ? photos.filter((p) => !triage.has(p.id)) : [];
}

function spread<T>(arr: T[], max: number): T[] {
  if (arr.length <= max) return arr;
  const out: T[] = [];
  for (let i = 0; i < max; i++) {
    out.push(arr[Math.floor((i * (arr.length - 1)) / (max - 1))]);
  }
  return out;
}

function toOut(p: DemoPhoto) {
  const { scenery, burstKey, ...rest } = p;
  void scenery;
  void burstKey;
  return rest;
}

function makeBatch(theme: string, title: string, subtitle: string, ps: DemoPhoto[], max = 8) {
  return { theme, title, subtitle, photos: spread(ps, max).map(toOut) };
}

function nextBatch() {
  const cand = pool();
  if (cand.length === 0) return null;
  // N年前の今月
  const ym = cand.filter(
    (p) => p.takenAt && Number(p.takenAt.slice(5, 7)) === THIS_MONTH && Number(p.takenAt.slice(0, 4)) < THIS_YEAR
  );
  if (ym.length >= 3) {
    const year = ym[0].takenAt!.slice(0, 4);
    const g = ym.filter((p) => p.takenAt!.startsWith(year));
    if (g.length >= 3) {
      return makeBatch(
        "years_ago_month",
        `${THIS_YEAR - Number(year)}年前の今月`,
        `${year}年${THIS_MONTH}月`,
        g
      );
    }
  }
  // ある一日
  const byDay = new Map<string, DemoPhoto[]>();
  for (const p of cand) {
    if (!p.takenAt) continue;
    const d = p.takenAt.slice(0, 10);
    byDay.set(d, [...(byDay.get(d) ?? []), p]);
  }
  const days = [...byDay.entries()].filter(([, v]) => v.length >= 4);
  if (days.length > 0) {
    const [d, g] = days[Math.floor(Math.random() * days.length)];
    const [y, m, dd] = [d.slice(0, 4), Number(d.slice(5, 7)), Number(d.slice(8, 10))];
    return makeBatch("one_day", "ある一日の記録", `${y}年${m}月${dd}日`, g);
  }
  return makeBatch("random", "眠っていた写真たち", "", cand.slice(0, 8));
}

// ---- コマンドディスパッチ ----

export async function demoCall<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  await sleep(120); // 体感用の小さな遅延
  switch (cmd) {
    case "get_overview": {
      const yearsMap = new Map<string, number>();
      if (scanned) {
        for (const p of photos) {
          const y = p.takenAt!.slice(0, 4);
          yearsMap.set(y, (yearsMap.get(y) ?? 0) + 1);
        }
      }
      return {
        totalPhotos: scanned ? photos.length : 0,
        kept: [...triage.values()].filter((d) => d === "keep").length,
        rawHeic: scanned ? 2 : 0,
        shioriCount: shioriList.length,
        years: [...yearsMap.entries()].sort().map(([year, count]) => ({ year, count })),
        roots: scanned ? ["デモ写真(サンプル)"] : [],
        scanning,
      } as T;
    }
    case "start_scan":
      simulateScan();
      return undefined as T;
    case "cancel_scan":
      return undefined as T;
    case "next_batch":
      return nextBatch() as T;
    case "custom_batch": {
      const year = (args.year as string | null) ?? null;
      const kw = ((args.keyword as string | null) ?? "").trim();
      const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 30);
      let cand = pool();
      if (year) cand = cand.filter((p) => p.takenAt?.startsWith(year));
      if (kw) cand = cand.filter((p) => p.folder.includes(kw) || p.fileName.includes(kw));
      if (cand.length === 0) return null as T;
      const title =
        year && kw ? `${year}年・「${kw}」` : year ? `${year}年の写真` : kw ? `「${kw}」の写真` : "えらんだ写真";
      return makeBatch("custom", title, "", cand, limit) as T;
    }
    case "pool_years": {
      const m = new Map<string, number>();
      for (const p of pool()) {
        const y = p.takenAt!.slice(0, 4);
        m.set(y, (m.get(y) ?? 0) + 1);
      }
      return [...m.entries()].sort().map(([year, count]) => ({ year, count })) as T;
    }
    case "auto_select_batch": {
      await sleep(1200); // 解析している感
      const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 30);
      const seen = new Set<string>();
      const perDay = new Map<string, number>();
      const picks: DemoPhoto[] = [];
      const sorted = [...pool()].sort((a, b) => b.scenery - a.scenery);
      for (const p of sorted) {
        if (seen.has(p.burstKey)) continue;
        const day = p.takenAt?.slice(0, 10) ?? "?";
        if ((perDay.get(day) ?? 0) >= 3) continue;
        seen.add(p.burstKey);
        perDay.set(day, (perDay.get(day) ?? 0) + 1);
        picks.push(p);
        if (picks.length >= limit) break;
      }
      if (picks.length === 0) return null as T;
      return makeBatch("auto", "おまかせセレクト", "", picks, limit) as T;
    }
    case "triage_photo": {
      triage.set(Number(args.photoId), args.decision as Decision);
      return undefined as T;
    }
    case "list_kept": {
      return photos
        .filter((p) => triage.get(p.id) === "keep")
        .map(toOut) as T;
    }
    case "create_shiori": {
      const ids = (args.photoIds as number[]) ?? [];
      const s: DemoShiori = {
        id: shioriSeq++,
        title: String(args.title ?? ""),
        note: String(args.note ?? "").trim(),
        takenLabel: String(args.takenLabel ?? ""),
        createdAt: new Date().toISOString(),
        photos: photos.filter((p) => ids.includes(p.id)),
      };
      shioriList.unshift(s);
      return s.id as T;
    }
    case "list_shiori": {
      return shioriList.map((s) => ({ ...s, photos: s.photos.map(toOut) })) as T;
    }
    default:
      throw new Error(`demo未対応コマンド: ${cmd}`);
  }
}
