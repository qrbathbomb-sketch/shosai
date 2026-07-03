import { useCallback, useEffect, useState } from "react";
import {
  call,
  on,
  pickDirectory,
  fileSrc,
  isWeb,
  photoJpegBytes,
  savePdf,
  revealPhoto,
} from "./backend";
import "./App.css";

type Overview = {
  totalPhotos: number;
  kept: number;
  rawHeic: number;
  shioriCount: number;
  years: { year: string; count: number }[];
  roots: string[];
  scanning: boolean;
};

type Photo = {
  id: number;
  fileName: string;
  folder: string;
  takenAt: string | null;
  cameraModel: string | null;
  thumbAbs: string | null;
};

type Batch = {
  theme: string;
  title: string;
  subtitle: string;
  photos: Photo[];
};

type Shiori = {
  id: number;
  title: string;
  note: string;
  takenLabel: string;
  createdAt: string;
  photos: Photo[];
};

type ScanInfo = {
  root: string;
  filesSeen: number;
  indexed: number;
  years: number[];
  finished: boolean;
  thumbDone: number;
  thumbTotal: number;
  error: string | null;
};

const emptyScan: ScanInfo = {
  root: "",
  filesSeen: 0,
  indexed: 0,
  years: [],
  finished: false,
  thumbDone: 0,
  thumbTotal: 0,
  error: null,
};

type View =
  | "loading"
  | "start"
  | "scanning"
  | "home"
  | "picker"
  | "autoLoading"
  | "kept"
  | "batch"
  | "focus"
  | "compose"
  | "shioriDone"
  | "library"
  | "shioriDetail"
  | "done";

function formatDate(takenAt: string | null): string {
  if (!takenAt) return "撮影日は不明";
  const y = takenAt.slice(0, 4);
  const m = String(Number(takenAt.slice(5, 7)));
  const d = String(Number(takenAt.slice(8, 10)));
  return `${y}年${m}月${d}日`;
}

/** 選んだ写真たちの日付から「2011年10月9日」「2011年10月」「2009年〜2013年」を作る */
function takenLabelOf(photos: Photo[]): string {
  const dates = photos.map((p) => p.takenAt).filter((t): t is string => !!t);
  if (dates.length === 0) return "";
  const days = [...new Set(dates.map((t) => t.slice(0, 10)))];
  if (days.length === 1) return formatDate(dates[0]);
  const months = [...new Set(dates.map((t) => t.slice(0, 7)))];
  if (months.length === 1) {
    const y = months[0].slice(0, 4);
    const m = String(Number(months[0].slice(5, 7)));
    return `${y}年${m}月`;
  }
  const years = [...new Set(dates.map((t) => t.slice(0, 4)))].sort();
  return years.length === 1 ? `${years[0]}年` : `${years[0]}年〜${years[years.length - 1]}年`;
}

function thumbSrc(thumbAbs: string): string {
  return fileSrc(thumbAbs);
}

/** しおり本体の表示(一覧カードと詳細で共用)。品質最重視の箇所 */
function ShioriCard({ shiori, large }: { shiori: Shiori; large?: boolean }) {
  const n = shiori.photos.length;
  return (
    <article className={`shiori ${large ? "shiori-large" : ""} photos-${n}`}>
      <div className="shiori-photos">
        {shiori.photos.map((p, i) => (
          <div className={`shiori-photo pos-${i}`} key={p.id}>
            {p.thumbAbs && <img src={thumbSrc(p.thumbAbs)} alt="" />}
          </div>
        ))}
      </div>
      <div className="shiori-text">
        {shiori.takenLabel && shiori.takenLabel !== shiori.title && (
          <p className="shiori-date">{shiori.takenLabel}</p>
        )}
        <h3 className="shiori-title">{shiori.title}</h3>
        {shiori.note && <p className="shiori-note">{shiori.note}</p>}
      </div>
    </article>
  );
}

