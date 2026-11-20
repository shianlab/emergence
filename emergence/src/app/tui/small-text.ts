import {
  BoxRenderable,
  ImageRenderable,
  NativeImage,
  TextRenderable,
  rgbToHex,
  parseColor,
  type BoxOptions,
  type CliRenderer,
  type ColorInput,
} from '@opentui/core';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { windowsDesktopEnvironment, windowsPowerShell } from '../../platform/child-environment.ts';

type LabelOptions = BoxOptions & {
  content?: string;
  fg?: ColorInput;
  wrapMode?: 'none' | 'word' | 'char';
  truncate?: boolean;
  selectable?: boolean;
};
type Raster = {
  id: string;
  text: string;
  width: number;
  height: number;
  fontPixels: number;
  foreground: string;
  background: string;
};

/** Sixel encodes bands of six vertical pixels, including the final partial band. */
export function smallTextFitsSixel(y: number, pixelHeight: number, cellHeight: number, rows: number) {
  return y >= 0 && y + Math.max(2, Math.ceil((Math.ceil(pixelHeight / 6) * 6) / cellHeight)) <= rows;
}

/** A native text fallback and a genuine small raster label share one layout slot. */
export class SmallText extends BoxRenderable {
  readonly text: TextRenderable;
  readonly image: ImageRenderable;
  small = true;
  wanted = '';
  private applied = '';
  constructor(
    renderer: CliRenderer,
    options: LabelOptions,
    private readonly owner: SmallTextService,
  ) {
    super(renderer, options);
    this.text = new TextRenderable(renderer, {
      width: '100%',
      content: options.content ?? '',
      fg: options.fg,
      wrapMode: options.wrapMode ?? 'none',
      truncate: options.truncate,
      selectable: options.selectable,
    });
    this.image = new ImageRenderable(renderer, {
      position: 'absolute',
      left: 0,
      top: 0,
      width: '100%',
      height: 1,
      fit: 'fill',
      protocol: 'auto',
      visible: false,
    });
    this.add(this.text);
    this.add(this.image);
    owner.labels.add(this);
  }
  get content() {
    return this.text.content;
  }
  set content(value: TextRenderable['content'] | string) {
    if (typeof value === 'string' && value === this.chunks.map((chunk) => chunk.text).join('')) return;
    this.text.content = value;
    this.reset();
  }
  get chunks() {
    return this.text.chunks;
  }
  get fg() {
    return this.text.fg;
  }
  set fg(value: ColorInput) {
    this.text.fg = value;
  }
  get attributes() {
    return this.text.attributes;
  }
  set attributes(value: number) {
    this.text.attributes = value;
  }
  get virtualLineCount() {
    return this.text.virtualLineCount;
  }
  reset() {
    this.image.visible = false;
    this.text.visible = true;
    this.wanted = '';
  }
  show(key: string, png: Buffer) {
    if (this.isDestroyed || this.wanted !== key) return;
    if (this.applied !== key) {
      const image = NativeImage.decode(png, { owner: this.owner.renderer.nativeScene.resourceContext });
      try {
        this.image.source = image;
        this.applied = key;
      } finally {
        image.dispose();
      }
    }
    this.text.visible = false;
    this.image.visible = true;
  }
  protected override destroySelf() {
    this.owner.labels.delete(this);
    super.destroySelf();
  }
}

