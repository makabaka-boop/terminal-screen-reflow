import { TerminalScreen } from './screen';
import { initialParserState } from './parser';
import type {
  Checkpoint,
  EventsBlock,
  ParserState,
  ScreenSnapshot,
  TerminalEvent,
  WorkerResponse
} from './types';

export interface WorkerFactory {
  (): Worker;
}

export interface ReplayOptions {
  cols: number;
  rows: number;
  workerFactory: WorkerFactory;
  checkpointEvery?: number;
  chunkSize?: number;
  maxCheckpoints?: number;
}

type Listener = () => void;

const makeInitialCheckpoint = (screen: TerminalScreen): Checkpoint<ScreenSnapshot> => ({
  offset: 0,
  parser: initialParserState(),
  screen: screen.snapshot()
});

/**
 * Drives parser Workers in generations and applies their deterministic event
 * stream to a screen model. Checkpoint snapshots always correspond to parser
 * state and screen content at the same byte offset.
 */
export class TerminalReplay {
  readonly screen: TerminalScreen;
  private readonly workerFactory: WorkerFactory;
  private readonly checkpointEvery: number;
  private readonly chunkSize: number;
  private readonly maxCheckpoints: number;
  private worker: Worker | null = null;
  private generation = 0;
  private bytes: Uint8Array<ArrayBufferLike> = new Uint8Array();
  private position = 0;
  private desired = 0;
  private inFlight = false;
  private playing = false;
  private playbackRate = 1024;
  private timer: ReturnType<typeof setInterval> | null = null;
  private checkpoints: Array<Checkpoint<ScreenSnapshot>> = [];
  private readonly listeners = new Set<Listener>();

