import {
  defaultColor,
  paletteColor,
  rgbColor,
  type Cell,
  type CellAddress,
  type Color,
  type CursorState,
  type Line,
  type ScreenSnapshot,
  type SelectionState,
  type Slot,
  type TerminalEvent
} from './types';
import { isGraphemeExtend, splitGraphemes } from './width';

const MAX_HISTORY_LINES = 10_000;
const DEFAULT_FG = paletteColor(7);

function blankLine(cols: number): Line {
  return { slots: new Array<Slot | undefined>(cols), wrapped: false };
}

export class TerminalScreen {
  cols: number;
  rows: number;
  history: Line[] = [];
  active: Line[] = [];
  cursor: CursorState;
  nextId = 1;
  pendingWrap = false;
  tabStops: boolean[] = [];
  selection: SelectionState | null = null;

  constructor(cols: number, rows: number) {
    if (cols < 2 || rows < 1) throw new Error('terminal dimensions must be positive');
    this.cols = cols;
    this.rows = rows;
    this.active = Array.from({ length: rows }, () => blankLine(cols));
    this.cursor = this.initialCursor();
    this.resetTabStops();
  }

  private initialCursor(): CursorState {
    return {
      x: 0,
      y: 0,
      fg: DEFAULT_FG,
      bg: defaultColor(),
      saved: null
    };
  }

  resetTabStops(): void {
    this.tabStops = new Array<boolean>(this.cols).fill(false);
    for (let x = 8; x < this.cols; x += 8) this.tabStops[x] = true;
  }

  reset(): void {
    this.history = [];
    this.active = Array.from({ length: this.rows }, () => blankLine(this.cols));
    this.cursor = this.initialCursor();
    this.nextId = 1;
    this.pendingWrap = false;
    this.selection = null;
    this.resetTabStops();
  }

  apply(events: readonly TerminalEvent[]): void {
    for (const event of events) this.applyOne(event);
  }

  private applyOne(event: TerminalEvent): void {
    switch (event.type) {
      case 'print':
        this.print(event.text);
        break;
      case 'lineFeed':
        this.lineFeed();
        break;
      case 'carriageReturn':
        this.pendingWrap = false;
        this.cursor.x = 0;
        break;
      case 'backspace':
        this.pendingWrap = false;
        this.cursor.x = Math.max(0, this.cursor.x - 1);
        break;
      case 'tab':
        this.pendingWrap = false;
        this.advanceToTab();
        break;
      case 'cursorUp':
        this.pendingWrap = false;
        this.moveCursor(0, -event.amount);
        break;
      case 'cursorDown':
        this.pendingWrap = false;
        this.moveCursor(0, event.amount);
        break;
      case 'cursorForward':
        this.pendingWrap = false;
        this.moveCursor(event.amount, 0);
        break;
      case 'cursorBack':
        this.pendingWrap = false;
        this.moveCursor(-event.amount, 0);
        break;
      case 'cursorPosition':
        this.pendingWrap = false;
        this.setCursorPosition(event.row, event.col);
        break;
      case 'eraseLine':
        this.eraseLine(event.mode);
        break;
      case 'eraseDisplay':
        this.eraseDisplay(event.mode);
        break;
      case 'scroll':
        this.scrollUp(event.amount);
        break;
      case 'reverseIndex':
        this.reverseIndex();
        break;
      case 'sgr':
        this.applySgr(event.params);
        break;
      case 'saveCursor':
        this.cursor.saved = { x: this.cursor.x, y: this.cursor.y, fg: this.cursor.fg, bg: this.cursor.bg };
        break;
      case 'restoreCursor':
        if (this.cursor.saved) {
          this.cursor.x = this.cursor.saved.x;
          this.cursor.y = this.cursor.saved.y;
          this.cursor.fg = this.cursor.saved.fg;
          this.cursor.bg = this.cursor.saved.bg;
          this.pendingWrap = false;
        }
        break;
    }
  }

  private print(text: string): void {
    for (const grapheme of splitGraphemes(text)) this.writeGrapheme(grapheme.text, grapheme.width);
  }

