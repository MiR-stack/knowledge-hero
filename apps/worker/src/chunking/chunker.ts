import { countTokens, getEncoder } from './token-counter.js';

export interface ChunkBoundary {
  content: string;
  tokenCount: number;
  metadata: {
    pageNumber?: number;
    sectionHeading?: string;
    boundingBox?: { x: number; y: number; width: number; height: number; page: number } | null;
  };
}

export interface ChildChunk extends ChunkBoundary {
  chunkIndex: number; // child index within the document
  siblingOverlapTokens: number;
}

export interface ParentChunk {
  content: string;
  tokenCount: number;
  childIndices: number[]; // which child chunk indices belong to this parent
  chunkIndex: number; // parent index (negative, to distinguish from child: use -(i+1))
}

export interface ChunkerResult {
  children: ChildChunk[];
  parents: ParentChunk[];
}

function extractOverlapText(text: string, overlapTokens: number): string {
  if (overlapTokens <= 0) return '';
  const tokens = getEncoder().encode(text);
  if (tokens.length <= overlapTokens) return text;
  const overlapArray = tokens.slice(tokens.length - overlapTokens);
  return new TextDecoder().decode(getEncoder().decode(overlapArray));
}

export function chunkText(text: string, pageBreaks?: number[]): ChunkerResult {
  const children: ChildChunk[] = [];
  const parents: ParentChunk[] = [];
  
  const paragraphs = text.split(/\n\n+/).map(p => p.trim()).filter(p => p.length > 0);
  const segments: string[] = [];

  for (const paragraph of paragraphs) {
    if (countTokens(paragraph) > 576) {
      const parts = paragraph.split(/(?<=[.!?])\s+/);
      for (const part of parts) {
        if (part.trim().length > 0) {
          segments.push(part.trim());
        }
      }
    } else {
      segments.push(paragraph);
    }
  }

  // Merge short segments (< 64 tokens) with the next segment.
  const mergedSegments: string[] = [];
  let currentShort = '';
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (currentShort) {
      currentShort += ' ' + seg;
    } else {
      currentShort = seg;
    }
    
    if (countTokens(currentShort) >= 64 || i === segments.length - 1) {
      mergedSegments.push(currentShort);
      currentShort = '';
    }
  }

  let currentContent = '';
  let currentTokens = 0;
  let childIndex = 0;
  let siblingOverlapTokens = 0;

  for (let i = 0; i < mergedSegments.length; i++) {
    const seg = mergedSegments[i];
    // +1 for space/newline approximation if currentContent is not empty
    const segText = currentContent ? ' ' + seg : seg;
    const segTokens = countTokens(segText) - currentTokens; 
    // actually, let's just count accurately
    const combined = currentContent ? currentContent + ' ' + seg : seg;
    const combinedTokens = countTokens(combined);

    if (currentContent && combinedTokens > 576) {
      children.push({
        content: currentContent,
        tokenCount: currentTokens,
        chunkIndex: childIndex++,
        siblingOverlapTokens,
        metadata: {},
      });
      const overlapTokensCount = Math.floor(512 * 0.10);
      const overlapText = extractOverlapText(currentContent, overlapTokensCount);
      siblingOverlapTokens = countTokens(overlapText);
      
      currentContent = overlapText ? overlapText + ' ' + seg : seg;
      currentTokens = countTokens(currentContent);
    } else {
      currentContent = combined;
      currentTokens = combinedTokens;
    }
  }

  if (currentContent) {
    children.push({
      content: currentContent,
      tokenCount: currentTokens,
      chunkIndex: childIndex++,
      siblingOverlapTokens,
      metadata: {},
    });
  }

  for (let i = 0; i < children.length; i += 3) {
    const group = children.slice(i, i + 3);
    const content = group.map(c => c.content).join('\n\n');
    const tokenCount = countTokens(content);
    const parentChunkIndex = -(Math.floor(i / 3) + 1);
    
    parents.push({
      content,
      tokenCount,
      childIndices: group.map(c => c.chunkIndex),
      chunkIndex: parentChunkIndex,
    });
  }

  return { children, parents };
}
