import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SEQ_STRIDE, SeqAllocator, SeqOverflowError, runBase } from "./seq.js";

describe("SeqAllocator", () => {
  it("maps agent seqs onto the stride, leaving the gaps for the host", () => {
    const alloc = new SeqAllocator();
    assert.equal(alloc.ingest(0), SEQ_STRIDE);
    assert.equal(alloc.ingest(1), 2 * SEQ_STRIDE);
    assert.equal(alloc.ingest(2), 3 * SEQ_STRIDE);
  });

  it("gives host events the addresses between agent events", () => {
    const alloc = new SeqAllocator();
    // Before the container has said anything: the pre-run block.
    assert.equal(alloc.host(), 1);
    assert.equal(alloc.host(), 2);

    assert.equal(alloc.ingest(0), SEQ_STRIDE);
    // A diff derived in reaction to that event sorts immediately after it.
    assert.equal(alloc.host(), SEQ_STRIDE + 1);
    assert.equal(alloc.host(), SEQ_STRIDE + 2);
    // ...and still before the agent's next event.
    assert.equal(alloc.ingest(1), 2 * SEQ_STRIDE);
  });

  it("is monotonic across an interleaved stream", () => {
    const alloc = new SeqAllocator();
    const seen: number[] = [alloc.host(), alloc.ingest(0), alloc.host(), alloc.ingest(1), alloc.ingest(2), alloc.host()];
    for (let i = 1; i < seen.length; i += 1) {
      assert.ok(seen[i]! > seen[i - 1]!, `${seen[i]} should follow ${seen[i - 1]}`);
    }
  });

  /**
   * The property the whole design exists for: `attach()` replays the container
   * log from the beginning after a worker restart, so ingesting the same agent
   * event twice must produce the same address both times. Otherwise the second
   * pass writes a duplicate transcript instead of colliding with the first.
   */
  it("is replay-stable: the same agent seqs map to the same addresses", () => {
    const first = new SeqAllocator(128);
    const firstPass = [0, 1, 2, 3].map((s) => first.ingest(s));

    const second = new SeqAllocator(128);
    // A restarted worker re-reads the stream and re-emits its own events in the
    // same positions; the agent addresses must not move.
    second.host();
    const secondPass = [0, 1, 2, 3].map((s) => {
      const stored = second.ingest(s);
      second.host();
      return stored;
    });

    assert.deepEqual(secondPass, firstPass);
  });

  it("starts a run above everything the task has already used", () => {
    const base = runBase(3 * SEQ_STRIDE + 5);
    const alloc = new SeqAllocator(base);
    assert.ok(alloc.ingest(0) > 3 * SEQ_STRIDE + 5);
    assert.equal(base % SEQ_STRIDE, 0);
  });

  it("treats a fresh task as base zero", () => {
    assert.equal(runBase(0), 0);
    assert.equal(runBase(-1), 0);
  });

  it("throws with diagnostics rather than colliding when the gap overflows", () => {
    const alloc = new SeqAllocator();
    alloc.ingest(0);
    assert.throws(
      () => {
        for (let i = 0; i < SEQ_STRIDE; i += 1) alloc.host();
      },
      (err: unknown) => err instanceof SeqOverflowError && /stride of 64/.test((err as Error).message),
    );
  });
});
