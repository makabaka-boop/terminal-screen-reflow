import type { ParserState, TerminalEvent } from './types';
import { Utf8Decoder } from './utf8';
import { charWidth } from './width';

export interface FeedResult {
  events: TerminalEvent[];
  checkpoints: Array<{ offset: number; state: ParserState; eventCount: number }>;
}

export const initialParserState = (): ParserState => ({
  mode: 'normal',
  utf8Bytes: [],
  escapeBuffer: '',
  privateMarker: false,
  oscTerminator: 'st'
});

/**
 * Terminal byte parser. It owns decoding and escape sequence state but has no
 * screen model. State is JSON-serializable, making checkpoints and Worker
 * transfers straightforward.
 */
export class AnsiParser {
  private state: ParserState = initialParserState();
  private readonly decoder = new Utf8Decoder();

  constructor(state?: ParserState) {
    if (state) this.restoreState(state);
  }

  getState(): ParserState {
    return {
      ...this.state,
      utf8Bytes: [...this.state.utf8Bytes],
      escapeBuffer: this.state.escapeBuffer
    };
  }

  restoreState(state: ParserState): void {
    this.state = {
      ...state,
      utf8Bytes: [...state.utf8Bytes],
      escapeBuffer: state.escapeBuffer
    };
    this.decoder.restore(this.state.utf8Bytes);
  }

  feed(chunk: Uint8Array, baseOffset = 0, checkpointAt?: ReadonlySet<number>): FeedResult {
    const events: TerminalEvent[] = [];
    const checkpoints: FeedResult['checkpoints'] = [];

    for (let i = 0; i < chunk.length; i++) {
      const byte = chunk[i]!;
      const absolute = baseOffset + i;
      if (checkpointAt?.has(absolute)) {
        this.state.utf8Bytes = this.decoder.getState();
        checkpoints.push({ offset: absolute, state: this.getState(), eventCount: events.length });
      }
      const codePoint = this.decoder.feed(byte);
      if (codePoint !== null) this.consumeCodePoint(codePoint, events);
    }

    this.state.utf8Bytes = this.decoder.getState();
    checkpoints.push({
      offset: baseOffset + chunk.length,
      state: this.getState(),
      eventCount: events.length
    });
    return { events, checkpoints };
  }

  private consumeCodePoint(cp: number, events: TerminalEvent[]): void {
    switch (this.state.mode) {
      case 'normal':
        this.consumeNormal(cp, events);
        break;
      case 'escape':
        this.consumeEscape(cp, events);
        break;
      case 'csi':
        this.consumeCsi(cp, events);
        break;
      case 'osc':
        this.consumeOsc(cp);
        break;
    }
  }

  private consumeNormal(cp: number, events: TerminalEvent[]): void {
    switch (cp) {
      case 0x07:
      case 0x0e:
      case 0x0f:
        return;
      case 0x08:
        events.push({ type: 'backspace' });
        return;
      case 0x09:
        events.push({ type: 'tab' });
        return;
      case 0x0a:
      case 0x0b:
      case 0x0c:
        events.push({ type: 'lineFeed' });
        return;
      case 0x0d:
        events.push({ type: 'carriageReturn' });
        return;
      case 0x1b:
        this.state.mode = 'escape';
        this.state.escapeBuffer = '';
        this.state.privateMarker = false;
        return;
      case 0x7f:
        return;
      case 0x85:
        events.push({ type: 'lineFeed' });
        return;
      case 0x8a:
        events.push({ type: 'cursorForward', amount: 1 });
        return;
      case 0x8d:
        events.push({ type: 'lineFeed' });
        return;
      case 0x9b:
        this.state.mode = 'csi';
        this.state.escapeBuffer = '';
        this.state.privateMarker = false;
        return;
      case 0x9d:
        this.state.mode = 'osc';
        this.state.escapeBuffer = '';
        this.state.oscTerminator = 'st';
        return;
    }

    if (cp < 0x20 || (cp >= 0x80 && cp < 0xa0)) return;
    const width = charWidth(cp);
    if (width === 0) {
      // A stray combining mark still enters the current/previous terminal cell.
      events.push({ type: 'print', text: String.fromCodePoint(cp) });
    } else {
      events.push({ type: 'print', text: String.fromCodePoint(cp) });
    }
  }

