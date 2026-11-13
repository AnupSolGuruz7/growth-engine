export interface Chunk {
  /** Heading breadcrumb, e.g. "Brand facts › What we are not". Empty for text before any heading. */
  heading: string;
  content: string;
  /** Rough token estimate (chars / 4) used to budget prompt context. */
  tokens: number;
}

export interface ChunkedDoc {
  title: string;
  chunks: Chunk[];
}

/** ~450 tokens: fits the embedding model's 512-token window with the title/heading prefix. */
const MAX_CHARS = 1700;
const MIN_CHARS = 280;

const estTokens = (s: string) => Math.ceil(s.length / 4);
const clean = (s: string) => s.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
const stripMd = (s: string) => s.replace(/[*_`]/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim();

/** Splits one over-long section at paragraph, then line, then hard boundaries. */
function splitLong(text: string): string[] {
  if (text.length <= MAX_CHARS) return [text];
  const parts: string[] = [];
  let buf = '';
  const flush = () => {
    if (buf.trim()) parts.push(buf.trim());
    buf = '';
  };
  for (const para of text.split(/\n\n+/)) {
    const pieces = para.length > MAX_CHARS ? para.split(/\n/) : [para];
    for (let piece of pieces) {
      while (piece.length > MAX_CHARS) {
        flush();
        const cut = piece.lastIndexOf(' ', MAX_CHARS);
        parts.push(piece.slice(0, cut > MAX_CHARS / 2 ? cut : MAX_CHARS).trim());
        piece = piece.slice(cut > MAX_CHARS / 2 ? cut : MAX_CHARS);
      }
      if (buf.length + piece.length + 2 > MAX_CHARS) flush();
      buf += (buf ? '\n\n' : '') + piece;
    }
  }
  flush();
  return parts;
}

/**
 * Markdown -> heading-scoped chunks. Each chunk keeps its heading breadcrumb so a retrieved passage
 * can be cited ("knowledge/brand-facts.md › Pricing") and still makes sense out of context. Headings
 * inside fenced code blocks are ignored; tiny sections are merged into the next one.
 */
export function chunkMarkdown(md: string, fallbackTitle: string): ChunkedDoc {
  const lines = clean(md).split('\n');
  const sections: { trail: string[]; body: string[] }[] = [{ trail: [], body: [] }];
  const trail: string[] = [];
  let title = '';
  let fence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const h = !fence ? line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/) : null;
    if (h) {
      const level = h[1]!.length;
      const text = stripMd(h[2]!);
      if (level === 1 && !title) title = text;
      trail.length = Math.min(trail.length, level - 1);
      while (trail.length < level - 1) trail.push('');
      trail[level - 1] = text;
      sections.push({ trail: trail.filter(Boolean), body: [] });
      continue;
    }
    sections[sections.length - 1]!.body.push(line);
  }
  title ||= fallbackTitle;

  const chunks: Chunk[] = [];
  let carry = '';
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i]!;
    // drop the document title from breadcrumbs: every chunk already carries the document title
    const crumbs = s.trail[0] === title ? s.trail.slice(1) : s.trail;
    const body = clean(s.body.join('\n'));
    const text = clean([carry, body].filter(Boolean).join('\n\n'));
    const isLast = i === sections.length - 1;
    if (!text) continue;
    if (text.length < MIN_CHARS && !isLast) {
      // too small to stand alone: carry it (with its heading) into the next section
      carry = crumbs.length ? `${crumbs[crumbs.length - 1]}:\n${text}` : text;
      continue;
    }
    carry = '';
    for (const part of splitLong(text)) chunks.push({ heading: crumbs.join(' › '), content: part, tokens: estTokens(part) });
  }
  return { title, chunks };
}

/** Plain text: paragraph-packed chunks with no headings. */
export function chunkText(text: string, title: string): ChunkedDoc {
  return { title, chunks: splitLong(clean(text)).map((p) => ({ heading: '', content: p, tokens: estTokens(p) })) };
}

/** What gets embedded: document title and heading give the vector the passage's context. */
export const embeddingInput = (docTitle: string, c: Chunk) => `${docTitle}${c.heading ? ` — ${c.heading}` : ''}\n${c.content}`;