  private writeGrapheme(text: string, width: 1 | 2): void {
    const firstCodePoint = text.codePointAt(0)!;

    if (isGraphemeExtend(firstCodePoint)) {
      this.appendCombiningMark(text);
      return;
    }

    if (this.pendingWrap) this.softNewLine();

    if (width === 2 && this.cursor.x === this.cols - 1) {
      // Never leave only the continuation half of a wide character on a row.
      this.pendingWrap = true;
      this.softNewLine();
    }

    this.clearTargetForWrite(width);
    const cell: Cell = {
      id: this.nextId++,
      text,
      width,
      fg: this.cursor.fg,
      bg: this.cursor.bg
    };
    const line = this.active[this.cursor.y]!;
    line.slots[this.cursor.x] = { cell };
    if (width === 2) {
      if (this.cursor.x + 1 < this.cols) {
        line.slots[this.cursor.x + 1] = { cell, continuation: true };
        this.cursor.x += 2;
      } else {
        // Kept unreachable in the current write rules; defensive placement.
        this.cursor.x += 1;
      }
    } else {
      this.cursor.x += 1;
    }

    if (this.cursor.x >= this.cols) {
      this.cursor.x = this.cols;
      this.pendingWrap = true;
    }
  }

  private appendCombiningMark(mark: string): void {
    const line = this.active[this.cursor.y]!;
    let x = this.cursor.x - 1;
    let slot = line.slots[x];
    if (slot?.continuation) {
      x -= 1;
      slot = line.slots[x];
    }
    if (slot && !slot.continuation) {
      slot.cell.text += mark;
      return;
    }

    // A combining mark at the start of a row belongs to the last cell of the
    // soft-wrapped preceding physical row.
    if (this.cursor.x === 0 && this.cursor.y > 0) {
      const previous = this.active[this.cursor.y - 1]!;
      if (previous.wrapped) {
        for (let px = this.cols - 1; px >= 0; px--) {
          const candidate = previous.slots[px];
          if (candidate && !candidate.continuation) {
            candidate.cell.text += mark;
            return;
          }
        }
      }
    }

    // A genuinely isolated combining mark remains visible/copyable in one cell.
    const cell: Cell = {
      id: this.nextId++,
      text: `◌${mark}`,
      width: 1,
      fg: this.cursor.fg,
      bg: this.cursor.bg
    };
    line.slots[Math.max(0, this.cursor.x)] = { cell };
  }

  /**
   * Remove whatever a new grapheme will cover. If the cursor lands on the
   * second half of a wide cell, both halves of the old cell are removed.
   */
  private clearTargetForWrite(width: 1 | 2): void {
    const line = this.active[this.cursor.y]!;
    const at = line.slots[this.cursor.x];
    if (at?.continuation) {
      const old = at.cell;
      for (let x = Math.max(0, this.cursor.x - 1); x <= Math.min(this.cols - 1, this.cursor.x + 1); x++) {
        if (line.slots[x]?.cell === old) line.slots[x] = undefined;
      }
    }

    const covered = width === 2 ? [this.cursor.x, this.cursor.x + 1] : [this.cursor.x];
    for (const x of covered) {
      const slot = line.slots[x];
      if (!slot) continue;
      const old = slot.cell;
      for (let sx = 0; sx < this.cols; sx++) {
        if (line.slots[sx]?.cell === old) line.slots[sx] = undefined;
      }
    }
  }

  private softNewLine(): void {
    const line = this.active[this.cursor.y]!;
    line.wrapped = true;
    this.cursor.x = 0;
    if (this.cursor.y === this.rows - 1) {
      this.history.push(this.active.shift()!);
      this.active.push(blankLine(this.cols));
      this.trimHistory();
    } else {
      this.cursor.y += 1;
    }
    this.pendingWrap = false;
  }

  private lineFeed(): void {
    this.pendingWrap = false;
    if (this.cursor.y < this.rows - 1) {
      this.cursor.y += 1;
    } else {
      this.history.push(this.active.shift()!);
      this.active.push(blankLine(this.cols));
      this.trimHistory();
    }
  }

