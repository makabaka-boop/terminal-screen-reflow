const graphemeExtend = /\p{Grapheme_Extend}/u;

const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x231a, 0x231b],
  [0x2329, 0x232a],
  [0x23e9, 0x23ec],
  [0x23f0, 0x23f3],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2648, 0x2653],
  [0x267f, 0x267f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f3],
  [0x26f5, 0x26f5],
  [0x26fa, 0x26fa],
  [0x26fd, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0x2e80, 0x303e], // CJK radicals, Kangxi, symbols
  [0x3041, 0x33ff], // Hiragana through enclosed CJK
  [0x3400, 0x4dbf], // CJK Extension A
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0xa000, 0xa4cf], // Yi
  [0xa960, 0xa97f], // Hangul Jamo Extended-A
  [0xac00, 0xd7a3], // Hangul Syllables
  [0xf900, 0xfaff], // CJK Compatibility Ideographs
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60], // Fullwidth Latin and punctuation
  [0xffe0, 0xffe6],
  [0x1f000, 0x1f02f],
  [0x1f0a0, 0x1f0ff],
  [0x1f100, 0x1f1ff],
  [0x1f200, 0x1f2ff],
  [0x1f300, 0x1f64f],
  [0x1f680, 0x1f6ff],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x2fffd],
  [0x30000, 0x3fffd]
];

export function isGraphemeExtend(codePoint: number): boolean {
  return graphemeExtend.test(String.fromCodePoint(codePoint));
}

/**
 * Terminal cell width. Combining marks have width zero; known CJK and emoji
 * presentation characters have width two.
 */
export function charWidth(codePoint: number): 0 | 1 | 2 {
  if (codePoint === 0 || (codePoint < 32 && codePoint !== 0x09) || (codePoint >= 0x7f && codePoint < 0xa0)) {
    return 0;
  }
  if (isGraphemeExtend(codePoint)) return 0;
  for (const [start, end] of WIDE_RANGES) {
    if (codePoint >= start && codePoint <= end) return 2;
  }
  return 1;
}

export interface Grapheme {
  text: string;
  width: 1 | 2;
}

/** Split printed text into base character plus its combining marks. */
export function splitGraphemes(text: string): Grapheme[] {
  const result: Grapheme[] = [];
  for (const char of text) {
    const cp = char.codePointAt(0)!;
    if (isGraphemeExtend(cp) && result.length > 0) {
      const previous = result[result.length - 1]!;
      previous.text += char;
    } else {
      const width = charWidth(cp);
      result.push({
        text: char,
        width: width === 0 ? 1 : width
      });
    }
  }
  return result;
}
