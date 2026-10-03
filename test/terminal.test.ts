import { describe, expect, it } from 'vitest';
import { AnsiParser, initialParserState } from '../src/terminal/parser';
import { TerminalReplay } from '../src/terminal/replay';
import { TerminalScreen } from '../src/terminal/screen';
import type { ParserState, TerminalEvent, WorkerResponse } from '../src/terminal/types';

function parseAll(chunks: Uint8Array[]): { events: TerminalEvent[]; state: ParserState } {
  const parser = new AnsiParser();
  const events: TerminalEvent[] = [];
  for (const chunk of chunks) {
    const result = parser.feed(chunk);
    events.push(...result.events);
  }
  return { events, state: parser.getState() };
}

function modelFromEvents(events: readonly TerminalEvent[], cols = 80, rows = 24): TerminalScreen {
  const screen = new TerminalScreen(cols, rows);
  screen.apply(events);
  return screen;
}

async function flushMicrotasks(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

function byteChunks(bytes: Uint8Array, size: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) chunks.push(bytes.slice(i, i + size));
  return chunks;
}

function visibleText(screen: TerminalScreen): string {
  return screen.active
    .map(line =>
      line.slots
        .filter(slot => slot && !slot.continuation)
        .map(slot => slot!.cell.text)
        .join('')
    )
    .join('\n');
}

function findCellId(screen: TerminalScreen, text: string, occurrence = 0): number {
  let seen = 0;
  for (const line of [...screen.history, ...screen.active]) {
    for (const slot of line.slots) {
      if (slot && !slot.continuation && slot.cell.text === text) {
        if (seen === occurrence) return slot.cell.id;
        seen += 1;
      }
    }
  }
  throw new Error(`cell not found: ${text}`);
}

class FakeWorker {
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;
  pending = 0;

  postMessage(message: unknown): void {
    const request = message as {
      generation: number;
      start: number;
      bytes: Uint8Array;
      state: ParserState | null;
      checkpointEvery: number;
    };
    this.pending += 1;
    queueMicrotask(() => {
      if (this.terminated) return;
      const parser = new AnsiParser(request.state ?? initialParserState());
      const wanted = new Set<number>();
      const end = request.start + request.bytes.length;
      for (let offset = request.start; offset <= end; offset++) {
        if (offset % request.checkpointEvery === 0) wanted.add(offset);
      }
      const result = parser.feed(request.bytes, request.start, wanted);
      this.onmessage?.({
        data: {
          type: 'events',
          generation: request.generation,
          start: request.start,
          end,
          events: result.events,
          checkpoints: result.checkpoints.map(checkpoint => ({
            offset: checkpoint.offset,
            parser: checkpoint.state,
            eventCount: checkpoint.eventCount
          }))
        }
      } as MessageEvent<WorkerResponse>);
    });
  }

  terminate(): void {
    this.terminated = true;
  }
}

describe('incremental UTF-8 parsing', () => {
  it('produces identical events and screen for arbitrary chunks', () => {
    const text = 'héllo 你好，世界 あ é\x1b[31mred\x1b[0m\n第二行';
    const bytes = new TextEncoder().encode(text);
    const whole = parseAll([bytes]);

    for (const size of [1, 2, 3, 5, 7, 16]) {
      const split = parseAll(byteChunks(bytes, size));
      expect(split.events).toEqual(whole.events);
      expect(split.state).toEqual(whole.state);
      expect(visibleText(modelFromEvents(split.events))).toBe(visibleText(modelFromEvents(whole.events)));
    }
  });

  it('completes a truncated escape sequence from a later chunk', () => {
    const bytes = new TextEncoder().encode('\x1b[31mOK\x1b[0m');
    const split = [bytes.slice(0, 2), bytes.slice(2, 4), bytes.slice(4)];
    const events = parseAll(split).events;
    expect(events).toEqual(parseAll([bytes]).events);
  });
});

