#!/usr/bin/env node
import { MessageDecoder, encodeMessage } from "./framing.js";
import { handleRequest } from "./handler.js";

const decoder = new MessageDecoder();
const processingByRoot = new Map<string, Promise<void>>();

function queueKey(request: unknown): string | undefined {
  if (typeof request !== "object" || request === null || Array.isArray(request)) {
    return undefined;
  }
  const rootPath = (request as { rootPath?: unknown }).rootPath;
  return typeof rootPath === "string" && rootPath.length > 0
    ? `root:${rootPath}`
    : undefined;
}

function requestId(request: unknown): string {
  if (typeof request !== "object" || request === null || Array.isArray(request)) {
    return "unknown";
  }
  const id = (request as { id?: unknown }).id;
  return typeof id === "string" ? id : "unknown";
}

async function processRequest(request: unknown): Promise<void> {
  try {
    process.stdout.write(encodeMessage(await handleRequest(request)));
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const id = requestId(request);
    console.error(`Kavrith local host handler error: ${message}`);
    process.stdout.write(
      encodeMessage({
        version: 1,
        id,
        ok: false,
        error: {
          code: "INTERNAL_ERROR",
          message: "Native host failed to process the request",
        },
      }),
    );
  }
}

function logProcessingError(cause: unknown): void {
  const message = cause instanceof Error ? cause.message : String(cause);
  console.error(`Kavrith local host handler error: ${message}`);
}

function enqueueRequest(request: unknown): void {
  const key = queueKey(request);

  // Rootless utility requests (notably ping) must not sit behind an unrelated
  // repository command. Native responses are correlated by request id, so
  // out-of-order completion is safe.
  if (!key) {
    void processRequest(request).catch(logProcessingError);
    return;
  }

  // Preserve deterministic ordering for operations against the same
  // repository while allowing independent repositories to make progress.
  const previous = processingByRoot.get(key) ?? Promise.resolve();
  const next = previous.then(() => processRequest(request)).catch(logProcessingError);
  processingByRoot.set(key, next);
  void next.finally(() => {
    if (processingByRoot.get(key) === next) processingByRoot.delete(key);
  });
}

process.stdin.on("data", (chunk: Buffer) => {
  try {
    for (const request of decoder.push(chunk)) enqueueRequest(request);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    console.error(`Kavrith local host input error: ${message}`);
    process.stdout.write(
      encodeMessage({
        version: 1,
        id: "unknown",
        ok: false,
        error: { code: "INVALID_REQUEST", message },
      }),
    );
  }
});

process.stdin.on("error", (cause) => {
  console.error(`Kavrith local host stdin error: ${cause.message}`);
});
