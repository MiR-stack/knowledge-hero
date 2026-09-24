import pdfParse from 'pdf-parse';

export interface PdfNativeResult {
  pages: Array<{ pageNum: number; text: string }>;
  totalPages: number;
  isLikelyScanned: boolean; // true if avg chars/page < 50 → auto-promote to OCR
}

export async function parsePdfNative(buffer: Buffer): Promise<PdfNativeResult> {
  const data = await pdfParse(buffer);
  // \f (form feed) is the standard PDF page separator in pdf-parse output
  const pageTexts: string[] = data.text.split('\f').filter((t: string) => t.trim().length > 0);
  const pages = pageTexts.map((text: string, i: number) => ({ pageNum: i + 1, text: text.trim() }));
  const avgCharsPerPage =
    pages.length > 0
      ? pages.reduce((sum: number, p: { text: string }) => sum + p.text.length, 0) / pages.length
      : 0;
  return {
    pages,
    totalPages: data.numpages,
    isLikelyScanned: avgCharsPerPage < 50,
  };
}