describe('wide characters and combining marks', () => {
  it('never leaves half of an overwritten wide character', () => {
    const screen = new TerminalScreen(8, 2);
    screen.apply(parseAll([new TextEncoder().encode('a中')]).events);
    // Move to the second physical column, i.e. the continuation half of 中.
    screen.apply([{ type: 'cursorPosition', row: 1, col: 3 }, { type: 'print', text: 'X' }]);
    const slots = screen.active[0]!.slots;
    expect(slots[0]!.cell.text).toBe('a');
    expect(slots[2]!.cell.text).toBe('X');
    expect(slots[1]).toBeUndefined();
    expect(slots[3]).toBeUndefined();
    expect(slots[2]!.continuation).toBeUndefined();
  });

  it('moves a wide character to the next row instead of splitting it', () => {
    const screen = new TerminalScreen(4, 2);
    screen.apply(parseAll([new TextEncoder().encode('abc中')]).events);
    expect(visibleText(screen)).toBe('abc\n中');
    const first = screen.active[0]!.slots;
    expect(first[3]).toBeUndefined();
    expect(screen.active[1]!.slots[0]!.continuation).toBeUndefined();
    expect(screen.active[1]!.slots[1]!.continuation).toBe(true);
  });

  it('keeps a combining mark with its original base cell', () => {
    const screen = new TerminalScreen(8, 1);
    screen.apply(parseAll([new TextEncoder().encode('eé')]).events);
    const cells = screen.active[0]!.slots.filter(Boolean).map(slot => slot!.cell.text);
    expect(cells).toEqual(['e', 'é']);
  });
});

describe('reflow and identity-based selection', () => {
  it('copies the same logical text after changing column count', () => {
    const screen = new TerminalScreen(4, 4);
    screen.apply(parseAll([new TextEncoder().encode('ab\ncdefghij')]).events);
    const start = findCellId(screen, 'c');
    const end = findCellId(screen, 'f');
    screen.selection = {
      anchor: { id: start, side: 'start' },
      focus: { id: end, side: 'end' }
    };
    expect(screen.selectedText()).toBe('cdef');

    screen.resize(6, 4);
    expect(screen.selectedText()).toBe('cdef');
  });
});

describe('scrollback', () => {
  it('keeps at most ten thousand history lines', () => {
    const screen = new TerminalScreen(80, 4);
    for (let i = 0; i < 10_100; i++) screen.apply([{ type: 'print', text: `l${i}` }, { type: 'lineFeed' }]);
    expect(screen.history.length).toBeLessThanOrEqual(10_000);
  });
});

describe('replay generation and checkpoints', () => {
  it('rebuilds arbitrary drag positions from checkpoints', async () => {
    const bytes = new TextEncoder().encode('alpha\nbeta\ngamma\ndelta\nomega');
    let target = '';
    const replay = new TerminalReplay({
      cols: 20,
      rows: 3,
      workerFactory: () => new FakeWorker() as unknown as Worker,
      checkpointEvery: 4,
      chunkSize: 4,
      maxCheckpoints: 64
    });
    replay.setTrace(bytes);
    replay.seek(bytes.length);
    await flushMicrotasks(64);
    expect(replay.getPosition()).toBe(bytes.length);
    target = visibleText(replay.screen);

    replay.seek(11);
    await flushMicrotasks(32);
    expect(replay.getPosition()).toBe(11);
    replay.seek(bytes.length);
    await flushMicrotasks(64);
    expect(visibleText(replay.screen)).toBe(target);
    replay.dispose();
  });

  it('ignores an old worker response after a newer drag generation', async () => {
    const workers: FakeWorker[] = [];
    const bytes = new TextEncoder().encode('0123456789abcdefghijklmnopqrstuvwxyz');
    const replay = new TerminalReplay({
      cols: 10,
      rows: 2,
      workerFactory: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker as unknown as Worker;
      },
      checkpointEvery: 1024,
      chunkSize: 1024
    });
    replay.setTrace(bytes);

    replay.seek(20);
    replay.seek(5);
    const old = workers[workers.length - 2]!;
    const current = workers[workers.length - 1]!;
    await Promise.resolve();
    await Promise.resolve();

    expect(old.terminated).toBe(true);
    expect(current.terminated).toBe(false);
    expect(replay.getPosition()).toBe(5);
    expect(visibleText(replay.screen).trim()).toBe('01234');
    expect(replay.getCheckpointCount()).toBeGreaterThan(0);
    replay.dispose();
  });
});
