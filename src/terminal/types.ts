export type RGB = [number, number, number];
export type Color =
  | { kind: 'default' }
  | { kind: 'palette'; index: number }
  | { kind: 'rgb'; value: RGB };

export const defaultColor = (): Color => ({ kind: 'default' });
export const paletteColor = (index: number): Color => ({ kind: 'palette', index });
export const rgbColor = (value: RGB): Color => ({ kind: 'rgb', value });

export interface Cell {
  /** Stable identity of the original character, retained through wrapping/resizing. */
  id: number;
  /** Base code point followed by zero or more combining marks. */
  text: string;
  width: 1 | 2;
  fg: Color;
  bg: Color;
}

/** A physical terminal column. Continuation cells reference the preceding wide cell. */
export interface Slot {
  cell: Cell;
  continuation?: boolean;
}

export interface Line {
  slots: Array<Slot | undefined>;
  /** True when this physical line is joined to the next by a soft wrap. */
  wrapped: boolean;
}

export interface CursorState {
  x: number;
  y: number;
  fg: Color;
  bg: Color;
  saved: SavedCursor | null;
}

export interface SavedCursor {
  x: number;
  y: number;
  fg: Color;
  bg: Color;
}

export interface CellAddress {
  id: number;
  side: 'start' | 'end';
}

export interface SelectionState {
  anchor: CellAddress;
  focus: CellAddress;
}

export interface ScreenSnapshot {
  version: 1;
  history: Line[];
  active: Line[];
  cursor: CursorState;
  tabStops: boolean[];
  nextId: number;
  cols: number;
  rows: number;
  pendingWrap: boolean;
}

export type PrintEvent = { type: 'print'; text: string };
export type CursorUpEvent = { type: 'cursorUp'; amount: number };
export type CursorDownEvent = { type: 'cursorDown'; amount: number };
export type CursorForwardEvent = { type: 'cursorForward'; amount: number };
export type CursorBackEvent = { type: 'cursorBack'; amount: number };
export type CursorPositionEvent = { type: 'cursorPosition'; row?: number; col?: number };
export type EraseLineEvent = { type: 'eraseLine'; mode: 0 | 1 | 2 };
export type EraseDisplayEvent = { type: 'eraseDisplay'; mode: 0 | 1 | 2 | 3 };
export type ScrollEvent = { type: 'scroll'; amount: number };
export type ReverseIndexEvent = { type: 'reverseIndex' };
export type SgrEvent = { type: 'sgr'; params: number[] };
export type SimpleEvent =
  | { type: 'lineFeed' }
  | { type: 'carriageReturn' }
  | { type: 'backspace' }
  | { type: 'tab' }
  | { type: 'saveCursor' }
  | { type: 'restoreCursor' };

export type TerminalEvent =
  | PrintEvent
  | SimpleEvent
  | CursorUpEvent
  | CursorDownEvent
  | CursorForwardEvent
  | CursorBackEvent
  | CursorPositionEvent
  | EraseLineEvent
  | EraseDisplayEvent
  | ScrollEvent
  | ReverseIndexEvent
  | SgrEvent;

export type ParserMode = 'normal' | 'escape' | 'csi' | 'osc';

export interface ParserState {
  mode: ParserMode;
  utf8Bytes: number[];
  escapeBuffer: string;
  privateMarker: boolean;
  /** OSC is conventionally terminated by ST (ESC \), BEL, or end-of-input handling. */
  oscTerminator: 'st' | 'bel';
}

export interface Checkpoint<T> {
  offset: number;
  parser: ParserState;
  screen: T;
}

export interface EventsBlock {
  type: 'events';
  generation: number;
  start: number;
  end: number;
  events: TerminalEvent[];
  checkpoints: Array<{ offset: number; parser: ParserState; eventCount: number }>;
}

export interface ParseRequest {
  type: 'parse';
  generation: number;
  bytes: Uint8Array;
  start: number;
  state: ParserState | null;
  checkpointEvery: number;
}

export type WorkerRequest =
  | ParseRequest
  | { type: 'shutdown' };

export type WorkerResponse =
  | EventsBlock
  | { type: 'idle'; generation: number }
  | { type: 'error'; generation: number; message: string };
