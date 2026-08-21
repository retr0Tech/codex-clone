import type { ClientFrame } from "@codex-clone/core";

/**
 * Parsing what arrives on the socket.
 *
 * A browser tab is not a trusted peer -- any page the user has open can open a
 * WebSocket to 127.0.0.1 -- so everything here validates rather than casts, and
 * an unrecognised frame is dropped with a reason instead of throwing inside the
 * message handler.
 */

/** A subscribe frame is small; anything large is either a bug or an attack. */
export const MAX_CLIENT_FRAME_BYTES = 16 * 1024;

export type ParsedFrame = { ok: true; frame: ClientFrame } | { ok: false; reason: string };

export function parseClientFrame(raw: string): ParsedFrame {
  if (raw.length > MAX_CLIENT_FRAME_BYTES) {
    return { ok: false, reason: `frame exceeds ${MAX_CLIENT_FRAME_BYTES} bytes` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "frame is not valid JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "frame must be a JSON object" };
  }

  const o = parsed as Record<string, unknown>;
  switch (o["kind"]) {
    case "subscribe": {
      if (typeof o["taskId"] !== "string" || o["taskId"] === "") {
        return { ok: false, reason: "subscribe requires a taskId" };
      }
      const after = o["after"];
      if (after !== undefined && (typeof after !== "number" || !Number.isFinite(after) || after < 0)) {
        return { ok: false, reason: "after must be a non-negative number" };
      }
      return { ok: true, frame: { kind: "subscribe", taskId: o["taskId"], after: (after as number) ?? 0 } };
    }
    case "cancel": {
      if (typeof o["runId"] !== "string" || o["runId"] === "") {
        return { ok: false, reason: "cancel requires a runId" };
      }
      return { ok: true, frame: { kind: "cancel", runId: o["runId"] } };
    }
    default:
      return { ok: false, reason: `unknown frame kind ${JSON.stringify(o["kind"])}` };
  }
}

/**
 * The handshake can also travel in the URL: `?taskId=…&after=…`.
 *
 * That saves a round trip on the common case -- a page load knows what it wants
 * before the socket is even open -- while the `subscribe` frame remains the way
 * to re-subscribe on an open connection.
 */
export function parseHandshake(url: string | undefined): { taskId: string; after: number } | null {
  if (!url) return null;
  let params: URLSearchParams;
  try {
    params = new URL(url, "ws://localhost").searchParams;
  } catch {
    return null;
  }
  const taskId = params.get("taskId");
  if (!taskId) return null;
  const after = Number(params.get("after") ?? 0);
  return { taskId, after: Number.isFinite(after) && after > 0 ? after : 0 };
}

/**
 * The socket is bound to 127.0.0.1 and there is no auth (single local user), so
 * the only reachable attacker is a page in the user's own browser: any site can
 * point a WebSocket at localhost, and unlike fetch, the browser will not stop
 * it. Restricting Origin to loopback is what keeps a random tab from reading
 * this user's transcripts. A missing Origin (a native client, a test) is
 * allowed -- it is not a browser, so it is not the threat this guards against.
 */
export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const host = new URL(origin).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}
