/**
 * Incremental UTF-8 decoder. Pending bytes are retained at chunk boundaries, so
 * splitting a multi-byte character at any point produces the same code points
 * as feeding it in one Uint8Array.
 */
export class Utf8Decoder {
  private bytes: number[] = [];
  private expected = 0;

  feed(byte: number): number | null {
    if (this.expected === 0) {
      if (byte <= 0x7f) return byte;

      if ((byte & 0xe0) === 0xc0) {
        this.expected = 2;
      } else if ((byte & 0xf0) === 0xe0) {
        this.expected = 3;
      } else if ((byte & 0xf8) === 0xf0) {
        this.expected = 4;
      } else {
        return 0xfffd;
      }
      this.bytes = [byte];
      return null;
    }

    if ((byte & 0xc0) !== 0x80) {
      this.reset();
      // The invalid byte must be interpreted again as a new lead/ASCII byte.
      return this.feed(byte);
    }

    this.bytes.push(byte);
    if (this.bytes.length < this.expected) return null;

    const value = decodeComplete(this.bytes, this.expected);
    this.reset();
    return value;
  }

  getState(): number[] {
    return [...this.bytes];
  }

  restore(bytes: readonly number[]): void {
    this.bytes = [...bytes];
    this.expected = expectedLength(bytes[0] ?? 0);
  }

  reset(): void {
    this.bytes = [];
    this.expected = 0;
  }
}

function expectedLength(lead: number): number {
  if ((lead & 0xe0) === 0xc0) return 2;
  if ((lead & 0xf0) === 0xe0) return 3;
  if ((byte0 => (byte0 & 0xf8) === 0xf0)(lead)) return 4;
  return 0;
}

function decodeComplete(bytes: readonly number[], expected: number): number {
  let value = 0;
  if (expected === 2) {
    value = ((bytes[0]! & 0x1f) << 6) | (bytes[1]! & 0x3f);
    if (value < 0x80) return 0xfffd;
  } else if (expected === 3) {
    value = ((bytes[0]! & 0x0f) << 12) | ((bytes[1]! & 0x3f) << 6) | (bytes[2]! & 0x3f);
    if (value < 0x800 || (value >= 0xd800 && value <= 0xdfff)) return 0xfffd;
  } else {
    value =
      ((bytes[0]! & 0x07) << 18) |
      ((bytes[1]! & 0x3f) << 12) |
      ((bytes[2]! & 0x3f) << 6) |
      (bytes[3]! & 0x3f);
    if (value < 0x10000 || value > 0x10ffff) return 0xfffd;
  }
  return value;
}
