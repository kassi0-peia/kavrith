import { browser } from "wxt/browser";
import {
  enqueueResult,
  pendingResult,
  removeResult,
  type ResultOutboxByChat,
} from "../../lib/result-outbox";
import { createAsyncMutationQueue } from "../../lib/async-mutation-queue";
import { kavrithSessionId } from "../../lib/kavrith-session";
import { sendToChatGPT } from "./composer";
import { createActionButton, errorMessage } from "./result-ui";

const RESULT_OUTBOX_STORAGE_KEY = "chatResultOutbox";
const mutateOutbox = createAsyncMutationQueue();
const automaticRetries = new Set<string>();
const deliveryAttempts = new Map<
  string,
  Promise<{ ok: true } | { ok: false; message: string }>
>();
const AUTO_RETRY_MIN_MS = 2_000;
const AUTO_RETRY_MAX_MS = 30_000;

export async function getOutbox(): Promise<ResultOutboxByChat> {
  const stored = await browser.storage.local.get(RESULT_OUTBOX_STORAGE_KEY);
  const value = stored[RESULT_OUTBOX_STORAGE_KEY];
  return typeof value === "object" && value !== null
    ? (value as ResultOutboxByChat)
    : {};
}

function retryKey(sessionId: string, identity: string): string {
  return `${sessionId}\0${identity}`;
}

function retryDelay(attempt: number): number {
  return Math.min(
    AUTO_RETRY_MAX_MS,
    AUTO_RETRY_MIN_MS * 2 ** Math.min(attempt, 4),
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function queueResult(
  identity: string,
  result: string,
): Promise<string> {
  const sessionId = kavrithSessionId();
  await mutateOutbox(async () => {
    await browser.storage.local.set({
      [RESULT_OUTBOX_STORAGE_KEY]: enqueueResult(
        await getOutbox(),
        sessionId,
        identity,
        result,
      ),
    });
  });
  return sessionId;
}

async function clearQueuedResult(
  sessionId: string,
  identity: string,
): Promise<void> {
  await mutateOutbox(async () => {
    await browser.storage.local.set({
      [RESULT_OUTBOX_STORAGE_KEY]: removeResult(
        await getOutbox(),
        sessionId,
        identity,
      ),
    });
  });
}

async function attemptQueuedDelivery(
  sessionId: string,
  identity: string,
  result: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const key = retryKey(sessionId, identity);
  const existingAttempt = deliveryAttempts.get(key);
  if (existingAttempt) return existingAttempt;

  const attempt = (async () => {
    if (kavrithSessionId() !== sessionId) {
      return {
        ok: false as const,
        message: "Kavrith is waiting to retry this result when you return to its chat.",
      };
    }

    const queued = pendingResult(await getOutbox(), sessionId, identity);
    // Another retry/manual action may already have delivered it.
    if (!queued) return { ok: true as const };
    if (queued.result !== result) {
      return {
        ok: false as const,
        message: "Kavrith's queued result changed; the newer result was left untouched.",
      };
    }

    const sent = await sendToChatGPT(result);
    if (sent.ok) await clearQueuedResult(sessionId, identity);
    return sent;
  })();

  deliveryAttempts.set(key, attempt);
  void attempt.finally(() => {
    if (deliveryAttempts.get(key) === attempt) deliveryAttempts.delete(key);
  });
  return attempt;
}

export function resumeQueuedResult(
  identity: string,
  result: string,
  immediate = true,
): void {
  const sessionId = kavrithSessionId();
  const key = retryKey(sessionId, identity);
  if (automaticRetries.has(key)) return;
  automaticRetries.add(key);

  void (async () => {
    let attemptNumber = 0;
    if (!immediate) await delay(retryDelay(attemptNumber++));

    while (kavrithSessionId() === sessionId) {
      const queued = pendingResult(await getOutbox(), sessionId, identity);
      if (!queued || queued.result !== result) return;

      const sent = await attemptQueuedDelivery(
        sessionId,
        identity,
        result,
      );
      if (sent.ok) return;

      await delay(retryDelay(attemptNumber++));
    }
  })().finally(() => automaticRetries.delete(key));
}

export function addComposerAction(
  controls: HTMLElement,
  identity: string,
  result: string,
): void {
  const sessionId = kavrithSessionId();
  controls.hidden = false;
  const button = createActionButton("Send result");
  const status = document.createElement("span");
  status.style.cssText = "font:12px system-ui,sans-serif;color:#dc2626;";
  controls.append(button, status);

  button.addEventListener("click", async () => {
    button.disabled = true;
    button.textContent = "Sending…";
    const sent = await attemptQueuedDelivery(sessionId, identity, result);
    if (!sent.ok) {
      status.textContent = sent.message;
      button.disabled = false;
      button.textContent = "Send result";
      return;
    }
    status.textContent = "";
    button.textContent = "Sent";
  });
}

export async function returnResultToChatGPT(
  controls: HTMLElement,
  identity: string,
  result: string,
): Promise<void> {
  const sessionId = await queueResult(identity, result);
  const sent = await attemptQueuedDelivery(sessionId, identity, result);
  if (sent.ok) {
    return;
  }

  addComposerAction(controls, identity, result);
  const status = document.createElement("span");
  status.textContent = sent.message;
  status.style.cssText = "font:12px system-ui,sans-serif;color:#dc2626;";
  controls.append(status);
  resumeQueuedResult(identity, result, false);
}

function formatKavrithError(
  operation: string,
  cause: unknown,
  workspaceName?: string,
): string {
  const message = errorMessage(cause);
  return [
    "<kavrith_error>",
    ...(workspaceName ? [`workspace: ${workspaceName}`] : []),
    `operation: ${operation}`,
    `message: ${message}`,
    "</kavrith_error>",
  ].join("\n");
}

export async function returnErrorToChatGPT(
  controls: HTMLElement,
  identity: string,
  operation: string,
  cause: unknown,
  workspaceName?: string,
): Promise<void> {
  await returnResultToChatGPT(
    controls,
    identity,
    formatKavrithError(operation, cause, workspaceName),
  );
}