function App() {
  const [view, setView] = useState<View>("loading");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [scan, setScan] = useState<ScanInfo>(emptyScan);
  const [batch, setBatch] = useState<Batch | null>(null);
  const [focusIdx, setFocusIdx] = useState(0);
  const [keptPhotos, setKeptPhotos] = useState<Photo[]>([]);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [note, setNote] = useState("");
  const [lastShiori, setLastShiori] = useState<Shiori | null>(null);
  const [library, setLibrary] = useState<Shiori[]>([]);
  const [detail, setDetail] = useState<Shiori | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // 行き先を選んで発掘
  const [pickYears, setPickYears] = useState<{ year: string; count: number }[]>([]);
  const [selYear, setSelYear] = useState<string | null>(null);
  const [keyword, setKeyword] = useState("");
  const [pickLimit, setPickLimit] = useState(10);
  const [keptGrid, setKeptGrid] = useState<Photo[]>([]);

  const refreshOverview = useCallback(async (): Promise<Overview> => {
    const ov = await call<Overview>("get_overview");
    setOverview(ov);
    return ov;
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const ov = await refreshOverview();
        if (ov.scanning) setView("scanning");
        else if (ov.totalPhotos > 0 || ov.roots.length > 0) setView("home");
        else setView("start");
      } catch (e) {
        setNotice(String(e));
        setView("start");
      }
    })();
  }, [refreshOverview]);

  useEffect(() => {
    const unlisteners: Promise<() => void>[] = [
      on("scan-event", (p: Record<string, any>) => {
        if ("Started" in p) {
          setScan((s) => ({ ...emptyScan, root: p.Started.root || s.root }));
        } else if ("Progress" in p) {
          setScan((s) => ({ ...s, filesSeen: p.Progress.files_seen, indexed: p.Progress.indexed }));
        } else if ("FoundYear" in p) {
          setScan((s) =>
            s.years.includes(p.FoundYear.year) ? s : { ...s, years: [...s.years, p.FoundYear.year] }
          );
        } else if ("Finished" in p) {
          setScan((s) => ({ ...s, filesSeen: p.Finished.stats.files_seen }));
        }
      }),
      on("thumb-progress", (p: { done: number; total: number }) => {
        setScan((s) => ({ ...s, thumbDone: p.done, thumbTotal: p.total }));
      }),
      on("scan-error", (p: string) => {
        setScan((s) => ({ ...s, error: p }));
      }),
      on("scan-idle", async () => {
        const ov = await call<Overview>("get_overview");
        setOverview(ov);
        setScan((s) => ({ ...s, finished: true }));
      }),
    ];
    return () => {
      unlisteners.forEach((u) => u.then((f) => f()));
    };
  }, []);

  const pickFolder = async () => {
    const dir = await pickDirectory();
    if (dir) {
      setScan({ ...emptyScan, root: dir });
      setView("scanning");
      try {
        await call("start_scan", { path: dir });
      } catch (e) {
        setScan((s) => ({ ...s, error: String(e) }));
      }
    }
  };

  const startBatch = async () => {
    setNotice(null);
    const b = await call<Batch | null>("next_batch");
    if (!b || b.photos.length === 0) {
      setNotice("今は発掘できる写真がありません。フォルダを追加するか、また今度お越しください。");
      setView("home");
      return;
    }
    setBatch(b);
    setFocusIdx(0);
    setKeptPhotos([]);
    setView("batch");
  };

  const decide = async (decision: "keep" | "later" | "skip") => {
    if (!batch) return;
    const photo = batch.photos[focusIdx];
    try {
      await call("triage_photo", { photoId: photo.id, decision });
    } catch (e) {
      setNotice(String(e));
      return;
    }
    const kept = decision === "keep" ? [...keptPhotos, photo] : keptPhotos;
    if (decision === "keep") setKeptPhotos(kept);
    if (focusIdx + 1 < batch.photos.length) {
      setFocusIdx(focusIdx + 1);
    } else {
      await refreshOverview();
      if (kept.length > 0) {
        setSelectedIds(kept.slice(0, 3).map((p) => p.id));
        setNote("");
        setView("compose");
      } else {
        setView("done");
      }
    }
  };

  const toggleSelect = (id: number) => {
    setSelectedIds((ids) => {
      if (ids.includes(id)) return ids.filter((x) => x !== id);
      if (ids.length >= 3) return ids; // 3枚まで
      return [...ids, id];
    });
  };

  const makeShiori = async () => {
    if (!batch || selectedIds.length === 0) return;
    const chosen = keptPhotos.filter((p) => selectedIds.includes(p.id));
    // タイトルは本人が付けたフォルダ名を最優先(最も本人の言葉に近い)
    const folders = chosen.map((p) => p.folder).filter(Boolean);
    const folderMode = folders.sort(
      (a, b) =>
        folders.filter((f) => f === b).length - folders.filter((f) => f === a).length
    )[0];
    const title = folderMode || batch.subtitle || batch.title;
    const takenLabel = takenLabelOf(chosen);
    try {
      const id = await call<number>("create_shiori", {
        title,
        note,
        takenLabel,
        photoIds: chosen.map((p) => p.id),
      });
      setLastShiori({
        id,
        title,
        note: note.trim(),
        takenLabel,
        createdAt: "",
        photos: chosen,
      });
      await refreshOverview();
      setView("shioriDone");
    } catch (e) {
      setNotice(String(e));
    }
  };

  const openLibrary = async () => {
    const list = await call<Shiori[]>("list_shiori");
    setLibrary(list);
    setView("library");
  };

  const openPicker = async () => {
    setNotice(null);
    const years = await call<{ year: string; count: number }[]>("pool_years");
    setPickYears(years);
    setSelYear(null);
    setKeyword("");
    setView("picker");
  };

  const startCustom = async () => {
    setNotice(null);
    const b = await call<Batch | null>("custom_batch", {
      year: selYear,
      keyword: keyword.trim() || null,
      limit: pickLimit,
    });
    if (!b || b.photos.length === 0) {
      setNotice("この条件に合う写真は、いまは残っていません。");
      return;
    }
    setBatch(b);
    setFocusIdx(0);
    setKeptPhotos([]);
    setView("batch");
  };

  const startAuto = async () => {
    setNotice(null);
    setView("autoLoading");
    try {
      const b = await call<Batch | null>("auto_select_batch", { year: null, limit: 10 });
      if (!b || b.photos.length === 0) {
        setNotice("選べる写真がまだありません。先に読み取りを済ませてください。");
        setView("home");
        return;
      }
      setBatch(b);
      setFocusIdx(0);
      setKeptPhotos([]);
      setView("batch");
    } catch (e) {
      setNotice(String(e));
      setView("home");
    }
  };

  const openKept = async () => {
    const list = await call<Photo[]>("list_kept");
    setKeptGrid(list);
    setView("kept");
  };

  const [exporting, setExporting] = useState(false);

  const openPhotoFolder = async (photoId: number) => {
    try {
      const location = await revealPhoto(photoId);
      if (location) {
        // ブラウザ版: OSフォルダは開けないため場所を表示
        setNotice(`保存場所: ${location}`);
      }
    } catch (e) {
      setNotice(String(e));
    }
  };

  const exportPdf = async (s: Shiori) => {
    if (exporting) return;
    setExporting(true);
    setNotice(null);
    try {
      const { buildShioriPdf } = await import("./pdf");
      const photos = [];
      for (const p of s.photos) {
        photos.push({ bytes: await photoJpegBytes(p) });
      }
      const bytes = await buildShioriPdf({
        title: s.title,
        note: s.note,
        takenLabel: s.takenLabel,
        photos,
      });
      const safe = s.title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 40) || "しおり";
      const ok = await savePdf(`しおり_${safe}.pdf`, bytes);
      if (ok) setNotice("PDFを保存しました。印刷にも使えます。");
    } catch (e) {
      setNotice(`PDFの作成に失敗しました: ${e}`);
    } finally {
      setExporting(false);
    }
  };

  // ---------- 画面 ----------

  if (view === "loading") {
    return <main className="page center-page">読み込んでいます…</main>;
  }

  if (view === "start") {
    return (
      <main className="page center-page">
        <h1 className="app-title">写真の書斎</h1>
        <p className="lead">
          パソコンやドライブに眠っている写真を、少しずつ掘り起こして
          <br />
          あなたの記録と作品に変えていくソフトです。
        </p>
        <button className="btn primary big" onClick={pickFolder}>
          写真が入っている場所を選ぶ
        </button>
        {isWeb && (
          <p className="small gray">
            この画面はブラウザ版です。選んだフォルダの写真は、あなたのパソコンの中だけで読み取ります(どこにも送信しません)。
            <br />
            ※ ChromeまたはEdgeが必要です。常に使うならデスクトップ版アプリもあります。
          </p>
        )}
        <div className="safety card">
          <p className="safety-title">だいじなお約束</p>
          <ul>
            <li>写真を<strong>読み取るだけ</strong>です</li>
            <li>写真の移動・変更・削除は一切しません</li>
            <li>選んだフォルダ以外は見に行きません</li>
          </ul>
        </div>
        {notice && <p className="notice">{notice}</p>}
      </main>
    );
  }

  if (view === "scanning") {
    return (
      <main className="page center-page">
        <h2 className="section-title">写真を読み取っています</h2>
        <p className="mono small">{scan.root}</p>
        <p className="scan-count">
          {scan.filesSeen > 0
            ? `${scan.filesSeen.toLocaleString()} 枚のファイルを確認しました`
            : "探しています…"}
        </p>
        {scan.years.length > 0 && (
          <div className="year-chips">
            {[...scan.years].sort().map((y) => (
              <span className="chip" key={y}>
                {y}年の写真がありました
              </span>
            ))}
          </div>
        )}
        {scan.thumbTotal > 0 && !scan.finished && (
          <p className="small">
            縮小画像を準備中… {scan.thumbDone} / {scan.thumbTotal}
          </p>
        )}
        {scan.error && <p className="notice">問題がありました: {scan.error}</p>}
        {scan.finished ? (
          <>
            <p className="lead">読み取りが終わりました。</p>
            <button className="btn primary big" onClick={startBatch}>
              今日の発掘を始める
            </button>
          </>
        ) : (
          <>
            <p className="small gray">途中でやめても大丈夫です。次に開いたとき、続きから再開します。</p>
            <button className="btn ghost" onClick={() => call("cancel_scan")}>
              読み取りを中断する
            </button>
          </>
        )}
      </main>
    );
  }

  if (view === "home") {
    const ov = overview;
    const yearSpan =
      ov && ov.years.length > 0
        ? `${ov.years[0].year}年〜${ov.years[ov.years.length - 1].year}年`
        : "";
    return (
      <main className="page">
        <header className="home-head">
          <h1 className="app-title small-title">写真の書斎</h1>
          {ov && ov.totalPhotos > 0 && (
            <p className="small gray">
              {ov.totalPhotos.toLocaleString()}枚の写真
              {yearSpan && ` ・ ${yearSpan}`}
              {ov.kept > 0 && ` ・ ★残したい ${ov.kept}枚`}
            </p>
          )}
        </header>
        <section className="card hero-card">
          <h2 className="section-title">今日の発掘</h2>
          <p className="lead">眠っている写真の中から、今日の一束をお持ちします。</p>
          <button className="btn primary big" onClick={startBatch}>
            開けてみる
          </button>
        </section>
        <section className="two-cards">
          <div className="card mini-card" onClick={openPicker}>
            <h3 className="mini-title">行き先を選んで発掘</h3>
            <p className="small gray">年・キーワード・枚数を選べます</p>
          </div>
          <div className="card mini-card" onClick={startAuto}>
            <h3 className="mini-title">おまかせセレクト</h3>
            <p className="small gray">景色の良さそうな写真を自動で選びます</p>
          </div>
        </section>
        {ov && (ov.shioriCount > 0 || ov.kept > 0) && (
          <section className="two-cards">
            {ov.shioriCount > 0 && (
              <div className="card mini-card" onClick={openLibrary}>
                <h3 className="mini-title">書斎の棚</h3>
                <p className="small gray">しおり {ov.shioriCount}枚</p>
              </div>
            )}
            {ov.kept > 0 && (
              <div className="card mini-card" onClick={openKept}>
                <h3 className="mini-title">作品候補の棚</h3>
                <p className="small gray">★残したい {ov.kept}枚</p>
              </div>
            )}
          </section>
        )}
        {notice && <p className="notice">{notice}</p>}
        <section className="home-foot">
          {ov && ov.rawHeic > 0 && (
            <p className="small gray">
              RAW・HEIC形式の写真 {ov.rawHeic}枚は、今後の更新で対応します。
            </p>
          )}
          <p className="small gray">読み取り済みの場所: {ov?.roots.join(" ・ ") || "なし"}</p>
          <button className="btn ghost" onClick={pickFolder}>
            写真の場所を追加する
          </button>
        </section>
      </main>
    );
  }

  if (view === "picker") {
    return (
      <main className="page">
        <header className="batch-head">
          <h2 className="section-title">行き先を選んで発掘</h2>
          <p className="small gray">決めたいところだけ選べば大丈夫です。</p>
        </header>
        <div className="picker-block">
          <p className="picker-label">年をえらぶ</p>
          <div className="year-chips">
            <button
              className={`chip chip-btn ${selYear === null ? "chip-on" : ""}`}
              onClick={() => setSelYear(null)}
            >
              すべての年
            </button>
            {pickYears.map((y) => (
              <button
                key={y.year}
                className={`chip chip-btn ${selYear === y.year ? "chip-on" : ""}`}
                onClick={() => setSelYear(y.year)}
              >
                {y.year}年 ({y.count})
              </button>
            ))}
          </div>
        </div>
        <div className="picker-block">
          <p className="picker-label">
            キーワード <span className="gray small">(フォルダ名などから探します。例: 祭、山、京都)</span>
          </p>
          <input
            className="note-input"
            type="text"
            value={keyword}
            placeholder="例: 祭"
            onChange={(e) => setKeyword(e.target.value)}
          />
        </div>
        <div className="picker-block">
          <p className="picker-label">枚数</p>
          <div className="year-chips">
            {[5, 10, 20].map((n) => (
              <button
                key={n}
                className={`chip chip-btn ${pickLimit === n ? "chip-on" : ""}`}
                onClick={() => setPickLimit(n)}
              >
                {n}枚
              </button>
            ))}
          </div>
        </div>
        {notice && <p className="notice">{notice}</p>}
        <div className="actions-row">
          <button className="btn primary big" onClick={startCustom}>
            この条件で発掘する
          </button>
          <button className="btn ghost" onClick={() => setView("home")}>
            戻る
          </button>
        </div>
      </main>
    );
  }

  if (view === "autoLoading") {
    return (
      <main className="page center-page">
        <h2 className="section-title">おまかせセレクト</h2>
        <p className="lead">
          写真を見ています…
          <br />
          <span className="small gray">
            連写の多さ・空や緑の広がり・人の写り込みから、景色の良さそうな写真を選びます。
            <br />
            はじめてのときは少し時間がかかります。
          </span>
        </p>
      </main>
    );
  }

  if (view === "kept") {
    return (
      <main className="page">
        <header className="batch-head">
          <h2 className="section-title">作品候補の棚</h2>
          <p className="small gray">「★残したい」に選んだ写真 {keptGrid.length}枚</p>
        </header>
        {keptGrid.length === 0 ? (
          <p className="lead center">まだありません。発掘で「★残したい」を選ぶと貯まります。</p>
        ) : (
          <>
            <p className="small gray center">写真をクリックすると、入っているフォルダが開きます。</p>
            {notice && <p className="notice">{notice}</p>}
            <div className="grid">
              {keptGrid.map((p) => (
                <figure
                  className="grid-item clickable"
                  key={p.id}
                  title="フォルダを開く"
                  onClick={() => openPhotoFolder(p.id)}
                >
                  {p.thumbAbs ? (
                    <img src={thumbSrc(p.thumbAbs)} alt={p.fileName} loading="lazy" />
                  ) : (
                    <div className="noimg">画像なし</div>
                  )}
                  <figcaption className="small gray center">
                    {formatDate(p.takenAt)}
                    {p.folder && ` ・ ${p.folder}`}
                  </figcaption>
                </figure>
              ))}
            </div>
          </>
        )}
        <div className="actions-row">
          <button className="btn ghost" onClick={() => setView("home")}>
            戻る
          </button>
        </div>
      </main>
    );
  }

  if (view === "batch" && batch) {
    return (
      <main className="page">
        <header className="batch-head">
          <h2 className="section-title">{batch.title}</h2>
          {batch.subtitle && <p className="subtitle">{batch.subtitle}</p>}
          <p className="small gray">{batch.photos.length}枚が見つかりました</p>
        </header>
        <div className="grid">
          {batch.photos.map((p) => (
            <figure className="grid-item" key={p.id}>
              {p.thumbAbs ? (
                <img src={thumbSrc(p.thumbAbs)} alt={p.fileName} loading="lazy" />
              ) : (
                <div className="noimg">画像なし</div>
              )}
            </figure>
          ))}
        </div>
        <div className="actions-row">
          <button className="btn primary big" onClick={() => setView("focus")}>
            1枚ずつ見る
          </button>
          <button className="btn ghost" onClick={() => setView("home")}>
            今日はやめておく
          </button>
        </div>
      </main>
    );
  }

  if (view === "focus" && batch) {
    const p = batch.photos[focusIdx];
    return (
      <main className="page focus-page">
        <p className="small gray center">
          {batch.title}
          {batch.subtitle && ` ・ ${batch.subtitle}`} — {focusIdx + 1} / {batch.photos.length}枚目
        </p>
        <div className="focus-stage">
          {p.thumbAbs ? (
            <img className="focus-img" src={thumbSrc(p.thumbAbs)} alt={p.fileName} />
          ) : (
            <div className="noimg big-noimg">画像を表示できません</div>
          )}
        </div>
        <p className="caption center">
          {formatDate(p.takenAt)}
          {p.folder && ` ・ ${p.folder}`}
          <button className="btn ghost tiny" onClick={() => openPhotoFolder(p.id)}>
            フォルダを開く
          </button>
        </p>
        {notice && <p className="notice">{notice}</p>}
        <div className="decide-row">
          <button className="btn primary big" onClick={() => decide("keep")}>
            ★ 残したい
          </button>
          <button className="btn outline big" onClick={() => decide("later")}>
            あとで
          </button>
          <button className="btn ghost big" onClick={() => decide("skip")}>
            今回は違う
          </button>
        </div>
      </main>
    );
  }

  if (view === "compose" && batch) {
    return (
      <main className="page">
        <header className="batch-head">
          <h2 className="section-title">しおりをつくる</h2>
          <p className="small gray">
            残したい写真から{keptPhotos.length > 3 ? "3枚まで" : ""}選んで、ひとこと添えると、1枚のしおりになります。
          </p>
        </header>
        <div className="grid compose-grid">
          {keptPhotos.map((p) => {
            const sel = selectedIds.includes(p.id);
            return (
              <figure
                className={`grid-item selectable ${sel ? "selected" : ""}`}
                key={p.id}
                onClick={() => toggleSelect(p.id)}
              >
                {p.thumbAbs ? (
                  <img src={thumbSrc(p.thumbAbs)} alt={p.fileName} />
                ) : (
                  <div className="noimg">画像なし</div>
                )}
                {sel && <span className="sel-mark">{selectedIds.indexOf(p.id) + 1}</span>}
              </figure>
            );
          })}
        </div>
        <div className="note-row">
          <label className="note-label" htmlFor="note">
            ひとこと添えますか？　<span className="gray small">(なくても大丈夫です)</span>
          </label>
          <input
            id="note"
            className="note-input"
            type="text"
            value={note}
            maxLength={60}
            placeholder="例: 屋台の匂いまで思い出す"
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        {notice && <p className="notice">{notice}</p>}
        <div className="actions-row">
          <button
            className="btn primary big"
            disabled={selectedIds.length === 0}
            onClick={makeShiori}
          >
            しおりにする
          </button>
          <button className="btn ghost" onClick={() => setView("done")}>
            今回はつくらない
          </button>
        </div>
      </main>
    );
  }

  if (view === "shioriDone" && lastShiori) {
    return (
      <main className="page center-page">
        <h2 className="section-title">しおりができました</h2>
        <ShioriCard shiori={lastShiori} large />
        <p className="small gray">書斎の棚に収まりました。</p>
        {notice && <p className="notice">{notice}</p>}
        <div className="actions-row">
          <button className="btn outline" disabled={exporting} onClick={() => exportPdf(lastShiori)}>
            {exporting ? "書き出し中…" : "PDFに保存"}
          </button>
          <button className="btn outline" onClick={openLibrary}>
            書斎の棚を見る
          </button>
          <button className="btn primary" onClick={startBatch}>
            もう一束みる
          </button>
          <button className="btn ghost" onClick={() => setView("home")}>
            今日はここまで
          </button>
        </div>
      </main>
    );
  }

  if (view === "library") {
    return (
      <main className="page">
        <header className="batch-head">
          <h2 className="section-title">書斎の棚</h2>
          <p className="small gray">{library.length}枚のしおり</p>
        </header>
        {library.length === 0 ? (
          <p className="lead center">まだしおりがありません。「今日の発掘」から作れます。</p>
        ) : (
          <div className="library-grid">
            {library.map((s) => (
              <div
                key={s.id}
                className="library-item"
                onClick={() => {
                  setDetail(s);
                  setView("shioriDetail");
                }}
              >
                <ShioriCard shiori={s} />
              </div>
            ))}
          </div>
        )}
        <div className="actions-row">
          <button className="btn ghost" onClick={() => setView("home")}>
            戻る
          </button>
        </div>
      </main>
    );
  }

  if (view === "shioriDetail" && detail) {
    return (
      <main className="page center-page">
        <ShioriCard shiori={detail} large />
        {notice && <p className="notice">{notice}</p>}
        <div className="actions-row">
          <button className="btn outline" disabled={exporting} onClick={() => exportPdf(detail)}>
            {exporting ? "書き出し中…" : "PDFに保存"}
          </button>
          <button className="btn ghost" onClick={() => setView("library")}>
            棚に戻る
          </button>
        </div>
      </main>
    );
  }

  if (view === "done") {
    return (
      <main className="page center-page">
        <h2 className="section-title">今日の発掘はここまで</h2>
        <p className="lead">
          {keptPhotos.length > 0
            ? `${keptPhotos.length}枚を「残したい」にえらびました。`
            : "今日はぴんと来る写真がなかったようです。そういう日もあります。"}
        </p>
        <div className="actions-row">
          <button className="btn primary big" onClick={startBatch}>
            もう一束みる
          </button>
          <button className="btn ghost" onClick={() => setView("home")}>
            今日はここまで
          </button>
        </div>
      </main>
    );
  }

  return <main className="page center-page">…</main>;
}

