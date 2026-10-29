import fs from "node:fs";
import path from "node:path";

export interface RotatingFileSinkOptions {
  readonly filePath: string;
  readonly maxBytes: number;
  readonly maxFiles: number;
  readonly throwOnError?: boolean;
}

export class RotatingFileSink {
  private readonly filePath: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private readonly throwOnError: boolean;
  private currentSize = 0;

  constructor(options: RotatingFileSinkOptions) {
    if (options.maxBytes < 1) {
      throw new Error(`maxBytes must be >= 1 (received ${options.maxBytes})`);
    }
    if (options.maxFiles < 1) {
      throw new Error(`maxFiles must be >= 1 (received ${options.maxFiles})`);
    }

    this.filePath = options.filePath;
    this.maxBytes = options.maxBytes;
    this.maxFiles = options.maxFiles;
    this.throwOnError = options.throwOnError ?? false;

    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.pruneOverflowBackups();
    this.currentSize = this.readCurrentSize();
  }

  write(chunk: string | Buffer): void {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    if (buffer.length === 0) return;

    try {
      if (this.currentSize > 0 && this.currentSize + buffer.length > this.maxBytes) {
        this.rotate();
      }

      fs.appendFileSync(this.filePath, buffer);
      this.currentSize += buffer.length;

      if (this.currentSize > this.maxBytes) {
        this.rotate();
      }
    } catch {
      this.currentSize = this.readCurrentSize();
      if (this.throwOnError) {
        throw new Error(`Failed to write log chunk to ${this.filePath}`);
      }
    }
  }

  private rotate(): void {
    try {
      const oldest = this.withSuffix(this.maxFiles);
      if (fs.existsSync(oldest)) {
        fs.rmSync(oldest, { force: true });
      }

      for (let index = this.maxFiles - 1; index >= 1; index -= 1) {
        const source = this.withSuffix(index);
        const target = this.withSuffix(index + 1);
        if (fs.existsSync(source)) {
          fs.renameSync(source, target);
        }
      }

      if (fs.existsSync(this.filePath)) {
        fs.renameSync(this.filePath, this.withSuffix(1));
      }

      this.currentSize = 0;
    } catch {
      this.currentSize = this.readCurrentSize();
      if (this.throwOnError) {
        throw new Error(`Failed to rotate log file ${this.filePath}`);
      }
    }
  }

  private pruneOverflowBackups(): void {
    try {
      const dir = path.dirname(this.filePath);
      const baseName = path.basename(this.filePath);
      for (const entry of fs.readdirSync(dir)) {
        if (!entry.startsWith(`${baseName}.`)) continue;
        const suffix = Number(entry.slice(baseName.length + 1));
        if (!Number.isInteger(suffix) || suffix <= this.maxFiles) continue;
        fs.rmSync(path.join(dir, entry), { force: true });
      }
    } catch {
      if (this.throwOnError) {
        throw new Error(`Failed to prune log backups for ${this.filePath}`);
      }
    }
  }

  private readCurrentSize(): number {
    try {
      return fs.statSync(this.filePath).size;
    } catch {
      return 0;
    }
  }

  private withSuffix(index: number): string {
    return `${this.filePath}.${index}`;
  }
}

/**
 * Rotating append-only file whose writes and rotations run on the libuv thread
 * pool instead of the event loop. Writes are serialized; each `write` resolves
 * once the chunk is on disk and rejects if the disk refuses it (ENOSPC, EACCES,
 * EIO), so the caller decides whether to drop. Upstream t3code 4befc863f5
 * (`makeAsyncRotatingFileSink`), written on node:fs/promises so the trace sink
 * stays free of Effect service requirements.
 */
export class AsyncRotatingFileSink {
  private readonly filePath: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private currentSize: number;
  private tail: Promise<void> = Promise.resolve();

  constructor(options: Omit<RotatingFileSinkOptions, "throwOnError">) {
    if (options.maxBytes < 1) {
      throw new Error(`maxBytes must be >= 1 (received ${options.maxBytes})`);
    }
    if (options.maxFiles < 1) {
      throw new Error(`maxFiles must be >= 1 (received ${options.maxFiles})`);
    }
    this.filePath = options.filePath;
    this.maxBytes = options.maxBytes;
    this.maxFiles = options.maxFiles;
    // One-time setup at startup stays synchronous, like RotatingFileSink.
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    try {
      const dir = path.dirname(this.filePath);
      const baseName = path.basename(this.filePath);
      for (const entry of fs.readdirSync(dir)) {
        if (!entry.startsWith(`${baseName}.`)) continue;
        const suffix = Number(entry.slice(baseName.length + 1));
        if (!Number.isInteger(suffix) || suffix <= this.maxFiles) continue;
        fs.rmSync(path.join(dir, entry), { force: true });
      }
    } catch {
      // Pruning is best effort.
    }
    this.currentSize = this.statSizeSync();
  }

  write(chunk: string | Buffer): Promise<void> {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    if (buffer.length === 0) return this.tail;
    const next = this.tail.then(async () => {
      try {
        if (this.currentSize > 0 && this.currentSize + buffer.length > this.maxBytes) {
          await this.rotate();
        }
        await fs.promises.appendFile(this.filePath, buffer);
        this.currentSize += buffer.length;
      } catch (cause) {
        this.currentSize = await this.statSize();
        throw cause;
      }
    });
    // Later writes queue behind this one whether it succeeds or not.
    this.tail = next.catch(() => undefined);
    return next;
  }

  /** Resolves once every write queued so far has settled. */
  drain(): Promise<void> {
    return this.tail;
  }

  private async rotate(): Promise<void> {
    await fs.promises.rm(`${this.filePath}.${this.maxFiles}`, { force: true });
    for (let index = this.maxFiles - 1; index >= 1; index -= 1) {
      await fs.promises
        .rename(`${this.filePath}.${index}`, `${this.filePath}.${index + 1}`)
        .catch((cause: NodeJS.ErrnoException) => {
          if (cause.code !== "ENOENT") throw cause;
        });
    }
    await fs.promises
      .rename(this.filePath, `${this.filePath}.1`)
      .catch((cause: NodeJS.ErrnoException) => {
        if (cause.code !== "ENOENT") throw cause;
      });
    this.currentSize = 0;
  }

  private statSizeSync(): number {
    try {
      return fs.statSync(this.filePath).size;
    } catch {
      return 0;
    }
  }

  private async statSize(): Promise<number> {
    try {
      return (await fs.promises.stat(this.filePath)).size;
    } catch {
      return 0;
    }
  }
}