  private consumeEscape(cp: number, events: TerminalEvent[]): void {
    if (this.state.escapeBuffer === '') {
      if (cp === 0x5b) {
        this.state.mode = 'csi';
        this.state.escapeBuffer = '';
        return;
      }
      if (cp === 0x5d) {
        this.state.mode = 'osc';
        this.state.escapeBuffer = '';
        this.state.oscTerminator = 'st';
        return;
      }
      if (cp === 0x37) {
        events.push({ type: 'saveCursor' });
        this.state.mode = 'normal';
        return;
      }
      if (cp === 0x38) {
        events.push({ type: 'restoreCursor' });
        this.state.mode = 'normal';
        return;
      }
      if (cp === 0x44) {
        events.push({ type: 'lineFeed' });
        this.state.mode = 'normal';
        return;
      }
      if (cp === 0x4d) {
        events.push({ type: 'reverseIndex' });
        this.state.mode = 'normal';
        return;
      }
      if (cp === 0x20 || cp === 0x23 || cp === 0x25 || cp === 0x28 || cp === 0x29 || cp === 0x2a || cp === 0x2b || cp === 0x2d || cp === 0x2e || cp === 0x2f) {
        this.state.escapeBuffer = String.fromCodePoint(cp);
        return;
      }
      // Unknown two-byte escape: the next character completes it.
      this.state.mode = 'normal';
      return;
    }

    // Designate character set and similar ignored escapes.
    this.state.mode = 'normal';
  }

  private consumeCsi(cp: number, events: TerminalEvent[]): void {
    if (this.state.escapeBuffer === '' && (cp === 0x3f || cp === 0x3e || cp === 0x3c || cp === 0x3d)) {
      this.state.privateMarker = cp === 0x3f;
      return;
    }

    if ((cp >= 0x30 && cp <= 0x39) || cp === 0x3a || cp === 0x3b) {
      this.state.escapeBuffer += String.fromCodePoint(cp);
      return;
    }

    if (cp < 0x40 || cp > 0x7e) {
      // Tolerate unexpected intermediate bytes without losing the whole stream.
      return;
    }

    const command = String.fromCodePoint(cp);
    const privateMarker = this.state.privateMarker;
    const params = this.state.escapeBuffer
      .split(';')
      .filter(part => part.length > 0)
      .map(part => Number.parseInt(part, 10));
    this.state.mode = 'normal';
    this.state.escapeBuffer = '';
    this.state.privateMarker = false;

    if (privateMarker) return;
    this.dispatchCsi(command, params, events);
  }

  private dispatchCsi(command: string, params: number[], events: TerminalEvent[]): void {
    const first = params[0] ?? 0;
    switch (command) {
      case 'A':
        events.push({ type: 'cursorUp', amount: Math.max(1, first) });
        break;
      case 'B':
        events.push({ type: 'cursorDown', amount: Math.max(1, first) });
        break;
      case 'C':
        events.push({ type: 'cursorForward', amount: Math.max(1, first) });
        break;
      case 'D':
        events.push({ type: 'cursorBack', amount: Math.max(1, first) });
        break;
      case 'H':
      case 'f':
        events.push({ type: 'cursorPosition', row: params[0], col: params[1] });
        break;
      case 'J':
        events.push({ type: 'eraseDisplay', mode: normalizeEraseMode(first) as 0 | 1 | 2 | 3 });
        break;
      case 'K':
        events.push({ type: 'eraseLine', mode: normalizeEraseMode(first) as 0 | 1 | 2 });
        break;
      case 'm': {
        const sgr = params.length === 0 ? [0] : params.map(value => (Number.isFinite(value) ? value : 0));
        events.push({ type: 'sgr', params: sgr });
        break;
      }
      case 'S':
        events.push({ type: 'scroll', amount: Math.max(1, first) });
        break;
      default:
        // Unsupported sequences have no observable terminal effect.
        break;
    }
  }

  private consumeOsc(cp: number): void {
    if (cp === 0x07) {
      this.state.mode = 'normal';
      this.state.escapeBuffer = '';
      return;
    }
    if (cp === 0x1b) {
      this.state.mode = 'escape';
      this.state.escapeBuffer = '';
      return;
    }
    if (cp >= 0x20 && cp < 0x7f) {
      this.state.escapeBuffer += String.fromCodePoint(cp);
    }
  }
}

function normalizeEraseMode(value: number): number {
  return value === 0 || value === 1 || value === 2 || value === 3 ? value : 0;
}