  private trimHistory(): void {
    while (this.history.length > MAX_HISTORY_LINES) this.history.shift();
    if (this.history[0]?.wrapped) this.history[0]!.wrapped = false;
  }

  private moveCursor(dx: number, dy: number): void {
    this.cursor.x = Math.max(0, Math.min(this.cols - 1, this.cursor.x + dx));
    if (dy !== 0) {
      if (dy < 0 && this.cursor.y < -dy && this.history.length > 0) {
        // Cursor navigation does not normally pull history back. Keep within
        // the visible viewport, matching a finite screen emulator.
        this.cursor.y = 0;
      } else {
        this.cursor.y = Math.max(0, Math.min(this.rows - 1, this.cursor.y + dy));
      }
    }
  }

  private setCursorPosition(row: number | undefined, col: number | undefined): void {
    this.cursor.y = clamp((row ?? 1) - 1, 0, this.rows - 1);
    this.cursor.x = clamp((col ?? 1) - 1, 0, this.cols - 1);
  }

  private advanceToTab(): void {
    let next = -1;
    for (let x = this.cursor.x + 1; x < this.cols; x++) {
      if (this.tabStops[x]) {
        next = x;
        break;
      }
    }
    this.cursor.x = next === -1 ? this.cols - 1 : next;
  }

  private eraseLine(mode: 0 | 1 | 2): void {
    const line = this.active[this.cursor.y]!;
    const ranges: Array<[number, number]> =
      mode === 0 ? [[this.cursor.x, this.cols - 1]] : mode === 1 ? [[0, this.cursor.x]] : [[0, this.cols - 1]];
    for (const [start, end] of ranges) this.clearRange(line, start, end);
    if (mode === 2) line.wrapped = false;
  }

  private eraseDisplay(mode: 0 | 1 | 2 | 3): void {
    if (mode === 3) {
      this.history = [];
      return;
    }
    if (mode === 0) {
      this.clearRange(this.active[this.cursor.y]!, this.cursor.x, this.cols - 1);
      for (let y = this.cursor.y + 1; y < this.rows; y++) {
        this.clearRange(this.active[y]!, 0, this.cols - 1);
        this.active[y]!.wrapped = false;
      }
    } else if (mode === 1) {
      for (let y = 0; y <= this.cursor.y; y++) this.clearRange(this.active[y]!, 0, this.cursor.x);
    } else {
      for (const line of this.active) {
        this.clearRange(line, 0, this.cols - 1);
        line.wrapped = false;
      }
      this.cursor.x = 0;
      this.cursor.y = 0;
      this.pendingWrap = false;
    }
  }

  private clearRange(line: Line, start: number, end: number): void {
    for (let x = Math.max(0, start); x <= Math.min(this.cols - 1, end); x++) {
      const slot = line.slots[x];
      if (!slot) continue;
      const cell = slot.cell;
      for (let sx = 0; sx < this.cols; sx++) {
        if (line.slots[sx]?.cell === cell) line.slots[sx] = undefined;
      }
    }
  }

  private scrollUp(amount: number): void {
    for (let i = 0; i < amount; i++) {
      this.history.push(this.active.shift()!);
      this.active.push(blankLine(this.cols));
    }
    this.trimHistory();
  }

  private reverseIndex(): void {
    this.pendingWrap = false;
    if (this.cursor.y > 0) this.cursor.y -= 1;
    else {
      this.active.pop();
      this.active.unshift(blankLine(this.cols));
    }
  }

  private applySgr(params: readonly number[]): void {
    for (let i = 0; i < params.length; i++) {
      const p = params[i]!;
      if (p === 0) {
        this.cursor.fg = DEFAULT_FG;
        this.cursor.bg = defaultColor();
      } else if (p === 39) {
        this.cursor.fg = DEFAULT_FG;
      } else if (p === 49) {
        this.cursor.bg = defaultColor();
      } else if ((p >= 30 && p <= 37) || (p >= 90 && p <= 97)) {
        this.cursor.fg = paletteColor(p >= 90 ? p - 90 + 8 : p - 30);
      } else if ((p >= 40 && p <= 47) || (p >= 100 && p <= 107)) {
        this.cursor.bg = paletteColor(p >= 100 ? p - 100 + 8 : p - 40);
      } else if (p === 38 || p === 48) {
        const target: 'fg' | 'bg' = p === 38 ? 'fg' : 'bg';
        const consumed = this.applyExtendedColor(params, i, target);
        i += consumed;
      }
    }
  }

