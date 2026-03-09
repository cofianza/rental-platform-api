import PDFDocument from 'pdfkit';

// ============================================================
// Types
// ============================================================

interface PdfMetadata {
  titulo: string;
  fecha: string;
  version: number;
}

// ============================================================
// HTML Token Parser
// ============================================================

interface Token {
  type: 'heading1' | 'heading2' | 'heading3' | 'paragraph' | 'list-item' | 'line-break' | 'horizontal-rule';
  segments: TextSegment[];
}

interface TextSegment {
  text: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
}

function parseInlineFormatting(html: string): TextSegment[] {
  const segments: TextSegment[] = [];
  // Remove tags we don't handle inline
  let text = html.replace(/<br\s*\/?>/gi, ' ');

  // Process strong/b, em/i, u tags
  const regex = /<(strong|b|em|i|u)>(.*?)<\/\1>/gi;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  // Simple single-level inline parsing
  const cleaned = text.replace(/<(?!\/?(strong|b|em|i|u))[^>]+>/gi, '');

  // Split by bold/italic/underline tags
  const parts = cleaned.split(/(<(?:strong|b|em|i|u)>.*?<\/(?:strong|b|em|i|u)>)/gi);

  for (const part of parts) {
    const boldMatch = part.match(/^<(?:strong|b)>(.*?)<\/(?:strong|b)>$/i);
    const italicMatch = part.match(/^<(?:em|i)>(.*?)<\/(?:em|i)>$/i);
    const underlineMatch = part.match(/^<u>(.*?)<\/u>$/i);

    if (boldMatch) {
      segments.push({ text: decodeEntities(boldMatch[1]), bold: true, italic: false, underline: false });
    } else if (italicMatch) {
      segments.push({ text: decodeEntities(italicMatch[1]), bold: false, italic: true, underline: false });
    } else if (underlineMatch) {
      segments.push({ text: decodeEntities(underlineMatch[1]), bold: false, italic: false, underline: true });
    } else {
      const clean = stripTags(part).trim();
      if (clean) {
        segments.push({ text: decodeEntities(clean), bold: false, italic: false, underline: false });
      }
    }
  }

  if (segments.length === 0) {
    const plain = stripTags(cleaned).trim();
    if (plain) {
      segments.push({ text: decodeEntities(plain), bold: false, italic: false, underline: false });
    }
  }

  return segments;
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, '');
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function tokenizeHtml(html: string): Token[] {
  const tokens: Token[] = [];

  // Normalize whitespace between tags
  const normalized = html.replace(/>\s+</g, '><').trim();

  // Split into block-level elements
  const blockRegex = /<(h[1-3]|p|li|hr|br)\b[^>]*>(.*?)<\/\1>|<(hr|br)\s*\/?>/gis;
  let match: RegExpExecArray | null;
  let lastIndex = 0;

  while ((match = blockRegex.exec(normalized)) !== null) {
    // Check for text between tags
    if (match.index > lastIndex) {
      const between = normalized.slice(lastIndex, match.index).trim();
      if (between && !between.startsWith('<')) {
        const segments = parseInlineFormatting(between);
        if (segments.length > 0) {
          tokens.push({ type: 'paragraph', segments });
        }
      }
    }

    if (match[3] === 'hr') {
      tokens.push({ type: 'horizontal-rule', segments: [] });
    } else if (match[3] === 'br') {
      tokens.push({ type: 'line-break', segments: [] });
    } else {
      const tag = match[1].toLowerCase();
      const content = match[2];
      const segments = parseInlineFormatting(content);

      if (segments.length > 0) {
        const type = tag === 'h1' ? 'heading1'
          : tag === 'h2' ? 'heading2'
          : tag === 'h3' ? 'heading3'
          : tag === 'li' ? 'list-item'
          : 'paragraph';
        tokens.push({ type, segments });
      }
    }

    lastIndex = match.index + match[0].length;
  }

  // Remaining text after last match
  if (lastIndex < normalized.length) {
    const remaining = normalized.slice(lastIndex).trim();
    if (remaining) {
      const segments = parseInlineFormatting(remaining);
      if (segments.length > 0) {
        tokens.push({ type: 'paragraph', segments });
      }
    }
  }

  return tokens;
}

// ============================================================
// PDF Generation
// ============================================================

const MARGIN = 72; // 1 inch
const PAGE_WIDTH = 612; // Letter
const PAGE_HEIGHT = 792;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

const FONTS = {
  regular: 'Helvetica',
  bold: 'Helvetica-Bold',
  italic: 'Helvetica-Oblique',
  boldItalic: 'Helvetica-BoldOblique',
};

const FONT_SIZES = {
  heading1: 16,
  heading2: 14,
  heading3: 12,
  body: 10,
  footer: 8,
  header: 8,
};

