import { resolveColor } from './palette';
import type { TerminalScreen } from './screen';
import type { Line } from './types';

export interface RendererOptions {
  fontSize?: number;
  lineHeight?: number;
  background?: string;
  foreground?: string;
  selection?: string;
  cursor?: string;
}

export class CanvasTerminalRenderer {
  readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly screen: TerminalScreen;
  private fontSize: number;
  private lineHeight: number;
  private cellWidth = 0;
  private cellHeight = 0;
  private viewOffset = 0;
  private dragging = false;
  private readonly colors: Required<Omit<RendererOptions, 'fontSize' | 'lineHeight'>>;

  constructor(canvas: HTMLCanvasElement, screen: TerminalScreen, options: RendererOptions = {}) {
    this.canvas = canvas;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D context is unavailable');
    this.context = context;
    this.screen = screen;
    this.fontSize = options.fontSize ?? 15;
    this.lineHeight = options.lineHeight ?? 1.25;
    this.colors = {
      background: options.background ?? '#101216',
      foreground: options.foreground ?? '#e6e6e6',
      selection: options.selection ?? 'rgba(80, 140, 255, 0.35)',
      cursor: options.cursor ?? '#d8d8d8'
    };
    this.measure();
    this.bind();
    this.render();
  }

  private bind(): void {
    this.canvas.addEventListener('mousedown', this.onMouseDown);
    this.canvas.addEventListener('wheel', this.onWheel, { passive: true });
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('mouseup', this.onMouseUp);
  }

  dispose(): void {
    this.canvas.removeEventListener('mousedown', this.onMouseDown);
    this.canvas.removeEventListener('wheel', this.onWheel);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('mouseup', this.onMouseUp);
  }

  resizeCanvas(): void {
    this.measure();
    this.render();
  }

  setFontSize(size: number): void {
    this.fontSize = size;
    this.measure();
    this.render();
  }

  scrollToBottom(): void {
    this.viewOffset = 0;
    this.render();
  }

  scroll(lines: number): void {
    this.viewOffset = Math.max(0, Math.min(this.screen.history.length, this.viewOffset + lines));
    this.render();
  }

  private measure(): void {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    const cssWidth = Math.max(1, rect.width);
    const cssHeight = Math.max(1, rect.height);
    this.canvas.width = Math.round(cssWidth * dpr);
    this.canvas.height = Math.round(cssHeight * dpr);
    this.context.setTransform(dpr, 0, 0, dpr, 0, 0);

    const font = `${this.fontSize}px "Menlo", "Consolas", "Noto Sans Mono CJK SC", "Microsoft YaHei", monospace`;
    this.context.font = font;
    this.cellWidth = Math.ceil(this.context.measureText('M').width);
    this.cellHeight = Math.round(this.fontSize * this.lineHeight);
  }

  render = (): void => {
    const ctx = this.context;
    const rect = this.canvas.getBoundingClientRect();
    ctx.fillStyle = this.colors.background;
    ctx.fillRect(0, 0, rect.width, rect.height);
    ctx.font = `${this.fontSize}px "Menlo", "Consolas", "Noto Sans Mono CJK SC", "Microsoft YaHei", monospace`;
    ctx.textBaseline = 'top';

    const all = [...this.screen.history, ...this.screen.active];
    const bottom = all.length;
    const first = Math.max(0, bottom - this.screen.rows - this.viewOffset);
    for (let row = 0; row < this.screen.rows; row++) {
      const line = all[first + row];
      if (line) this.drawLine(line, row);
    }

    if (this.viewOffset === 0) this.drawCursor();
  };

  private drawLine(line: Line, row: number): void {
    const ctx = this.context;
    const y = row * this.cellHeight + 2;

    for (let x = 0; x < line.slots.length; x++) {
      const slot = line.slots[x];
      if (!slot || slot.continuation) continue;
      const cell = slot.cell;
      const px = x * this.cellWidth;
      const bg = resolveColor(cell.bg, this.colors.background);
      if (bg !== this.colors.background) {
        ctx.fillStyle = bg;
        ctx.fillRect(px, y - 2, this.cellWidth * cell.width, this.cellHeight);
      }
      if (this.screen.isCellSelected(cell.id)) {
        ctx.fillStyle = this.colors.selection;
        ctx.fillRect(px, y - 2, this.cellWidth * cell.width, this.cellHeight);
      }
      ctx.fillStyle = resolveColor(cell.fg, this.colors.foreground);
      ctx.fillText(cell.text, px, y, this.cellWidth * cell.width);
    }
  }

  private drawCursor(): void {
    const ctx = this.context;
    const x = this.screen.cursor.x * this.cellWidth;
    const y = this.screen.cursor.y * this.cellHeight + 2;
    ctx.fillStyle = this.colors.cursor;
    ctx.globalAlpha = 0.7;
    ctx.fillRect(x, y, Math.max(2, this.cellWidth / 8), this.fontSize);
    ctx.globalAlpha = 1;
  }

  private eventToAddress(event: MouseEvent): { physical: number; boundary: number } | null {
    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const row = Math.floor(y / this.cellHeight);
    if (row < 0 || row >= this.screen.rows) return null;
    const all = [...this.screen.history, ...this.screen.active];
    const bottom = all.length;
    const first = Math.max(0, bottom - this.screen.rows - this.viewOffset);
    return { physical: first + row, boundary: x / this.cellWidth };
  }

  private onMouseDown = (event: MouseEvent): void => {
    const point = this.eventToAddress(event);
    if (!point) return;
    event.preventDefault();
    this.dragging = true;
    this.screen.beginSelection(point.physical, point.boundary);
    this.render();
  };

  private onWheel = (event: WheelEvent): void => {
    this.scroll(event.deltaY > 0 ? 3 : -3);
  };

  private onMouseMove = (event: MouseEvent): void => {
    if (!this.dragging) return;
    const point = this.eventToAddress(event);
    if (!point) return;
    this.screen.updateSelection(point.physical, point.boundary);
    this.render();
  };

  private onMouseUp = (): void => {
    if (!this.dragging) return;
    this.dragging = false;
    const text = this.screen.selectedText();
    if (text && navigator.clipboard) void navigator.clipboard.writeText(text).catch(() => undefined);
  };
}
