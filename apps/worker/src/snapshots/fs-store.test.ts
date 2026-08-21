import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import { after, before, beforeEach, describe, it } from "node:test";
import { FsSnapshotStore, SnapshotError, SnapshotNotFoundError } from "./fs-store.js";

/**
 * The cold store, on its own. No Docker, no Postgres, no network.
 *
 * These run everywhere the suite runs, which matters more here than usual: the
 * reap/wake integration test needs Docker and therefore skips in CI, so this is
 * the part of milestone 8 that CI actually executes.
 */

describe("FsSnapshotStore", () => {
  let root: string;
  let store: FsSnapshotStore;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "codex-snapstore-"));
  });

  beforeEach(() => {
    store = new FsSnapshotStore(join(root, randomBytes(4).toString("hex")));
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const payload = (text: string) => Readable.from([Buffer.from(text, "utf8")]);

  it("round-trips a stream and reports its size and digest", async () => {
    const body = "a tar.zst would go here";
    const meta = await store.put("task_one", payload(body));

    assert.equal(meta.taskId, "task_one");
    assert.equal(meta.sizeBytes, Buffer.byteLength(body));
    assert.equal(meta.digest, `sha256:${createHash("sha256").update(body).digest("hex")}`);
    assert.ok(Date.parse(meta.createdAt) > 0, `createdAt should be an ISO date, got ${meta.createdAt}`);

    const read = await buffer(await store.get("task_one"));
    assert.equal(read.toString("utf8"), body);
  });

  it("hashes the bytes it actually wrote, so a corrupt archive is detectable", async () => {
    const meta = await store.put("task_two", payload("original"));
    // Overwrite the archive behind the store's back, exactly as bit rot or a
    // truncated copy would.
    await writeFile(store.pathFor("task_two"), "tampered");

    const stillClaims = await store.head("task_two");
    assert.equal(stillClaims?.digest, meta.digest, "head reports what was recorded, not what is on disk");

    const actual = createHash("sha256").update(await buffer(await store.get("task_two"))).digest("hex");
    assert.notEqual(`sha256:${actual}`, meta.digest, "the restore path compares these and must see a mismatch");
  });

  it("reports no snapshot for a task that has none", async () => {
    assert.equal(await store.head("task_absent"), null);
    await assert.rejects(() => store.get("task_absent"), SnapshotNotFoundError);
  });

  it("overwrites a previous snapshot in place, keeping exactly one archive", async () => {
    await store.put("task_three", payload("first"));
    const second = await store.put("task_three", payload("second, longer"));

    assert.equal((await buffer(await store.get("task_three"))).toString("utf8"), "second, longer");
    assert.equal((await store.head("task_three"))?.digest, second.digest);

    const files = await readdir(store.directory);
    assert.deepEqual(files.sort(), ["task_three.json", "task_three.tar.zst"]);
  });

  it("deletes idempotently and leaves nothing behind", async () => {
    await store.put("task_four", payload("bytes"));
    await store.delete("task_four");
    await store.delete("task_four");

    assert.equal(await store.head("task_four"), null);
    assert.deepEqual(await readdir(store.directory), []);
  });

  /**
   * The reaper drops the hot volume the instant `put` resolves. A half-written
   * archive that read as complete would therefore be a lost workspace, not a
   * retryable error -- so a stream that fails mid-flight must leave the store
   * saying "nothing here", and must not leave a temp file either.
   */
  it("leaves no visible snapshot and no debris when the source stream fails", async () => {
    const failing = new Readable({
      read() {
        this.push(Buffer.from("half a tar"));
        this.destroy(new Error("the volume went away"));
      },
    });

    await assert.rejects(() => store.put("task_five", failing), /the volume went away/);
    assert.equal(await store.head("task_five"), null);
    assert.deepEqual(await readdir(store.directory), [], "the .part files must be cleaned up");
  });

  it("treats an archive deleted by hand as absent rather than failing a run", async () => {
    await store.put("task_six", payload("bytes"));
    await rm(store.pathFor("task_six"));
    // The sidecar is still there and still claims a snapshot; the wake path
    // must fall back to a fresh clone rather than throwing.
    assert.equal(await store.head("task_six"), null);
  });

  it("refuses a task id that would escape the snapshots directory", async () => {
    for (const hostile of ["../../etc/passwd", "a/b", "", ".hidden", "with space"]) {
      await assert.rejects(() => store.put(hostile, payload("x")), SnapshotError, `accepted "${hostile}"`);
      await assert.rejects(() => store.head(hostile), SnapshotError, `accepted "${hostile}"`);
    }
  });

  it("writes the sidecar as readable JSON, so a human can see what is stored", async () => {
    const meta = await store.put("task_seven", payload("bytes"));
    const sidecar = JSON.parse(await readFile(join(store.directory, "task_seven.json"), "utf8")) as {
      digest: string;
      sizeBytes: number;
    };
    assert.equal(sidecar.digest, meta.digest);
    assert.equal(sidecar.sizeBytes, meta.sizeBytes);
  });
});
