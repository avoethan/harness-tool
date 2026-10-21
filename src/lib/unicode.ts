export interface HiddenHit {
  offset: number;
  codePoint: number;
  kind: 'tag' | 'zero-width' | 'bidi' | 'bom';
}

/**
 * Find hidden or steering code points: Unicode tag block (U+E0000–E007F),
 * zero-width characters, bidi controls, and a BOM not at the start.
 */
export function scanHiddenUnicode(text: string): HiddenHit[] {
  const hits: HiddenHit[] = [];
  let offset = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    let kind: HiddenHit['kind'] | null = null;
    if (cp >= 0xe0000 && cp <= 0xe007f) kind = 'tag';
    else if (cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0x2060) kind = 'zero-width';
    else if (cp === 0xfeff && offset !== 0) kind = 'bom';
    else if ((cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069)) kind = 'bidi';
    if (kind) hits.push({ offset, codePoint: cp, kind });
    offset += ch.length;
  }
  return hits;
}

export function hasHiddenUnicode(text: string): boolean {
  return scanHiddenUnicode(text).length > 0;
}

/** Remove hidden code points (used only on text the harness itself generated from untrusted sources). */
export function stripHiddenUnicode(text: string): string {
  let out = '';
  let offset = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const hidden =
      (cp >= 0xe0000 && cp <= 0xe007f) ||
      cp === 0x200b ||
      cp === 0x200c ||
      cp === 0x200d ||
      cp === 0x2060 ||
      (cp === 0xfeff && offset !== 0) ||
      (cp >= 0x202a && cp <= 0x202e) ||
      (cp >= 0x2066 && cp <= 0x2069);
    if (!hidden) out += ch;
    offset += ch.length;
  }
  return out;
}