  private applyExtendedColor(params: readonly number[], index: number, target: 'fg' | 'bg'): number {
    const mode = params[index + 1];
    if (mode === 5) {
      const colorIndex = params[index + 2];
      if (colorIndex !== undefined && Number.isInteger(colorIndex)) {
        this.cursor[target] = paletteColor(clamp(colorIndex, 0, 255));
        return 2;
      }
      return 1;
    }
    if (mode === 2) {
      const rgb = params.slice(index + 2, index + 5);
      if (rgb.length === 3 && rgb.every(v => Number.isInteger(v))) {
        this.cursor[target] = rgbColor(rgb.map(v => clamp(v, 0, 255)) as [number, number, number]);
        return 4;
      }
    }
    return 1;
  }

  resize(cols: number, rows: number): void {
    if (cols === this.cols && rows === this.rows) return;
    const oldHistory = this.history;
    const oldActive = this.active;
    const oldCols = this.cols;
    const target = this.resolveCursorLogicalPosition(oldHistory, oldActive, oldCols);
    const groups = buildLogicalGroups(oldHistory, oldActive);
    const renderedGroups = groups.map(group => renderGroup(group, cols));
    const physical = renderedGroups.flat();

    if (physical.length <= rows) {
      this.history = [];
      this.active = [...physical];
      while (this.active.length < rows) this.active.push(blankLine(cols));
    } else {
      this.history = physical.slice(0, physical.length - rows);
      this.active = physical.slice(physical.length - rows);
      while (this.history.length > MAX_HISTORY_LINES) this.history.shift();
      if (this.history[0]) this.history[0].wrapped = false;
    }

    this.cols = cols;
    this.rows = rows;
    this.resetTabStops();
    this.placeCursorLogical(renderedGroups, target);
  }

  private resolveCursorLogicalPosition(history: Line[], active: Line[], cols: number): { group: number; cell: number } {
    const all = [...history, ...active];
    const targetY = history.length + this.cursor.y;
    let group = 0;
    let cell = 0;

    for (let y = 0; y < all.length; y++) {
      const line = all[y]!;
      if (y === targetY) {
        for (let x = 0; x < this.cursor.x && x < cols; x++) {
          const slot = line.slots[x];
          if (slot && !slot.continuation) cell += 1;
        }
        return { group, cell };
      }

      cell += countBases(line);
      if (!line.wrapped) {
        group += 1;
        cell = 0;
      }
    }
    return { group, cell };
  }

  private placeCursorLogical(renderedGroups: Line[][], target: { group: number; cell: number }): void {
    let absoluteLine = 0;
    this.pendingWrap = false;

    for (let g = 0; g < renderedGroups.length; g++) {
      const lines = renderedGroups[g]!;
      const groupStartLine = absoluteLine;
      let consumed = 0;
      for (const line of lines) {
        const bases: Array<{ x: number; width: number }> = [];
        for (let x = 0; x < this.cols; x++) {
          const slot = line.slots[x];
          if (slot && !slot.continuation) bases.push({ x, width: slot.cell.width });
        }

        if (g === target.group) {
          const isLastLineOfGroup = absoluteLine - groupStartLine === lines.length - 1;
          const atLineStart = target.cell === consumed;
          const insideLine = atLineStart && consumed > 0 && !isLastLineOfGroup;
          if (!insideLine && target.cell >= consumed && target.cell < consumed + bases.length) {
            const within = target.cell - consumed;
            this.setPhysicalCursor(absoluteLine, bases[within]!.x);
            return;
          }
          if (isLastLineOfGroup && target.cell === consumed + bases.length) {
            const last = bases[bases.length - 1];
            const x = last ? last.x + last.width : 0;
            this.setPhysicalCursor(absoluteLine, x);
            if (x >= this.cols) this.pendingWrap = true;
            return;
          }
        }

        consumed += bases.length;
        absoluteLine += 1;
      }
      // A hard boundary lives at column zero of the first line of the next group.
      if (g + 1 === target.group && target.cell === 0 && renderedGroups[g + 1]) {
        this.setPhysicalCursor(absoluteLine, 0);
        return;
      }
    }

    this.cursor.x = 0;
    this.cursor.y = 0;
  }

