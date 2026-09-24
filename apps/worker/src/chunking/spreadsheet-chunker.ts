import { countTokens } from './token-counter.js';

export interface SpreadsheetChunk {
  content: string;    // header row + data rows as TSV or text
  tokenCount: number;
  metadata: {
    sheetName: string;
    rowRange: string;  // e.g. "2-15"
    columnRange?: string;
  };
}

// Chunk spreadsheet sheets into row-groups.
// Each group = header row + N data rows, targeting 512 tokens.
// Never split inside a logical table row.
export function chunkSpreadsheet(
  sheets: Array<{ name: string; headers: string[]; rows: string[][] }>
): SpreadsheetChunk[] {
  const chunks: SpreadsheetChunk[] = [];
  for (const sheet of sheets) {
    const headerText = sheet.headers.join('\t');
    const headerTokens = countTokens(headerText);
    const TARGET = 512;
    
    let currentRows: string[][] = [];
    let currentTokens = headerTokens;
    let startRow = 2; // 1-indexed, row 1 = header
    
    for (let i = 0; i < sheet.rows.length; i++) {
      const row = sheet.rows[i];
      const rowText = row.join('\t');
      const rowTokens = countTokens(rowText) + 1; // +1 for newline
      
      if (currentRows.length > 0 && currentTokens + rowTokens > 576) {
        // Emit current group
        chunks.push(buildChunk(sheet.name, headerText, currentRows, startRow, startRow + currentRows.length - 1, currentTokens));
        // Start new group (no overlap for spreadsheets — row boundary is logical)
        startRow = i + 2; // 1-indexed data starts at row 2
        currentRows = [];
        currentTokens = headerTokens;
      }
      currentRows.push(row);
      currentTokens += rowTokens;
    }
    if (currentRows.length > 0) {
      chunks.push(buildChunk(sheet.name, headerText, currentRows, startRow, startRow + currentRows.length - 1, currentTokens));
    }
  }
  return chunks;
}

function buildChunk(
  sheetName: string,
  headerText: string,
  rows: string[][],
  startRow: number,
  endRow: number,
  tokenCount: number
): SpreadsheetChunk {
  const content = headerText + '\n' + rows.map(r => r.join('\t')).join('\n');
  return {
    content,
    tokenCount,
    metadata: { sheetName, rowRange: `${startRow}-${endRow}` },
  };
}
