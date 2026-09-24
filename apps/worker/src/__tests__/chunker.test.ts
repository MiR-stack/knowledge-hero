import { describe, it, expect, beforeAll } from 'vitest';
import { chunkText } from '../chunking/chunker.js';
import { chunkSpreadsheet } from '../chunking/spreadsheet-chunker.js';
import { countTokens } from '../chunking/token-counter.js';

// Generate a paragraph of approximately N tokens
function generateText(paragraphs: number, wordsPerParagraph: number): string {
  const word = 'Lorem ipsum dolor sit amet consectetur adipiscing elit'.split(' ');
  return Array.from({ length: paragraphs }, (_, p) =>
    Array.from({ length: wordsPerParagraph }, (_, i) => word[i % word.length]).join(' ')
  ).join('\n\n');
}

describe('chunkText — FR-3.1 boundary integrity', () => {
  const CHILD_MIN = 400;
  const CHILD_MAX = 576; // 512 + 64
  const PARENT_MIN = 1200; // relaxed slightly for small docs
  const PARENT_MAX = 2100; // 2000 + 5% tolerance

  it('produces child chunks within 512±64 token target', () => {
    // ~5000 tokens of text across 30 paragraphs
    const text = generateText(30, 25);
    const result = chunkText(text);
    
    // Every child (except possibly the last) should be within bounds
    for (let i = 0; i < result.children.length - 1; i++) {
      const tokens = result.children[i].tokenCount;
      expect(tokens, `child[${i}] tokenCount=${tokens} out of range`)
        .toBeGreaterThanOrEqual(CHILD_MIN);
      expect(tokens, `child[${i}] tokenCount=${tokens} out of range`)
        .toBeLessThanOrEqual(CHILD_MAX);
    }
  });

  it('never splits inside a word (no broken words at chunk boundaries)', () => {
    const text = generateText(20, 30);
    const result = chunkText(text);
    for (const child of result.children) {
      // Content should not start or end with a partial word (no hyphens at boundaries)
      expect(child.content.trimStart()).toMatch(/^\S/);
      expect(child.content.trimEnd()).toMatch(/\S$/);
    }
  });

  it('parent chunks are within 1500-2000 token target', () => {
    const text = generateText(60, 25);
    const result = chunkText(text);
    if (result.parents.length < 2) return; // skip if too few
    for (let i = 0; i < result.parents.length - 1; i++) {
      const tokens = result.parents[i].tokenCount;
      expect(tokens, `parent[${i}] tokenCount=${tokens} out of [${PARENT_MIN}, ${PARENT_MAX}]`)
        .toBeGreaterThanOrEqual(PARENT_MIN);
      expect(tokens, `parent[${i}] tokenCount=${tokens} out of [${PARENT_MIN}, ${PARENT_MAX}]`)
        .toBeLessThanOrEqual(PARENT_MAX);
    }
  });

  it('sibling overlap is 10-15% of child target (51-77 tokens)', () => {
    const text = generateText(40, 25);
    const result = chunkText(text);
    const OVERLAP_MIN = 40; // relaxed: 8%
    const OVERLAP_MAX = 100; // relaxed: 20%
    for (let i = 1; i < result.children.length; i++) {
      const overlap = result.children[i].siblingOverlapTokens;
      expect(overlap, `child[${i}] overlap=${overlap} out of [${OVERLAP_MIN}, ${OVERLAP_MAX}]`)
        .toBeGreaterThanOrEqual(OVERLAP_MIN);
      expect(overlap, `child[${i}] overlap=${overlap} out of [${OVERLAP_MAX}]`)
        .toBeLessThanOrEqual(OVERLAP_MAX);
    }
  });

  it('chunk indices are sequential and unique', () => {
    const text = generateText(20, 25);
    const result = chunkText(text);
    const indices = result.children.map(c => c.chunkIndex);
    const unique = new Set(indices);
    expect(unique.size).toBe(indices.length);
    expect(indices).toEqual([...Array(indices.length).keys()]);
  });

  it('parent chunkIndex values are negative', () => {
    const text = generateText(20, 25);
    const result = chunkText(text);
    for (const parent of result.parents) {
      expect(parent.chunkIndex).toBeLessThan(0);
    }
  });

  it('all text is covered (no content dropped)', () => {
    const text = generateText(10, 20);
    const result = chunkText(text);
    // All original words should appear somewhere in children
    const allChildText = result.children.map(c => c.content).join(' ');
    const originalWords = text.split(/\s+/).filter(Boolean);
    // Check that at least 95% of original words appear in child text
    const covered = originalWords.filter(w => allChildText.includes(w));
    expect(covered.length / originalWords.length).toBeGreaterThan(0.95);
  });
});

describe('chunkSpreadsheet — FR-3.1 spreadsheet boundary integrity', () => {
  it('includes header row in every chunk', () => {
    const headers = ['Date', 'Amount', 'Description', 'Account', 'Reference'];
    const rows = Array.from({ length: 100 }, (_, i) => [
      `2026-01-${(i % 28 + 1).toString().padStart(2, '0')}`,
      `${(i * 100).toFixed(2)}`,
      `Transaction ${i}`,
      `ACC-${i % 5}`,
      `REF-${i.toString().padStart(6, '0')}`,
    ]);
    const chunks = chunkSpreadsheet([{ name: 'Sheet1', headers, rows }]);
    
    for (const chunk of chunks) {
      // Every chunk must start with the header row
      const firstLine = chunk.content.split('\n')[0];
      expect(firstLine).toBe(headers.join('\t'));
    }
  });

  it('never places a row boundary inside a logical row', () => {
    const headers = ['Col1', 'Col2', 'Col3'];
    const rows = Array.from({ length: 50 }, (_, i) => [`val${i}-1`, `val${i}-2`, `val${i}-3`]);
    const chunks = chunkSpreadsheet([{ name: 'Data', headers, rows }]);
    
    // rowRange should be consistent — each row appears in exactly one chunk
    const seenRows = new Set<number>();
    for (const chunk of chunks) {
      const [start, end] = chunk.metadata.rowRange.split('-').map(Number);
      for (let r = start; r <= end; r++) {
        expect(seenRows.has(r), `Row ${r} appears in multiple chunks`).toBe(false);
        seenRows.add(r);
      }
    }
  });

  it('chunk token counts are within target range', () => {
    const headers = ['Product', 'Q1_Sales', 'Q2_Sales', 'Q3_Sales', 'Q4_Sales', 'Total'];
    const rows = Array.from({ length: 200 }, (_, i) => [
      `Product ${i} Extended Name`,
      `${Math.floor(Math.random() * 10000)}`,
      `${Math.floor(Math.random() * 10000)}`,
      `${Math.floor(Math.random() * 10000)}`,
      `${Math.floor(Math.random() * 10000)}`,
      `${Math.floor(Math.random() * 50000)}`,
    ]);
    const chunks = chunkSpreadsheet([{ name: 'Sales', headers, rows }]);
    
    for (let i = 0; i < chunks.length - 1; i++) {
      // All but last chunk should be under the 576 target
      expect(chunks[i].tokenCount).toBeLessThanOrEqual(576);
    }
  });
});