/** One hidden raster worker per workspace; no files or UI text are persisted. */
export class SmallTextService {
  readonly labels = new Set<SmallText>();
  private worker?: ChildProcessWithoutNullStreams;
  private pending?: (reply: string) => void;
  private deadline?: ReturnType<typeof setTimeout>;
  private busy = false;
  private failed = false;
  private closed = false;
  private readonly cache = new Map<string, Buffer>();
  private cacheBytes = 0;
  private readonly resized = () => {
    // The frame event runs after presentation. Hide old graphics before the first
    // resized frame, then rebuild them from the new layout on the next frame.
    for (const label of this.labels) label.reset();
  };
  constructor(readonly renderer: CliRenderer) {
    renderer.on('resize', this.resized);
  }
  private stop() {
    this.failed = true;
    this.busy = false;
    this.pending = undefined;
    clearTimeout(this.deadline);
    this.worker?.kill();
    this.worker = undefined;
    this.cache.clear();
    this.cacheBytes = 0;
    for (const label of this.labels) label.reset();
  }
  private start() {
    const script = fileURLToPath(new URL('./small-text.ps1', import.meta.url));
    const worker = spawn(
      windowsPowerShell(),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
      {
        cwd: dirname(script),
        env: windowsDesktopEnvironment(),
        windowsHide: true,
        stdio: 'pipe',
      },
    );
    this.worker = worker;
    const lines = createInterface({ input: worker.stdout });
    lines.on('line', (line) => this.pending?.(line));
    worker.stderr.resume();
    worker.stdin.on('error', () => this.stop());
    worker.on('error', () => this.stop());
    worker.on('exit', () => {
      lines.close();
      if (!this.closed) this.stop();
    });
  }
  sync(background: string) {
    if (this.closed) return;
    const resolution = this.renderer.resolution;
    const usable =
      process.platform === 'win32' &&
      process.env.EMERGENCE_NATIVE_TEXT !== '1' &&
      process.env.NO_COLOR === undefined &&
      process.env.TERM !== 'dumb' &&
      resolution &&
      !this.failed;
    const requests = new Map<string, Raster>();
    for (const label of this.labels) {
      let visible = label.visible;
      for (let parent = label.parent; parent && visible; parent = parent.parent) visible = parent.visible;
      const text = label.chunks.map((chunk) => chunk.text).join('');
      if (
        !usable ||
        !visible ||
        !label.small ||
        label.height !== 1 ||
        !text ||
        label.width < 1 ||
        text.includes('\n') ||
        label.image.effectiveProtocol === 'blocks'
      ) {
        label.reset();
        continue;
      }
      const height = Math.round(resolution.height / this.renderer.terminalHeight);
      const width = Math.round((label.width * resolution.width) / this.renderer.terminalWidth);
      // Bound allocation even for pathological terminal size reports.
      if (height < 8 || height > 128 || width < 1 || width > 8192) {
        label.reset();
        continue;
      }
      if (
        label.image.effectiveProtocol === 'sixel' &&
        !smallTextFitsSixel(
          label.y,
          height,
          resolution.height / this.renderer.terminalHeight,
          this.renderer.terminalHeight,
        )
      ) {
        label.reset();
        continue;
      }
      const value = {
        text: text.slice(0, 4096),
        width,
        height,
        fontPixels: height * 0.8 * 0.875,
        foreground: rgbToHex(parseColor(label.fg)),
        background,
      };
      const key = JSON.stringify(value);
      if (label.wanted !== key) label.reset();
      label.wanted = key;
      const png = this.cache.get(key);
      if (png) {
        try {
          label.show(key, png);
        } catch {
          this.stop();
          return;
        }
      } else requests.set(key, { ...value, id: key });
    }
    if (!requests.size || this.busy || this.failed) return;
    this.busy = true;
    if (!this.worker) this.start();
    const batch = [...requests.values()].slice(0, 64);
    const keys = new Set(batch.map((item) => item.id));
    this.pending = (line) => {
      clearTimeout(this.deadline);
      this.pending = undefined;
      this.busy = false;
      if (this.closed) return;
      try {
        const reply = JSON.parse(line) as { error?: boolean; labels?: { id: string; png: string }[] };
        if (reply.error || !reply.labels || reply.labels.length !== batch.length)
          throw new Error('Raster failed');
        for (const item of reply.labels) {
          if (!keys.has(item.id) || item.png.length > 2_000_000) throw new Error('Invalid raster');
          const png = Buffer.from(item.png, 'base64');
          this.cacheBytes += png.length - (this.cache.get(item.id)?.length ?? 0);
          this.cache.set(item.id, png);
        }
        while (this.cache.size > 128 || this.cacheBytes > 8 * 1024 * 1024) {
          const oldest = this.cache.keys().next().value!;
          this.cacheBytes -= this.cache.get(oldest)!.length;
          this.cache.delete(oldest);
        }
        // Re-check current labels, sizes, state and theme on the next frame, not the stale batch.
        this.renderer.requestRender();
      } catch {
        this.stop();
      }
    };
    this.deadline = setTimeout(() => this.stop(), 10000);
    this.worker?.stdin.write(JSON.stringify({ labels: batch }) + '\n');
  }
  dispose() {
    this.closed = true;
    this.renderer.off('resize', this.resized);
    this.stop();
    this.labels.clear();
  }
}
