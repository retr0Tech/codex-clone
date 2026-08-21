import { request } from "node:http";
import type { GatewayChunk } from "@codex-clone/core";

/**
 * A minimal client for the gateway's own protocol.
 *
 * The shipping client is `UnixSocketGatewayClient` inside the agent runtime --
 * it must live there, because the container bundle cannot depend on worker
 * code. This one exists so the gateway can be tested, and driven from the
 * host, without reaching across that boundary.
 *
 * It deliberately mirrors the agent's failure contract: transport problems
 * come back as a `refused` chunk, never as a rejection, so no caller can hang.
 */
export interface NdjsonGatewayCallOptions {
  socketPath: string;
  path?: string;
  timeoutMs?: number;
}

export function callGateway(opts: NdjsonGatewayCallOptions, payload: unknown): Promise<GatewayChunk[]> {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const timeoutMs = opts.timeoutMs ?? 30_000;

  return new Promise<GatewayChunk[]>((resolve) => {
    const chunks: GatewayChunk[] = [];
    const refuse = (message: string) =>
      resolve([...chunks, { type: "refused", reason: "upstream_error", message }]);

    const req = request(
      {
        socketPath: opts.socketPath,
        path: opts.path ?? "/v1/responses",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(body.byteLength),
          accept: "application/x-ndjson",
        },
      },
      (res) => {
        let buffer = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => {
          buffer += c;
        });
        res.on("end", () => {
          if (res.statusCode !== undefined && res.statusCode >= 400) {
            refuse(`gateway returned HTTP ${res.statusCode}: ${buffer.trim()}`);
            return;
          }
          for (const line of buffer.split("\n")) {
            if (line.trim() === "") continue;
            try {
              chunks.push(JSON.parse(line) as GatewayChunk);
            } catch {
              // A malformed line is a gateway bug; surface it as a refusal
              // rather than silently dropping a chunk.
              refuse(`gateway emitted a malformed NDJSON line: ${line.slice(0, 200)}`);
              return;
            }
          }
          resolve(chunks);
        });
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy();
      refuse(`gateway did not respond within ${timeoutMs}ms`);
    });
    req.on("error", (err: Error) => refuse(`gateway socket error: ${err.message}`));
    req.end(body);
  });
}
