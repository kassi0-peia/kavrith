import { browser } from "wxt/browser";
import {
  PROTOCOL_VERSION,
  type NativeRequest,
  type NativeResponse,
} from "@kavrith/protocol";
import { ACCESS_MODE_STORAGE_KEY, type AccessMode } from "../lib/messages";
import { routeBackgroundMessage } from "../lib/background-routing";
import { getChatInitialization } from "../lib/chat-initialization";

const HOST_NAME = "com.kavrith.host";
const NATIVE_STALL_CHECK_MS = 15_000;
const NATIVE_HEALTH_TIMEOUT_MS = 5_000;
let port: ReturnType<typeof browser.runtime.connectNative> | undefined;
let healthCheck: Promise<boolean> | undefined;
const pending = new Map<
  string,
  {
    resolve: (response: NativeResponse) => void;
    reject: (reason: Error) => void;
    watchdog?: ReturnType<typeof setTimeout>;
  }
>();

function rejectPending(message: string): void {
  for (const { reject, watchdog } of pending.values()) {
    if (watchdog !== undefined) clearTimeout(watchdog);
    reject(new Error(message));
  }
  pending.clear();
}

function disconnectPort(
  connectedPort: ReturnType<typeof browser.runtime.connectNative>,
  message: string,
): void {
  if (port !== connectedPort) return;
  port = undefined;
  rejectPending(message);
  try {
    connectedPort.disconnect();
  } catch {
    // The native port may already be gone.
  }
}

function getPort(): ReturnType<typeof browser.runtime.connectNative> {
  if (port) return port;

  port = browser.runtime.connectNative(HOST_NAME);
  port.onMessage.addListener((message: unknown) => {
    if (typeof message !== "object" || message === null) return;
    const response = message as Partial<NativeResponse>;
    if (typeof response.id !== "string") return;
    const request = pending.get(response.id);
    if (!request) return;
    if (request.watchdog !== undefined) clearTimeout(request.watchdog);
    pending.delete(response.id);
    request.resolve(message as NativeResponse);
  });
  const connectedPort = port;
  port.onDisconnect.addListener(() => {
    const firefoxError = (
      connectedPort as typeof connectedPort & { error?: Error }
    ).error;
    const message =
      firefoxError?.message ??
      browser.runtime.lastError?.message ??
      "Native host disconnected";
    console.error("Kavrith local host disconnected:", message);
    // Ignore a late disconnect from an old port after a replacement has
    // already been established.
    if (port === connectedPort) {
      port = undefined;
      rejectPending(message);
    }
  });
  return port;
}

type NativeRequestInput = NativeRequest extends infer Request
  ? Request extends NativeRequest
    ? Omit<Request, "version" | "id">
    : never
  : never;

function sendNativeDirect(
  input: NativeRequestInput,
  watchdog = true,
): Promise<NativeResponse> {
  const id = crypto.randomUUID();
  const request = { ...input, version: PROTOCOL_VERSION, id } as NativeRequest;

  return new Promise((resolve, reject) => {
    const entry: {
      resolve: (response: NativeResponse) => void;
      reject: (reason: Error) => void;
      watchdog?: ReturnType<typeof setTimeout>;
    } = { resolve, reject };
    pending.set(id, entry);

    if (watchdog) {
      entry.watchdog = setTimeout(() => {
        void handleStalledRequest(id);
      }, NATIVE_STALL_CHECK_MS);
    }

    try {
      getPort().postMessage(request);
    } catch (cause) {
      if (entry.watchdog !== undefined) clearTimeout(entry.watchdog);
      pending.delete(id);
      reject(cause instanceof Error ? cause : new Error(String(cause)));
    }
  });
}

