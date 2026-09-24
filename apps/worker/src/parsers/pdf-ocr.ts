import { createWorker } from 'tesseract.js';
import { fromBuffer } from 'pdf2pic';
import sharp from 'sharp';
import { config } from '../config.js';

export interface BoundingBox {
  x: number;     // fraction of page width (0–1)
  y: number;     // fraction of page height (0–1)
  width: number;
  height: number;
  page: number;
}

export interface OcrBlock {
  text: string;
  confidence: number;
  boundingBox: BoundingBox;
  isTable?: boolean;
}

export interface OcrPageResult {
  pageNum: number;
  blocks: OcrBlock[];
  fullText: string;
  needsManualReview?: boolean;
}

export interface OcrResult {
  pages: OcrPageResult[];
  totalPages: number;
}

const TABLE_CONFIDENCE_THRESHOLD = 60;
const DPI = 300;

function detectTableRegion(words: Array<{ bbox: { x0: number; y0: number } }>): boolean {
  if (words.length < 4) return false;
  const yCoords = words.map(w => Math.round(w.bbox.y0 / 10) * 10);
  const uniqueRows = new Set(yCoords).size;
  const xCoords = words.map(w => Math.round(w.bbox.x0 / 20) * 20);
  const uniqueCols = new Set(xCoords).size;
  return uniqueRows >= 3 && uniqueCols >= 3;
}

let tesseractWorker: Awaited<ReturnType<typeof createWorker>> | null = null;

async function getTesseractWorker() {
  if (!tesseractWorker) {
    tesseractWorker = await createWorker(config.tesseractLang, 1, {
      logger: () => {}, // suppress per-word progress logs
    });
    await tesseractWorker.setParameters({
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore — tessedit_ocr_engine_mode is a valid Tesseract param
      tessedit_ocr_engine_mode: 1, // LSTM only (--oem 1)
    });
  }
  return tesseractWorker;
}

async function runOcrOnBuffer(
  pageBuffer: Buffer,
  pageNum: number,
): Promise<OcrPageResult> {
  const worker = await getTesseractWorker();

  // Get image dimensions so we can normalise bounding boxes to fractions
  const meta = await sharp(pageBuffer).metadata();
  const imgWidth = meta.width ?? 1;
  const imgHeight = meta.height ?? 1;

  const result = await worker.recognize(pageBuffer);
  const { data } = result;

  const blocks: OcrBlock[] = [];
  let needsManualReview = false;

  for (const block of data.blocks ?? []) {
    const words = (block.words ?? []) as Array<{ bbox: { x0: number; y0: number } }>;
    const isTable = detectTableRegion(words);
    if (isTable && block.confidence < TABLE_CONFIDENCE_THRESHOLD) {
      needsManualReview = true;
    }
    blocks.push({
      text: block.text.trim(),
      confidence: block.confidence,
      isTable,
      boundingBox: {
        x: block.bbox.x0 / imgWidth,
        y: block.bbox.y0 / imgHeight,
        width: (block.bbox.x1 - block.bbox.x0) / imgWidth,
        height: (block.bbox.y1 - block.bbox.y0) / imgHeight,
        page: pageNum,
      },
    });
  }

  return { pageNum, blocks, fullText: data.text.trim(), needsManualReview };
}

/**
 * OCR a scanned PDF — converts each page to 300 DPI PNG via pdf2pic (uses
 * system pdftoppm from poppler-utils), then runs Tesseract LSTM on each page.
 */
export async function parsePdfOcr(buffer: Buffer): Promise<OcrResult> {
  // pdf2pic converts PDF pages to images using pdftoppm (poppler-utils)
  const convert = fromBuffer(buffer, {
    density: DPI,
    format: 'png',
    width: 2480,   // A4 at 300 DPI ≈ 2480 × 3508
    height: 3508,
    preserveAspectRatio: true,
  });

  // First, get the page count by converting page 1 and reading the PDF info.
  // pdf2pic doesn't expose numPages directly; we'll convert all pages with -1.
  const allPages = await convert.bulk(-1, { responseType: 'buffer' });
  const totalPages = allPages.length;

  const pages: OcrPageResult[] = [];
  for (let i = 0; i < allPages.length; i++) {
    const pageResult = allPages[i];
    if (!pageResult?.buffer) continue;
    const ocrPage = await runOcrOnBuffer(pageResult.buffer, i + 1);
    pages.push(ocrPage);
  }

  return { pages, totalPages };
}

/**
 * OCR a standalone image (PNG, JPEG, TIFF, etc.).
 */
export async function parseImageOcr(
  buffer: Buffer,
  _mimeType: string,
): Promise<OcrResult> {
  const ocrPage = await runOcrOnBuffer(buffer, 1);
  return { pages: [ocrPage], totalPages: 1 };
}

export async function terminateTesseract(): Promise<void> {
  if (tesseractWorker) {
    await tesseractWorker.terminate();
    tesseractWorker = null;
  }
}
