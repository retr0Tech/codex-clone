import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FrameDemuxer } from "./demux.js";

function frame(type: 1 | 2, payload: string): Buffer {
  const data = Buffer.from(payload, "utf8");
  const header = Buffer.alloc(8);
  header.writeUInt8(type, 0);
  header.writeUInt32BE(data.length, 4);
  return Buffer.concat([header, data]);
}

describe("FrameDemuxer", () => {
  it("separates stdout from stderr", () => {
    const out = new FrameDemuxer().push(Buffer.concat([frame(1, "event\n"), frame(2, "warning\n")]));
    assert.deepEqual(
      out.map((f) => [f.stream, f.data.toString()]),
      [
        ["stdout", "event\n"],
        ["stderr", "warning\n"],
      ],
    );
  });

  it("holds a frame back until its payload has fully arrived", () => {
    const demuxer = new FrameDemuxer();
    const whole = frame(1, "hello world");
    assert.deepEqual(demuxer.push(whole.subarray(0, 12)), [], "a partial payload must not be emitted");
    const out = demuxer.push(whole.subarray(12));
    assert.equal(out[0]?.data.toString(), "hello world");
  });

  it("holds back a header split across chunks", () => {
    const demuxer = new FrameDemuxer();
    const whole = frame(1, "x");
    assert.deepEqual(demuxer.push(whole.subarray(0, 3)), []);
    assert.deepEqual(demuxer.push(whole.subarray(3, 6)), []);
    const out = demuxer.push(whole.subarray(6));
    assert.equal(out[0]?.data.toString(), "x");
  });

  it("emits every frame packed into one chunk", () => {
    const chunk = Buffer.concat([frame(1, "a"), frame(1, "b"), frame(2, "c"), frame(1, "d")]);
    assert.equal(new FrameDemuxer().push(chunk).length, 4);
  });

  it("never splits a multibyte character across the frame boundary it reports", () => {
    // The demuxer returns raw bytes; it is the NDJSON parser that decodes.
    // What matters here is that the byte count is honoured exactly.
    const out = new FrameDemuxer().push(frame(1, "héllo — ünïcode"));
    assert.equal(out[0]?.data.toString("utf8"), "héllo — ünïcode");
  });
});