  private setPhysicalCursor(absoluteLine: number, x: number): void {
    const visibleIndex = absoluteLine - this.history.length;
    this.cursor.y = Math.max(0, Math.min(this.rows - 1, visibleIndex));
    this.cursor.x = Math.max(0, Math.min(this.cols, x));
  }

  /** Stable cell address used by mouse selection. `boundary` may be fractional. */
  addressAtPhysical(historyOffset: number, boundary: number): CellAddress | null {
    const lines = this.physicalLines();
    const line = lines[historyOffset];
    if (!line) return null;
    const clamped = Math.max(0, Math.min(this.cols, boundary));
    const before = Math.min(this.cols - 1, Math.floor(clamped));
    const after = Math.max(0, Math.ceil(clamped));
    const slotBefore = line.slots[before];
    const slotAfter = line.slots[after];

    if (slotBefore && !slotBefore.continuation && boundary <= before + slotBefore.cell.width) {
      const width = slotBefore.cell.width;
      const inside = boundary - before;
      return { id: slotBefore.cell.id, side: inside <= width / 2 ? 'start' : 'end' };
    }
    if (slotAfter && !slotAfter.continuation) {
      return { id: slotAfter.cell.id, side: 'start' };
    }

    // A boundary on the continuation half of a wide cell snaps to its nearest edge.
    const continued = (slotBefore ?? slotAfter);
    if (continued?.continuation) {
      const startX = findCellStart(line, continued.cell.id);
      const relative = clamped - startX;
      return { id: continued.cell.id, side: relative <= 1 ? 'start' : 'end' };
    }

    for (let px = before - 1; px >= 0; px--) {
      const candidate = line.slots[px];
      if (candidate && !candidate.continuation) return { id: candidate.cell.id, side: 'end' };
    }
    return null;
  }

  beginSelection(historyOffset: number, boundary: number): CellAddress | null {
    const address = this.addressAtPhysical(historyOffset, boundary);
    if (!address) return null;
    this.selection = { anchor: address, focus: address };
    return address;
  }

  updateSelection(historyOffset: number, boundary: number): void {
    if (!this.selection) return;
    const address = this.addressAtPhysical(historyOffset, boundary);
    if (address) this.selection.focus = address;
  }

  clearSelection(): void {
    this.selection = null;
  }

  selectedText(): string {
    if (!this.selection) return '';
    return this.copyRange(this.selection.anchor, this.selection.focus);
  }

  copyRange(start: CellAddress, end: CellAddress): string {
    const sequence = this.logicalTextSequence();
    let left = this.addressToOrdinal(sequence, start);
    let right = this.addressToOrdinal(sequence, end);
    if (left > right) [left, right] = [right, left];

    let output = '';
    for (let i = left; i < right; i++) {
      const item = sequence[i]!;
      if (item.kind === 'cell') output += item.text;
      else if (i >= left && i < right) output += item.break ? '\n' : '';
    }
    return output;
  }

  private physicalLines(): Line[] {
    return [...this.history, ...this.active];
  }

  private logicalTextSequence(): Array<
    | { kind: 'cell'; id: number; text: string; physical: number; x: number }
    | { kind: 'boundary'; break: boolean; physical: number }
  > {
    const lines = this.physicalLines();
    const result: Array<
      | { kind: 'cell'; id: number; text: string; physical: number; x: number }
      | { kind: 'boundary'; break: boolean; physical: number }
    > = [];
    for (let y = 0; y < lines.length; y++) {
      if (y > 0) result.push({ kind: 'boundary', break: !lines[y - 1]!.wrapped, physical: y });
      const line = lines[y]!;
      for (let x = 0; x < line.slots.length; x++) {
        const slot = line.slots[x];
        if (slot && !slot.continuation) {
          result.push({ kind: 'cell', id: slot.cell.id, text: slot.cell.text, physical: y, x });
        }
      }
    }
    return result;
  }

