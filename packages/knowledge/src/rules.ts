/**
 * Content rules read STATICALLY from a source's `rules/*.mjs` files. The files are parsed as text and
 * never imported or executed: a knowledge source is someone else's repository, and running its code
 * inside the API would hand that repository the server.
 *
 * Two shapes are recognised, matching the growth-engine convention:
 *   { word: 'delve', why: '...', severity: 'block' }            -> kind "word" (literal phrase)
 *   { id: 'iso-27001', pattern: /.../i, why: '...', severity }  -> kind "claim" (regex)
 *   (a claim needs a non-empty `why`; id+pattern lists without one, such as topic detectors, are skipped)
 */
export interface ContentRule {
  kind: 'word' | 'claim';
  rule_id: string;
  /** For words: the literal phrase. For claims: the regex source. */
  pattern: string;
  flags: string;
  severity: 'block' | 'warn';
  why: string;
  file: string;
}

export interface RuleFlag {
  rule_id: string;
  kind: 'word' | 'claim';
  severity: 'block' | 'warn';
  quoted: string;
  why: string;
}

function readString(src: string, i: number): { value: string; end: number } | null {
  let value = '';
  let pos = i;
  let found = false;
  // supports 'a' + 'b' concatenation across lines
  for (;;) {
    while (/\s/.test(src[pos] ?? '')) pos++;
    const q = src[pos];
    if (q !== "'" && q !== '"' && q !== '`') break;
    let j = pos + 1;
    let s = '';
    while (j < src.length && src[j] !== q) {
      if (src[j] === '\\') {
        const n = src[j + 1];
        s += n === 'n' ? '\n' : n === 't' ? '\t' : (n ?? '');
        j += 2;
        continue;
      }
      if (q === '`' && src[j] === '$' && src[j + 1] === '{') return null; // template with code: not a plain literal
      s += src[j];
      j++;
    }
    value += s;
    found = true;
    pos = j + 1;
    let k = pos;
    while (/\s/.test(src[k] ?? '')) k++;
    if (src[k] !== '+') break;
    pos = k + 1;
  }
  return found ? { value, end: pos } : null;
}

function readRegex(src: string, i: number): { source: string; flags: string; end: number } | null {
  if (src[i] !== '/') return null;
  let j = i + 1;
  let inClass = false;
  while (j < src.length) {
    const c = src[j];
    if (c === '\n') return null;
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) break;
    j++;
  }
  if (src[j] !== '/') return null;
  const source = src.slice(i + 1, j);
  const flags = (src.slice(j + 1).match(/^[a-z]*/) ?? [''])[0]!;
  return { source, flags, end: j + 1 + flags.length };
}

/** Parses one rules file's text. Unparseable entries are skipped, never guessed. */
export function parseRuleFile(src: string, file: string): ContentRule[] {
  const rules: ContentRule[] = [];
  type Rec = { id?: string; word?: string; pattern?: { source: string; flags: string }; why?: string; severity?: string };
  let cur: Rec | null = null;
  const done = () => {
    if (!cur) return;
    const sev = cur.severity === 'warn' || cur.severity === 'soft' ? 'warn' : 'block';
    if (cur.word && cur.word.trim()) {
      rules.push({ kind: 'word', rule_id: cur.word.trim().toLowerCase(), pattern: cur.word.trim(), flags: 'i', severity: sev, why: cur.why ?? '', file });
    } else if (cur.id && cur.pattern && cur.why?.trim()) {
      // a claim rule must say why: pattern lists without one (e.g. topic detectors) are not prohibitions
      try {
        new RegExp(cur.pattern.source, cur.pattern.flags.replace(/[gy]/g, ''));
        rules.push({ kind: 'claim', rule_id: cur.id, pattern: cur.pattern.source, flags: cur.pattern.flags.replace(/[gy]/g, ''), severity: sev, why: cur.why ?? '', file });
      } catch {
        /* a pattern JS cannot compile is skipped */
      }
    }
    cur = null;
  };
  const key = /(?:^|[\s{,])(id|word|pattern|why|severity)\s*:\s*/g;
  for (let m = key.exec(src); m; m = key.exec(src)) {
    const k = m[1] as keyof Rec;
    const at = m.index + m[0].length;
    if (k === 'id' || k === 'word') {
      // a new id/word starts a new record unless the current one has not got its own yet
      if (cur && (cur.id || cur.word)) done();
      cur ??= {};
    }
    if (!cur) continue;
    if (k === 'pattern') {
      const r = readRegex(src, at);
      if (r) {
        cur.pattern = { source: r.source, flags: r.flags };
        key.lastIndex = r.end;
      }
      continue;
    }
    const s = readString(src, at);
    if (!s) continue;
    if (k === 'id') cur.id = s.value;
    else if (k === 'word') cur.word = s.value;
    else if (k === 'why') cur.why = s.value;
    else if (k === 'severity') cur.severity = s.value;
    key.lastIndex = s.end;
  }
  done();
  return rules;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Compiled matcher for a rule. Words match as whole phrases (hyphen counts as part of a word). */
export function compileRule(r: Pick<ContentRule, 'kind' | 'pattern' | 'flags'>): RegExp | null {
  try {
    if (r.kind === 'word') {
      const phrase = r.pattern.trim().split(/\s+/).map(escapeRe).join('\\s+');
      return new RegExp(`(?<![\\w-])${phrase}(?![\\w-])`, 'i');
    }
    return new RegExp(r.pattern, r.flags.replace(/[gy]/g, ''));
  } catch {
    return null;
  }
}

/** Checks text against rules and returns every rule it breaks (first match quoted). */
export function checkRules(text: string, rules: ContentRule[] | Omit<ContentRule, 'file'>[]): RuleFlag[] {
  const flags: RuleFlag[] = [];
  const seen = new Set<string>();
  for (const r of rules) {
    const re = compileRule(r);
    const m = re ? text.match(re) : null;
    if (!m || seen.has(r.kind + r.rule_id)) continue;
    seen.add(r.kind + r.rule_id);
    flags.push({ rule_id: r.rule_id, kind: r.kind, severity: r.severity, quoted: m[0], why: r.why.slice(0, 400) });
  }
  return flags.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'block' ? -1 : 1));
}