  constructor(options: ReplayOptions) {
    this.screen = new TerminalScreen(options.cols, options.rows);
    this.workerFactory = options.workerFactory;
    this.checkpointEvery = Math.max(64, options.checkpointEvery ?? 4096);
    this.chunkSize = Math.max(16, options.chunkSize ?? 4096);
    this.maxCheckpoints = Math.max(2, options.maxCheckpoints ?? 128);
    this.checkpoints.push(makeInitialCheckpoint(this.screen));
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  setTrace(bytes: Uint8Array): void {
    this.stopPlayback();
    this.cancelWorker();
    this.bytes = bytes;
    this.position = 0;
    this.desired = 0;
    this.screen.reset();
    this.checkpoints = [makeInitialCheckpoint(this.screen)];
    this.notify();
  }

  resize(cols: number, rows: number): void {
    this.stopPlayback();
    this.cancelWorker();
    this.screen.resize(cols, rows);

    // Parser state remains valid after a view-only geometry change. Replace the
    // current-position checkpoint so later requests continue from the new model.
    const parser = this.newestCheckpointAtOrBefore(this.position).parser;
    this.rememberCheckpoint(this.position, parser, this.screen.snapshot(), true);
    this.notify();
  }

  getPosition(): number {
    return this.position;
  }

  get duration(): number {
    return this.bytes.length;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  setPlaybackRate(bytesPerTick: number): void {
    this.playbackRate = Math.max(1, bytesPerTick);
  }

  play(): void {
    if (this.playing) return;
    if (this.position >= this.bytes.length) this.seek(0);
    this.playing = true;
    this.advanceDesired();
    this.timer = setInterval(() => this.advanceDesired(), 16);
  }

  pause(): void {
    this.stopPlayback();
    this.desired = this.position;
    this.cancelWorker();
    this.notify();
  }

  private stopPlayback(): void {
    this.playing = false;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  seek(target: number): void {
    const clamped = Math.max(0, Math.min(this.bytes.length, Math.floor(target)));
    this.stopPlayback();
    this.cancelWorker();
    this.desired = clamped;

    const checkpoint = this.newestCheckpointAtOrBefore(clamped);
    const cols = this.screen.cols;
    const rows = this.screen.rows;
    this.screen.restore(checkpoint.screen);
    if (this.screen.cols !== cols || this.screen.rows !== rows) this.screen.resize(cols, rows);
    this.position = checkpoint.offset;
    this.checkpoints = this.checkpoints.filter(item => item.offset <= checkpoint.offset);
    this.notify();

    if (clamped > checkpoint.offset) this.dispatch(clamped);
  }

  private advanceDesired(): void {
    if (this.inFlight) return;
    if (this.position >= this.bytes.length) {
      this.pause();
      return;
    }
    this.desired = Math.min(this.bytes.length, Math.max(this.desired, this.position + this.playbackRate));
    if (this.desired > this.position) this.dispatch(this.desired);
  }

  private newestCheckpointAtOrBefore(offset: number): Checkpoint<ScreenSnapshot> {
    let result = this.checkpoints[0]!;
    for (const checkpoint of this.checkpoints) {
      if (checkpoint.offset <= offset && checkpoint.offset >= result.offset) result = checkpoint;
    }
    return result;
  }

  private dispatch(originalTarget: number): void {
    const checkpoint = this.newestCheckpointAtOrBefore(this.position);
    const target = Math.min(originalTarget, this.bytes.length);
    const generation = ++this.generation;
    const worker = this.workerFactory();
    this.worker = worker;
    this.inFlight = true;

    worker.onmessage = event => this.handleMessage(event.data as WorkerResponse, generation, target);
    worker.onerror = event => {
      if (generation !== this.generation) return;
      this.inFlight = false;
      console.error(event.message);
    };

    const length = Math.min(this.chunkSize, target - checkpoint.offset);
    const slice = this.bytes.slice(checkpoint.offset, checkpoint.offset + length);
    worker.postMessage({
      type: 'parse',
      generation,
      start: checkpoint.offset,
      bytes: slice,
      state: checkpoint.parser,
      checkpointEvery: this.checkpointEvery
    });
  }

  private handleMessage(message: WorkerResponse, generation: number, target: number): void {
    if (generation !== this.generation) return;
    if (message.type === 'error') throw new Error(message.message);

    this.applyBlock(message as EventsBlock, target);
    this.inFlight = false;

    if (this.position < target || (this.playing && this.position < this.desired)) {
      this.dispatch(this.desired);
    } else if (this.playing && this.position >= this.bytes.length) {
      this.pause();
    } else {
      this.notify();
    }
  }

  private applyBlock(block: EventsBlock, target: number): void {
    let previousCount = 0;
    for (const checkpoint of block.checkpoints) {
      if (checkpoint.offset < block.start || checkpoint.offset > block.end) continue;
      const eventsToApply: TerminalEvent[] = block.events.slice(previousCount, checkpoint.eventCount);
      this.screen.apply(eventsToApply);
      this.position = checkpoint.offset;
      this.rememberCheckpoint(checkpoint.offset, checkpoint.parser, this.screen.snapshot());
      previousCount = checkpoint.eventCount;
    }

    if (this.position < Math.min(target, block.end)) {
      this.screen.apply(block.events.slice(previousCount));
      this.position = block.end;
    }
  }

  private rememberCheckpoint(
    offset: number,
    parser: ParserState,
    screen: ScreenSnapshot,
    replaceAtOffset = false
  ): void {
    this.checkpoints = this.checkpoints.filter(item => !(replaceAtOffset && item.offset === offset));
    if (this.checkpoints.some(item => item.offset === offset)) return;
    this.checkpoints.push({ offset, parser, screen });
    this.checkpoints.sort((a, b) => a.offset - b.offset);
    while (this.checkpoints.length > this.maxCheckpoints) {
      // Keep offset zero so even very old drag positions can always rebuild.
      const index = this.checkpoints.findIndex(item => item.offset !== 0);
      if (index === -1) break;
      this.checkpoints.splice(index, 1);
    }
  }

  getCheckpointCount(): number {
    return this.checkpoints.length;
  }

  dispose(): void {
    this.stopPlayback();
    this.cancelWorker();
    this.listeners.clear();
  }

  private cancelWorker(): void {
    this.generation += 1;
    this.inFlight = false;
    this.worker?.terminate();
    this.worker = null;
  }
}
