import mammoth from 'mammoth';

export interface DocxSection {
  heading: string | null;
  level: number; // 0 = body, 1-6 = h1-h6
  text: string;
}

export interface DocxResult {
  sections: DocxSection[];
  fullText: string;
}

export async function parseDocx(buffer: Buffer): Promise<DocxResult> {
  const { value: rawText } = await mammoth.extractRawText({ buffer });
  const { value: html } = await mammoth.convertToHtml({ buffer });

  // Parse HTML to extract heading structure
  const sections: DocxSection[] = [];
  const headingRegex = /<(h[1-6])>(.*?)<\/h[1-6]>|<p>(.*?)<\/p>/gi;
  let lastHeading: { text: string; level: number } | null = null;
  let currentBodyText: string[] = [];

  const flushBody = () => {
    const text = currentBodyText.join('\n').trim();
    if (text) {
      sections.push({
        heading: lastHeading?.text ?? null,
        level: lastHeading?.level ?? 0,
        text,
      });
    }
    currentBodyText = [];
  };

  let match: RegExpExecArray | null;
  while ((match = headingRegex.exec(html)) !== null) {
    const tag = match[1];
    const headingText = match[2];
    const bodyText = match[3];

    if (tag && headingText) {
      flushBody();
      lastHeading = { text: headingText.replace(/<[^>]+>/g, '').trim(), level: parseInt(tag[1]) };
    } else if (bodyText) {
      currentBodyText.push(bodyText.replace(/<[^>]+>/g, '').trim());
    }
  }
  flushBody();

  return { sections, fullText: rawText.trim() };
}
