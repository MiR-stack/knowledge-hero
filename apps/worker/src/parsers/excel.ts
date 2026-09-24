import XLSX from 'xlsx';

export interface CellValue {
  row: number;
  col: number;
  colLetter: string;
  rawValue: string | number | boolean | null;
  formula: string | null;  // formula string if cell has formula (FR-2.3)
  computedValue: string | number | boolean | null; // last computed value (FR-2.3)
  address: string; // e.g. "A1"
}

export interface SheetResult {
  sheetName: string;
  rows: CellValue[][];
  headers: string[]; // first row as column headers
  rowCount: number;
  colCount: number;
}

export interface ExcelResult {
  sheets: SheetResult[];
}

export function parseExcel(buffer: Buffer): ExcelResult {
  const workbook = XLSX.read(buffer, {
    type: 'buffer',
    cellFormula: true,   // parse formulas
    cellHTML: false,
    cellNF: false,
    cellStyles: false,
    raw: false,
  });

  const sheets: SheetResult[] = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;

    const ref = sheet['!ref'];
    if (!ref) continue;

    const range = XLSX.utils.decode_range(ref);
    const rowCount = range.e.r - range.s.r + 1;
    const colCount = range.e.c - range.s.c + 1;

    const rows: CellValue[][] = [];
    const headers: string[] = [];

    for (let r = range.s.r; r <= range.e.r; r++) {
      const row: CellValue[] = [];
      for (let c = range.s.c; c <= range.e.c; c++) {
        const address = XLSX.utils.encode_cell({ r, c });
        const colLetter = XLSX.utils.encode_col(c);
        const cell = sheet[address];

        let rawValue: string | number | boolean | null = null;
        let formula: string | null = null;
        let computedValue: string | number | boolean | null = null;

        if (cell) {
          rawValue = cell.v ?? null;  // raw value
          formula = cell.f ? `=${cell.f}` : null;  // formula if present
          computedValue = cell.f ? (cell.v ?? null) : null; // computed value (FR-2.3)
        }

        row.push({ row: r, col: c, colLetter, rawValue, formula, computedValue, address });
      }
      rows.push(row);
      // First row as headers
      if (r === range.s.r) {
        headers.push(...row.map(c => String(c.rawValue ?? '')));
      }
    }

    sheets.push({ sheetName, rows, headers, rowCount, colCount });
  }

  return { sheets };
}

export function parseCsv(buffer: Buffer): ExcelResult {
  const workbook = XLSX.read(buffer.toString('utf-8'), { type: 'string' });
  return parseExcel(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
}
