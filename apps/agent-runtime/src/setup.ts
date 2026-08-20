import { spawn } from "node:child_process";
import type { DurableEventWriter } from "./events.js";
import type { AgentJobSpec } from "./job-spec.js";

/**
 * The repo install step, as its own visible phase (PLAN.md section 3.7).
 *
 * A failing `npm ci` is the single most common reason a run produces nothing
 * useful. Running it as a distinct phase with its own streamed log means that
 * shows up in the transcript as "setup failed on line 12" rather than as an
 * agent that mysteriously cannot import anything.
 */

export const SETUP_TIMEOUT_MS = 10 * 60 * 1000;

export interface SetupResult {
  ok: boolean;
  skipped: boolean;
  exitCode: number;
  reason?: string;
}

export async function runSetupPhase(job: AgentJobSpec, writer: DurableEventWriter): Promise<SetupResult> {
  writer.emit("phase", { phase: "setup" });

  // The workspace volume is written by the host (git clone) and read by a
  // different uid in here, so git refuses to operate on it until it is marked
  // safe. HOME is a tmpfs, so this config dies with the container.
  await run("git", ["config", "--global", "--add", "safe.directory", job.workspacePath], job, writer);

  if (!job.setupScript || job.setupScript.trim() === "") {
    writer.emit("setup_log", { stream: "stdout", text: "no setup script configured for this repo; skipping\n" });
    return { ok: true, skipped: true, exitCode: 0 };
  }

  if (job.mode === "ask") {
    // /workspace is mounted read-only in ask mode, so an install step could
    // only fail with EROFS. Skipping it explicitly is clearer in the
    // transcript than a page of permission errors.
    writer.emit("setup_log", {
      stream: "stdout",
      text: "ask mode: workspace is mounted read-only, so the setup script is skipped\n",
    });
    return { ok: true, skipped: true, exitCode: 0 };
  }

  writer.emit("setup_log", { stream: "stdout", text: `$ ${job.setupScript}\n` });
  const code = await run("bash", ["-lc", job.setupScript], job, writer);
  if (code !== 0) {
    return { ok: false, skipped: false, exitCode: code, reason: `setup script exited ${code}` };
  }
  return { ok: true, skipped: false, exitCode: 0 };
}

function run(cmd: string, args: string[], job: AgentJobSpec, writer: DurableEventWriter): Promise<number> {
  return new Promise<number>((resolve) => {
    const child = spawn(cmd, args, {
      cwd: job.workspacePath,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stream = (src: NodeJS.ReadableStream, name: "stdout" | "stderr") => {
      let buffer = "";
      src.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        let idx: number;
        // Emit line-at-a-time so the UI can render progressively, and so one
        // enormous line from a progress bar cannot become one enormous event.
        while ((idx = buffer.indexOf("\n")) !== -1) {
          writer.emit("setup_log", { stream: name, text: `${buffer.slice(0, idx)}\n` });
          buffer = buffer.slice(idx + 1);
        }
        if (buffer.length > 8192) {
          writer.emit("setup_log", { stream: name, text: buffer });
          buffer = "";
        }
      });
      src.on("end", () => {
        if (buffer !== "") writer.emit("setup_log", { stream: name, text: buffer });
      });
    };
    stream(child.stdout, "stdout");
    stream(child.stderr, "stderr");

    const timer = setTimeout(() => {
      writer.emit("setup_log", { stream: "stderr", text: `\n[setup timed out after ${SETUP_TIMEOUT_MS}ms]\n` });
      child.kill("SIGKILL");
    }, SETUP_TIMEOUT_MS);

    child.on("error", (err: Error) => {
      clearTimeout(timer);
      writer.emit("setup_log", { stream: "stderr", text: `[failed to spawn ${cmd}: ${err.message}]\n` });
      resolve(127);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve(code ?? (signal ? 137 : 1));
    });
  });
}
