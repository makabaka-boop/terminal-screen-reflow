# Canvas Terminal Replay

一个纯 TypeScript 的有限终端回放示例：从本地字节轨迹解析 ANSI 输出，在 Canvas 上渲染，不启动 shell、不执行任何真实命令。

## 能力

- Worker 中的字节解析与主线程屏幕模型分离。
- 增量 UTF-8 解码；任意分块边界产生相同事件和屏幕。
- 支持 CR、LF、BS、Tab、常见 CSI 光标移动、清屏/清行和滚动。
- 支持 SGR 基础 16 色、256 色、RGB 前景/背景色。
- CJK/Emoji 宽字符占两列；不会写入半个宽字符，行末自动换到下一行。
- 组合标记附加到原基字符；跨软换行的组合标记仍属于原逻辑单元。
- 改变列数时按逻辑行重排；鼠标选区以稳定 cell id 表示，复制保持原文本身份。
- 最多保留 10,000 条滚动历史物理行。
- 拖拽进度条时从字节/解析器/屏幕三元检查点重建；Worker 请求带代次，旧 Worker 会被终止，迟到响应也会被丢弃。

## 命令

```bash
npm install
npm test
npm run dev
npm run build
```

## 结构

- `src/terminal/utf8.ts`：增量 UTF-8 解码器。
- `src/terminal/parser.ts`：无副作用 ANSI 字节解析器。
- `src/terminal/screen.ts`：物理行、逻辑重排、宽字符、颜色和选择/复制模型。
- `src/terminal/parser.worker.ts`：解析 Worker。
- `src/terminal/replay.ts`：代次、分块请求、检查点和回放控制。
- `src/terminal/renderer.ts`：Canvas 渲染与鼠标选区。
- `test/terminal.test.ts`：跨块 UTF-8、截断转义、宽字符覆盖、重排选择复制、历史上限和代次隔离测试。
