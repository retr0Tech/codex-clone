/**
 * Docker's stream multiplexing, unpacked incrementally.
 *
 * A non-TTY container's log stream interleaves stdout and stderr in 8-byte
 * framed records:
 *
 *   byte 0    stream type (1 = stdout, 2 = stderr)
 *   bytes 1-3 padding
 *   bytes 4-7 payload length, big endian
 *   bytes 8+  payload
 *
 * dockerode ships `demuxStream`, which pipes into two PassThroughs. We do it by
 * hand because PassThrough defers delivery by a tick, so the source stream's
 * `end` can fire before the last chunk has been handed to the parser -- and the
 * last chunk is the terminal `status` event of the run. Framing here is
 * synchronous, so "the source ended" really does mean "everything is parsed".
 */

export type DockerStreamType = "stdout" | "stderr" | "other";

export interface DockerFrame {
  stream: DockerStreamType;
  data: Buffer;
}

const HEADER_BYTES = 8;

export class FrameDemuxer {
  #buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): DockerFrame[] {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    const frames: DockerFrame[] = [];

    for (;;) {
      if (this.#buffer.length < HEADER_BYTES) break;
      const size = this.#buffer.readUInt32BE(4);
      if (this.#buffer.length < HEADER_BYTES + size) break;

      const type = this.#buffer.readUInt8(0);
      frames.push({
        stream: type === 1 ? "stdout" : type === 2 ? "stderr" : "other",
        data: this.#buffer.subarray(HEADER_BYTES, HEADER_BYTES + size),
      });
      this.#buffer = this.#buffer.subarray(HEADER_BYTES + size);
    }
    return frames;
  }
}