async function nativePortIsHealthy(): Promise<boolean> {
  if (healthCheck) return healthCheck;
  const connectedPort = port;
  if (!connectedPort) return false;

  healthCheck = (async () => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutResult = new Promise<boolean>((resolve) => {
      timeout = setTimeout(() => resolve(false), NATIVE_HEALTH_TIMEOUT_MS);
    });
    const pingResult = sendNativeDirect({ method: "ping" }, false).then(
      () => port === connectedPort,
      () => false,
    );

    const healthy = await Promise.race([pingResult, timeoutResult]);
    if (timeout !== undefined) clearTimeout(timeout);

    if (!healthy && port === connectedPort) {
      const message =
        `Native host became unresponsive: health check did not complete within ` +
        `${NATIVE_HEALTH_TIMEOUT_MS} ms. Kavrith reset the connection.`;
      console.error(message);
      disconnectPort(connectedPort, message);
    }
    return healthy;
  })().finally(() => {
    healthCheck = undefined;
  });

  return healthCheck;
}

async function handleStalledRequest(id: string): Promise<void> {
  const request = pending.get(id);
  if (!request) return;
  delete request.watchdog;

  const healthy = await nativePortIsHealthy();
  const current = pending.get(id);
  if (!current) return;

  if (healthy) {
    // The host is alive; this may simply be a legitimate long-running command.
    // Keep waiting and probe again later rather than aborting valid work.
    current.watchdog = setTimeout(() => {
      void handleStalledRequest(id);
    }, NATIVE_STALL_CHECK_MS);
  }
}

function sendNative(input: NativeRequestInput): Promise<NativeResponse> {
  return sendNativeDirect(input, true);
}

async function taskRoot(sessionId?: string): Promise<string> {
  if (!sessionId) throw new Error("Kavrith session id is unavailable");
  const initialization = await getChatInitialization(sessionId);
  if (!initialization)
    throw new Error("Kavrith is not initialized for this chat");
  return initialization.rootPath;
}

async function authorizeMutation(
  authorization: "approved" | "full",
  sessionId?: string,
): Promise<void> {
  if (authorization === "approved") return;
  if (sessionId) {
    const initialization = await getChatInitialization(sessionId);
    if (initialization) {
      if (initialization.accessMode !== "full") {
        throw new Error("Full Access mode is not enabled for this chat");
      }
      return;
    }
  }
  const stored = await browser.storage.local.get(ACCESS_MODE_STORAGE_KEY);
  const mode = stored[ACCESS_MODE_STORAGE_KEY] as AccessMode | undefined;
  if (mode !== "full") throw new Error("Full Access mode is not enabled");
}

async function recordOperation(
  rootPath: string,
  operation: string,
  response: NativeResponse,
  sessionId?: string,
): Promise<void> {
  if (!sessionId) return;
  const filesChanged =
    response.ok && "filesChanged" in response.result
      ? response.result.filesChanged
      : undefined;
  const checkpointId =
    response.ok && "checkpointId" in response.result
      ? response.result.checkpointId
      : undefined;
  try {
    await sendNative({
      method: "task.record",
      rootPath,
      sessionId,
      operation,
      ok: response.ok,
      ...(filesChanged === undefined ? {} : { filesChanged }),
      ...(checkpointId === undefined ? {} : { checkpointId }),
    });
  } catch (cause) {
    console.warn("Kavrith task journal write failed:", cause);
  }
}

async function sendTracked(
  input: NativeRequestInput & { rootPath: string },
  sessionId?: string,
): Promise<NativeResponse> {
  if (sessionId) {
    try {
      await sendNative({
        method: "task.ensure",
        rootPath: input.rootPath,
        sessionId,
      });
    } catch (cause) {
      console.warn("Kavrith task session initialization failed:", cause);
    }
  }
  const response = await sendNative(input);
  await recordOperation(input.rootPath, input.method, response, sessionId);
  return response;
}

export default defineBackground(() => {
  browser.runtime.onMessage.addListener((message: unknown) =>
    routeBackgroundMessage(message, {
      sendNative,
      sendTracked,
      taskRoot,
      authorizeMutation,
    }),
  );
});
