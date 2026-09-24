import type { IngestionJobData } from '../queue/ingestion-queue.js';
import { parsePdfNative } from './pdf-native.js';
import { parsePdfOcr, parseImageOcr } from './pdf-ocr.js';
import { parseExcel, parseCsv } from './excel.js';
import { parseDocx } from './docx.js';
import { fetchWebUrl } from './web-url.js';

export interface ParseResult {
  text: string;           // full extracted text
  pageCount?: number;
  metadata: Record<string, unknown>; // parser-specific (sheets, bounding boxes, etc.)
}

export async function dispatchParser(
  buffer: Buffer,
  jobData: IngestionJobData
): Promise<ParseResult> {
  const { sourceType, documentId, workspaceId, webUrl } = jobData;

  switch (sourceType) {
    case 'pdf_native': {
      const result = await parsePdfNative(buffer);
      // Auto-promote to OCR if likely scanned
      if (result.isLikelyScanned) {
        const ocrResult = await parsePdfOcr(buffer);
        return {
          text: ocrResult.pages.map(p => p.fullText).join('\n\n'),
          pageCount: ocrResult.totalPages,
          metadata: { ocrPages: ocrResult.pages, engine: 'tesseract-v5' },
        };
      }
      return {
        text: result.pages.map(p => p.text).join('\n\n'),
        pageCount: result.totalPages,
        metadata: { pages: result.pages, engine: 'pdf-parse' },
      };
    }

    case 'pdf_scanned': {
      const result = await parsePdfOcr(buffer);
      const needsReview = result.pages.some(p => p.needsManualReview);
      return {
        text: result.pages.map(p => p.fullText).join('\n\n'),
        pageCount: result.totalPages,
        metadata: { 
          ocrPages: result.pages, 
          engine: 'tesseract-v5',
          needsManualReview: needsReview,
        },
      };
    }

    case 'image': {
      // Assuming jobData could contain mimeType, but it isn't strictly in IngestionJobData yet, so we default to image/png
      const mimeType = (jobData as any).mimeType ?? 'image/png';
      const result = await parseImageOcr(buffer, mimeType);
      return {
        text: result.pages[0]?.fullText ?? '',
        pageCount: 1,
        metadata: { ocrBlocks: result.pages[0]?.blocks ?? [], engine: 'tesseract-v5' },
      };
    }

    case 'excel': {
      const result = parseExcel(buffer);
      const text = result.sheets
        .map(sheet => `Sheet: ${sheet.sheetName}\n` + sheet.rows
          .map(row => row.map(cell => cell.formula ? `[${cell.formula}=${cell.computedValue}]` : String(cell.rawValue ?? '')).join('\t')
          ).join('\n')
        ).join('\n\n');
      return { text, metadata: { sheets: result.sheets } };
    }

    case 'csv': {
      const result = parseCsv(buffer);
      const text = result.sheets
        .map(sheet => sheet.rows.map(row => row.map(c => String(c.rawValue ?? '')).join(',')).join('\n'))
        .join('\n\n');
      return { text, metadata: { sheets: result.sheets } };
    }

    case 'docx': {
      const result = await parseDocx(buffer);
      return {
        text: result.fullText,
        metadata: { sections: result.sections },
      };
    }

    case 'web_url': {
      if (!webUrl) throw new Error('webUrl is required for web_url source type');
      const result = await fetchWebUrl(webUrl, workspaceId, documentId);
      return {
        text: result.text,
        metadata: {
          url: result.url,
          title: result.title,
          screenshotS3Key: result.screenshotS3Key,
          extractionFailed: result.extractionFailed,
        },
      };
    }

    default:
      throw new Error(`Unsupported sourceType: ${sourceType}`);
  }
}
