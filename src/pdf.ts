// しおりのPDF書き出し。A5縦・カードデザインをそのまま紙面に再現する。
// 日本語はIPAex明朝(TTF)をサブセット埋め込み。
// 注: CFF形式(OTF)はpdf-libのサブセットで文字化けするため使わないこと(検証済み)。

import { PDFDocument, PDFFont, PDFImage, PDFPage, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import fontUrl from "./fonts/ipaexm.ttf?url";

type PdfPhoto = { bytes: Uint8Array };

export type PdfShiori = {
  title: string;
  note: string;
  takenLabel: string;
  photos: PdfPhoto[];
};

// A5 (pt)
const PAGE_W = 420;
const PAGE_H = 595;
const MARGIN = 42;
const CONTENT_W = PAGE_W - MARGIN * 2;

const PAPER = rgb(1, 0.992, 0.973);
const INK = rgb(0.2, 0.188, 0.165);
const GRAY = rgb(0.49, 0.467, 0.424);

async function embedImage(doc: PDFDocument, bytes: Uint8Array): Promise<PDFImage> {
  try {
    return await doc.embedJpg(bytes);
  } catch {
    return await doc.embedPng(bytes);
  }
}

/** boxに収まるようフィット(レターボックス)で中央配置 */
function drawFitted(
  page: PDFPage,
  img: PDFImage,
  box: { x: number; y: number; w: number; h: number }
) {
  const scale = Math.min(box.w / img.width, box.h / img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  page.drawImage(img, {
    x: box.x + (box.w - w) / 2,
    y: box.y + (box.h - h) / 2,
    width: w,
    height: h,
  });
}

function wrapText(text: string, font: PDFFont, size: number, maxW: number): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const ch of text) {
    if (font.widthOfTextAtSize(cur + ch, size) > maxW && cur) {
      lines.push(cur);
      cur = ch;
    } else {
      cur += ch;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

function drawCentered(page: PDFPage, text: string, y: number, font: PDFFont, size: number, color: ReturnType<typeof rgb>) {
  const w = font.widthOfTextAtSize(text, size);
  page.drawText(text, { x: (PAGE_W - w) / 2, y, size, font, color });
}

/** しおり1枚を1ページとして描画する(単票PDF・写真集の両方で共用) */
async function drawShioriPage(doc: PDFDocument, font: PDFFont, s: PdfShiori) {
  const page = doc.addPage([PAGE_W, PAGE_H]);
  page.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: PAGE_H, color: PAPER });

  // 写真エリア(上部)
  const photosTop = PAGE_H - MARGIN;
  const photoAreaH = 300;
  const gap = 8;
  const images: PDFImage[] = [];
  for (const p of s.photos) {
    images.push(await embedImage(doc, p.bytes));
  }
  if (images.length === 1) {
    drawFitted(page, images[0], { x: MARGIN, y: photosTop - photoAreaH, w: CONTENT_W, h: photoAreaH });
  } else if (images.length === 2) {
    const w = (CONTENT_W - gap) / 2;
    images.forEach((img, i) => {
      drawFitted(page, img, { x: MARGIN + i * (w + gap), y: photosTop - photoAreaH, w, h: photoAreaH });
    });
  } else if (images.length >= 3) {
    const bigW = CONTENT_W * 0.62;
    const smallW = CONTENT_W - bigW - gap;
    const smallH = (photoAreaH - gap) / 2;
    drawFitted(page, images[0], { x: MARGIN, y: photosTop - photoAreaH, w: bigW, h: photoAreaH });
    drawFitted(page, images[1], { x: MARGIN + bigW + gap, y: photosTop - smallH, w: smallW, h: smallH });
    drawFitted(page, images[2], { x: MARGIN + bigW + gap, y: photosTop - photoAreaH, w: smallW, h: smallH });
  }

  // 文字エリア
  let y = photosTop - photoAreaH - 46;
  if (s.takenLabel && s.takenLabel !== s.title) {
    drawCentered(page, s.takenLabel, y, font, 9, GRAY);
    y -= 24;
  }
  for (const line of wrapText(s.title, font, 17, CONTENT_W)) {
    drawCentered(page, line, y, font, 17, INK);
    y -= 26;
  }
  if (s.note) {
    y -= 6;
    for (const line of wrapText(s.note, font, 11.5, CONTENT_W - 40)) {
      drawCentered(page, line, y, font, 11.5, rgb(0.3, 0.275, 0.235));
      y -= 20;
    }
  }
}

async function loadFont(doc: PDFDocument): Promise<PDFFont> {
  doc.registerFontkit(fontkit);
  const fontBytes = await fetch(fontUrl).then((r) => r.arrayBuffer());
  return doc.embedFont(fontBytes, { subset: true });
}

export async function buildShioriPdf(s: PdfShiori): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await loadFont(doc);
  await drawShioriPage(doc, font, s);
  return doc.save();
}

export type PhotoBook = {
  bookTitle: string;
  subtitle: string; // 例: 「12枚のしおり · 2009年〜2024年」
  shioris: PdfShiori[];
};

/** 書斎の棚のしおりを1冊の写真集に。表紙 + しおりごとに1ページ */
export async function buildPhotoBookPdf(book: PhotoBook): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await loadFont(doc);

  // 表紙
  const cover = doc.addPage([PAGE_W, PAGE_H]);
  cover.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: PAGE_H, color: PAPER });
  cover.drawLine({
    start: { x: MARGIN, y: PAGE_H * 0.62 },
    end: { x: PAGE_W - MARGIN, y: PAGE_H * 0.62 },
    thickness: 0.8,
    color: GRAY,
  });
  let cy = PAGE_H * 0.56;
  for (const line of wrapText(book.bookTitle, font, 24, CONTENT_W)) {
    drawCentered(cover, line, cy, font, 24, INK);
    cy -= 34;
  }
  if (book.subtitle) drawCentered(cover, book.subtitle, cy - 6, font, 11, GRAY);

  // 中身
  for (const s of book.shioris) {
    await drawShioriPage(doc, font, s);
  }
  return doc.save();
}
