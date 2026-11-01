/**
 * A command's output for the agent: the start and the end, with a note of what
 * is cut from the middle. A chatty command can't grow the daemon's memory.
 *
 * @module myComputer/outputCollector
 */

export const OUTPUT_LIMIT_BYTES = 64 * 1024;

export interface CollectedOutput {
  readonly text: string;
  /** Bytes left out of the middle; 0 when the whole output is in `text`. */
  readonly cutBytes: number;
}

export class OutputCollector {
  private readonly headLimit: number;
  private readonly tailLimit: number;
  private head: Buffer = Buffer.alloc(0);
  private tail: Buffer = Buffer.alloc(0);
  private total = 0;

  constructor(limit: number = OUTPUT_LIMIT_BYTES) {
    this.headLimit = Math.floor(limit / 2);
    this.tailLimit = limit - this.headLimit;
  }

  push(chunk: Uint8Array): void {
    this.total += chunk.length;
    const room = this.headLimit - this.head.length;
    const toHead = Math.min(room, chunk.length);
    if (toHead > 0) this.head = Buffer.concat([this.head, chunk.subarray(0, toHead)]);
    if (toHead < chunk.length) {
      const joined = Buffer.concat([this.tail, chunk.subarray(toHead)]);
      this.tail = joined.subarray(Math.max(0, joined.length - this.tailLimit));
    }
  }

  result(): CollectedOutput {
    const cutBytes = this.total - this.head.length - this.tail.length;
    const head = this.head.toString("utf8");
    const tail = this.tail.toString("utf8");
    if (cutBytes <= 0) return { text: `${head}${tail}`, cutBytes: 0 };
    return {
      text: `${head}\n\n[… ${cutBytes} bytes of output cut from the middle …]\n\n${tail}`,
      cutBytes,
    };
  }
}
