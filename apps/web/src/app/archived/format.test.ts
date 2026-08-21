import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatBytes, totalSnapshotBytes, type ArchivedTask } from "./format";

/**
 * The one number on the /archived page that is a claim about the world: how
 * much disk the cold tier is actually holding.
 */

describe("snapshot sizes on the archived page", () => {
  it("reads in the unit a person would use", () => {
    assert.equal(formatBytes(0), "0 B");
    assert.equal(formatBytes(512), "512 B");
    assert.equal(formatBytes(2048), "2 KB");
    assert.equal(formatBytes(5 * 1024 * 1024), "5.0 MB");
    assert.equal(formatBytes(3 * 1024 * 1024 * 1024), "3.00 GB");
  });

  it("does not print NaN or a negative size", () => {
    assert.equal(formatBytes(Number.NaN), "—");
    assert.equal(formatBytes(-1), "—");
  });

  it("totals only the tasks that actually have a snapshot", () => {
    const rows = [
      row("a", 1000),
      // Archived before it ever ran: a status change with nothing to export.
      row("b", null),
      row("c", 2000),
    ];
    assert.equal(totalSnapshotBytes(rows), 3000);
    assert.equal(totalSnapshotBytes([]), 0);
  });
});

function row(id: string, sizeBytes: number | null): ArchivedTask {
  return {
    task: {
      id,
      title: id,
      mode: "code",
      status: "archived",
      repoFullName: "fixture/repo",
      baseBranch: "main",
      baseSha: "0".repeat(40),
      workBranch: null,
      volumeName: null,
      archivedAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      latestRun: null,
    },
    snapshot: sizeBytes === null ? null : { sizeBytes, createdAt: new Date().toISOString() },
  };
}
