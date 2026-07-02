import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import "./App.css";

type Overview = {
  totalPhotos: number;
  kept: number;
  rawHeic: number;
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

type View = "loading" | "start" | "scanning" | "home" | "batch" | "focus" | "done";

function formatDate(takenAt: string | null): string {
  if (!takenAt) return "撮影日は不明";
  const y = takenAt.slice(0, 4);
  const m = String(Number(takenAt.slice(5, 7)));
  const d = String(Number(takenAt.slice(8, 10)));
  return `${y}年${m}月${d}日`;
}

function App() {
  const [view, setView] = useState<View>("loading");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [scan, setScan] = useState<ScanInfo>(emptyScan);
  const [batch, setBatch] = useState<Batch | null>(null);
  const [focusIdx, setFocusIdx] = useState(0);
  const [keptInBatch, setKeptInBatch] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;

  const refreshOverview = useCallback(async (): Promise<Overview> => {
    const ov = await invoke<Overview>("get_overview");
    setOverview(ov);
    return ov;
  }, []);

  // 起動時: 状態を見て画面を決める
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

  // 走査イベントの購読
  useEffect(() => {
    const unlisteners: Promise<() => void>[] = [
      listen<Record<string, any>>("scan-event", (ev) => {
        const p = ev.payload;
        if ("Started" in p) {
          setScan((s) => ({ ...emptyScan, root: p.Started.root || s.root }));
        } else if ("Progress" in p) {
          setScan((s) => ({ ...s, filesSeen: p.Progress.files_seen, indexed: p.Progress.indexed }));
        } else if ("FoundYear" in p) {
          setScan((s) =>
            s.years.includes(p.FoundYear.year) ? s : { ...s, years: [...s.years, p.FoundYear.year] }
          );
        } else if ("Finished" in p) {
          const st = p.Finished.stats;
          setScan((s) => ({ ...s, filesSeen: st.files_seen }));
        }
      }),
      listen<{ done: number; total: number }>("thumb-progress", (ev) => {
        setScan((s) => ({ ...s, thumbDone: ev.payload.done, thumbTotal: ev.payload.total }));
      }),
      listen<string>("scan-error", (ev) => {
        setScan((s) => ({ ...s, error: ev.payload }));
      }),
      listen("scan-idle", async () => {
        const ov = await invoke<Overview>("get_overview");
        setOverview(ov);
        setScan((s) => ({ ...s, finished: true }));
      }),
    ];
    return () => {
      unlisteners.forEach((u) => u.then((f) => f()));
    };
  }, []);

  const pickFolder = async () => {
    const dir = await open({
      directory: true,
      title: "写真が入っているフォルダやドライブを選んでください",
    });
    if (typeof dir === "string" && dir) {
      setScan({ ...emptyScan, root: dir });
      setView("scanning");
      try {
        await invoke("start_scan", { path: dir });
      } catch (e) {
        setScan((s) => ({ ...s, error: String(e) }));
      }
    }
  };

  const startBatch = async () => {
    setNotice(null);
    const b = await invoke<Batch | null>("next_batch");
    if (!b || b.photos.length === 0) {
      setNotice("今は発掘できる写真がありません。フォルダを追加するか、また今度お越しください。");
      setView("home");
      return;
    }
    setBatch(b);
    setFocusIdx(0);
    setKeptInBatch(0);
    setView("batch");
  };

  const decide = async (decision: "keep" | "later" | "skip") => {
    if (!batch) return;
    const photo = batch.photos[focusIdx];
    try {
      await invoke("triage_photo", { photoId: photo.id, decision });
    } catch (e) {
      setNotice(String(e));
      return;
    }
    if (decision === "keep") setKeptInBatch((n) => n + 1);
    if (focusIdx + 1 < batch.photos.length) {
      setFocusIdx(focusIdx + 1);
    } else {
      await refreshOverview();
      setView("done");
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
            <button className="btn ghost" onClick={() => invoke("cancel_scan")}>
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
                <img src={convertFileSrc(p.thumbAbs)} alt={p.fileName} loading="lazy" />
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
            <img className="focus-img" src={convertFileSrc(p.thumbAbs)} alt={p.fileName} />
          ) : (
            <div className="noimg big-noimg">画像を表示できません</div>
          )}
        </div>
        <p className="caption center">
          {formatDate(p.takenAt)}
          {p.folder && ` ・ ${p.folder}`}
        </p>
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

  if (view === "done") {
    return (
      <main className="page center-page">
        <h2 className="section-title">今日の発掘はここまで</h2>
        <p className="lead">
          {keptInBatch > 0
            ? `${keptInBatch}枚を「残したい」に選びました。よい再会でしたね。`
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

export default App;
