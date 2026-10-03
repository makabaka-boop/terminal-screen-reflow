import { CanvasTerminalRenderer } from './terminal/renderer';
import { TerminalReplay } from './terminal/replay';

const canvas = document.querySelector<HTMLCanvasElement>('#terminal');
const slider = document.querySelector<HTMLInputElement>('#position');
const playButton = document.querySelector<HTMLButtonElement>('#play');
const fileInput = document.querySelector<HTMLInputElement>('#trace');
const colsInput = document.querySelector<HTMLInputElement>('#cols');
if (!canvas || !slider || !playButton || !fileInput || !colsInput) throw new Error('missing terminal UI');

const replay = new TerminalReplay({
  cols: 80,
  rows: 24,
  workerFactory: () => new Worker(new URL('./terminal/parser.worker.ts', import.meta.url), { type: 'module' }),
  checkpointEvery: 256,
  chunkSize: 256
});
const renderer = new CanvasTerminalRenderer(canvas, replay.screen);

const sample = new TextEncoder().encode(
  [
    '\x1b[32mhello CJK\x1b[0m 你好，世界 あ',
    '组合: é wide overwrite: 中X',
    '\x1b[48;2;40;60;90mtrue color background\x1b[0m',
    'line 4\rline 5\x1b[H overwrite',
    ...Array.from({ length: 30 }, (_, i) => `history ${i}`)
  ].join('\n')
);
replay.setTrace(sample);
slider.max = String(replay.duration);
replay.seek(replay.duration);

replay.subscribe(() => {
  slider.max = String(replay.duration);
  slider.value = String(replay.getPosition());
  renderer.render();
});

slider.addEventListener('input', () => replay.seek(Number(slider.value)));
playButton.addEventListener('click', () => {
  if (replay.isPlaying) replay.pause();
  else replay.play();
});

fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  const bytes = new Uint8Array(await file.arrayBuffer());
  replay.setTrace(bytes);
  replay.seek(bytes.length);
});

colsInput.addEventListener('change', () => {
  const cols = Number.parseInt(colsInput.value, 10);
  if (Number.isInteger(cols)) replay.resize(cols, replay.screen.rows);
});

new ResizeObserver(() => renderer.resizeCanvas()).observe(canvas);