export function generateContractPdf(compiledHtml: string, metadata: PdfMetadata): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    const doc = new PDFDocument({
      size: 'LETTER',
      margins: { top: MARGIN + 20, bottom: MARGIN + 20, left: MARGIN, right: MARGIN },
      info: {
        Title: metadata.titulo,
        Author: 'Habitar Propiedades',
        Subject: 'Contrato de Arrendamiento',
      },
      bufferPages: true,
    });

    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Parse HTML into tokens
    const tokens = tokenizeHtml(compiledHtml);

    // Render tokens
    for (const token of tokens) {
      // Check if we need a new page (leave space for footer)
      if (doc.y > PAGE_HEIGHT - MARGIN - 40) {
        doc.addPage();
      }

      switch (token.type) {
        case 'heading1':
          doc.moveDown(0.5);
          renderSegments(doc, token.segments, FONT_SIZES.heading1, true);
          doc.moveDown(0.3);
          break;

        case 'heading2':
          doc.moveDown(0.4);
          renderSegments(doc, token.segments, FONT_SIZES.heading2, true);
          doc.moveDown(0.2);
          break;

        case 'heading3':
          doc.moveDown(0.3);
          renderSegments(doc, token.segments, FONT_SIZES.heading3, true);
          doc.moveDown(0.2);
          break;

        case 'paragraph':
          renderSegments(doc, token.segments, FONT_SIZES.body, false);
          doc.moveDown(0.4);
          break;

        case 'list-item':
          doc.font(FONTS.regular).fontSize(FONT_SIZES.body);
          const bulletX = MARGIN + 10;
          const textX = MARGIN + 25;
          doc.text('•', bulletX, doc.y, { continued: true, width: 15 });
          doc.text('', textX, doc.y);
          renderSegments(doc, token.segments, FONT_SIZES.body, false, textX);
          doc.moveDown(0.2);
          break;

        case 'horizontal-rule':
          doc.moveDown(0.3);
          doc
            .strokeColor('#cccccc')
            .lineWidth(0.5)
            .moveTo(MARGIN, doc.y)
            .lineTo(PAGE_WIDTH - MARGIN, doc.y)
            .stroke();
          doc.moveDown(0.3);
          break;

        case 'line-break':
          doc.moveDown(0.5);
          break;
      }
    }

    // Add headers and footers to all pages
    const pageCount = doc.bufferedPageRange().count;
    for (let i = 0; i < pageCount; i++) {
      doc.switchToPage(i);

      // Header
      doc
        .font(FONTS.bold)
        .fontSize(FONT_SIZES.header)
        .fillColor('#666666')
        .text('HABITAR PROPIEDADES', MARGIN, 30, {
          width: CONTENT_WIDTH,
          align: 'center',
        });
      doc
        .font(FONTS.regular)
        .fontSize(FONT_SIZES.header)
        .text(metadata.titulo, MARGIN, 42, {
          width: CONTENT_WIDTH,
          align: 'center',
        });

      // Header line
      doc
        .strokeColor('#0d9488')
        .lineWidth(1)
        .moveTo(MARGIN, 55)
        .lineTo(PAGE_WIDTH - MARGIN, 55)
        .stroke();

      // Footer
      const footerY = PAGE_HEIGHT - MARGIN + 5;
      doc
        .strokeColor('#cccccc')
        .lineWidth(0.5)
        .moveTo(MARGIN, footerY - 5)
        .lineTo(PAGE_WIDTH - MARGIN, footerY - 5)
        .stroke();

      doc
        .font(FONTS.regular)
        .fontSize(FONT_SIZES.footer)
        .fillColor('#999999')
        .text(
          `Generado el ${metadata.fecha} | Version ${metadata.version}`,
          MARGIN,
          footerY,
          { width: CONTENT_WIDTH / 2, align: 'left' },
        );
      doc
        .text(
          `Pagina ${i + 1} de ${pageCount}`,
          MARGIN + CONTENT_WIDTH / 2,
          footerY,
          { width: CONTENT_WIDTH / 2, align: 'right' },
        );

      // Reset fill color
      doc.fillColor('#000000');
    }

    doc.end();
  });
}

function renderSegments(
  doc: PDFKit.PDFDocument,
  segments: TextSegment[],
  fontSize: number,
  isHeading: boolean,
  startX?: number,
): void {
  const x = startX ?? MARGIN;

  if (segments.length === 0) return;

  // For headings, always use bold
  if (isHeading) {
    const text = segments.map((s) => s.text).join('');
    doc.font(FONTS.bold).fontSize(fontSize).text(text, x, doc.y, {
      width: CONTENT_WIDTH - (x - MARGIN),
      lineGap: 2,
    });
    return;
  }

  // For body text with mixed formatting
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const isLast = i === segments.length - 1;

    let font = FONTS.regular;
    if (seg.bold && seg.italic) font = FONTS.boldItalic;
    else if (seg.bold) font = FONTS.bold;
    else if (seg.italic) font = FONTS.italic;

    doc.font(font).fontSize(fontSize);

    if (seg.underline) {
      doc.text(seg.text, {
        continued: !isLast,
        underline: true,
        width: isLast ? CONTENT_WIDTH - (x - MARGIN) : undefined,
        lineGap: 2,
      });
    } else {
      doc.text(seg.text, {
        continued: !isLast,
        width: isLast ? CONTENT_WIDTH - (x - MARGIN) : undefined,
        lineGap: 2,
      });
    }
  }
}