  private addressToOrdinal(
    sequence: Array<
      | { kind: 'cell'; id: number }
      | { kind: 'boundary' }
    >,
    address: CellAddress
  ): number {
    const index = sequence.findIndex(item => item.kind === 'cell' && item.id === address.id);
    if (index === -1) return address.side === 'end' ? sequence.length : 0;
    return address.side === 'start' ? index : index + 1;
  }

  isCellSelected(id: number): boolean {
    if (!this.selection) return false;
    const sequence = this.logicalTextSequence();
    const normalizeAddress = (address: CellAddress) => this.addressToOrdinal(sequence, address);
    let left = normalizeAddress(this.selection.anchor);
    let right = normalizeAddress(this.selection.focus);
    if (left > right) [left, right] = [right, left];
    const ordinal = this.addressToOrdinal(sequence, { id, side: 'start' });
    return ordinal >= left && ordinal < right;
  }

  snapshot(): ScreenSnapshot {
    return {
      version: 1,
      history: cloneLines(this.history),
      active: cloneLines(this.active),
      cursor: cloneCursor(this.cursor),
      tabStops: [...this.tabStops],
      nextId: this.nextId,
      cols: this.cols,
      rows: this.rows,
      pendingWrap: this.pendingWrap
    };
  }

  restore(snapshot: ScreenSnapshot): void {
    this.cols = snapshot.cols;
    this.rows = snapshot.rows;
    this.history = cloneLines(snapshot.history);
    this.active = cloneLines(snapshot.active);
    this.cursor = cloneCursor(snapshot.cursor);
    this.tabStops = [...snapshot.tabStops];
    this.nextId = snapshot.nextId;
    this.pendingWrap = snapshot.pendingWrap;
    this.selection = null;
  }
}

function buildLogicalGroups(history: Line[], active: Line[]): Cell[][] {
  const groups: Cell[][] = [[]];
  for (const line of [...history, ...active]) {
    const group = groups[groups.length - 1]!;
    for (const slot of line.slots) {
      if (slot && !slot.continuation) group.push(slot.cell);
    }
    if (!line.wrapped) groups.push([]);
  }
  if (groups[groups.length - 1]!.length === 0) groups.pop();
  return groups;
}

function renderGroup(group: Cell[], cols: number): Line[] {
  const lines: Line[] = [];
  let current = blankLine(cols);
  let x = 0;

  for (const cell of group) {
    if (x + cell.width > cols) {
      current.wrapped = true;
      lines.push(current);
      current = blankLine(cols);
      x = 0;
    }
    current.slots[x] = { cell };
    if (cell.width === 2) current.slots[x + 1] = { cell, continuation: true };
    x += cell.width;
  }
  lines.push(current);
  return lines;
}

function countBases(line: Line): number {
  let result = 0;
  for (const slot of line.slots) if (slot && !slot.continuation) result += 1;
  return result;
}

function findCellStart(line: Line, id: number): number {
  for (let x = 0; x < line.slots.length; x++) {
    const slot = line.slots[x];
    if (slot && !slot.continuation && slot.cell.id === id) return x;
  }
  return 0;
}

function cloneLines(lines: readonly Line[]): Line[] {
  return lines.map(line => ({
    slots: line.slots.map(slot =>
      slot
        ? {
            continuation: slot.continuation,
            cell: {
              ...slot.cell,
              fg: { ...slot.cell.fg } as Color,
              bg: { ...slot.cell.bg } as Color
            }
          }
        : undefined
    ),
    wrapped: line.wrapped
  }));
}

function cloneCursor(cursor: CursorState): CursorState {
  return {
    x: cursor.x,
    y: cursor.y,
    fg: { ...cursor.fg } as Color,
    bg: { ...cursor.bg } as Color,
    saved: cursor.saved ? { ...cursor.saved, fg: { ...cursor.saved.fg } as Color, bg: { ...cursor.saved.bg } as Color } : null
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