/** 開発時のみ: ?preview=shiori でしおりの見た目を単体確認する */
function ShioriPreview() {
  const ph = (seed: number): Photo => ({
    id: seed,
    fileName: `p${seed}.jpg`,
    folder: "秋祭り",
    takenAt: "2011-10-09 14:00:00",
    cameraModel: null,
    thumbAbs: `https://picsum.photos/seed/${seed}/640/480`,
  });
  const mk = (id: number, n: number, note: string): Shiori => ({
    id,
    title: "2011年10月9日の秋祭り",
    note,
    takenLabel: "2011年10月9日",
    createdAt: "",
    photos: Array.from({ length: n }, (_, i) => ph(id * 10 + i)),
  });
  return (
    <main className="page center-page" style={{ gap: 40 }}>
      <ShioriCard shiori={mk(1, 1, "屋台の匂いまで思い出す")} large />
      <div className="library-grid">
        <ShioriCard shiori={mk(2, 2, "山車が来た瞬間")} />
        <ShioriCard shiori={mk(3, 3, "")} />
      </div>
    </main>
  );
}

function Root() {
  if (import.meta.env.DEV && new URLSearchParams(window.location.search).get("preview") === "shiori") {
    return <ShioriPreview />;
  }
  return <App />;
}

export default Root;
