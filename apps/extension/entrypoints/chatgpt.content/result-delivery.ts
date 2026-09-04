import { browser } from "wxt/browser";
import {
  enqueueResult,
  pendingResult,
  removeResult,
  resultAllowsAutomaticRetry,
  withResultAutomaticRetry,
  type ResultOutboxByChat,
} from "../../lib/result-outbox";
import { createAsyncMutationQueue } from "../../lib/async-mutation-queue";
import { userTurnContainsDeliveredResult } from "../../lib/composer-delivery";
import { kavrithSessionId } from "../../lib/kavrith-session";
import { resultForChatGPTDelivery } from "../../lib/result-delivery-payload";
import { sendToChatGPT } from "./composer";
import { createActionButton, errorMessage } from "./result-ui";
import {
  armMissingDirectiveRecovery,
  captureMissingDirectiveRecoveryBaseline,
  confirmMissingDirectiveRecovery,
} from "./missing-directive-recovery";

const RESULT_OUTBOX_STORAGE_KEY = "chatResultOutbox";
const mutateOutbox = createAsyncMutationQueue();
const automaticRetries = new Set<string>();
const deliveryAttempts = new Map<
  string,
  Promise<
    | { ok: true }
    | { ok: false; message: string; automaticRetry?: boolean }
  >
>();
const AUTO_RETRY_MIN_MS = 2_000;
const AUTO_RETRY_MAX_MS = 30_000;

function resultObservedInChat(
  result: string,
  recentUserTurnLimit = 4,
): boolean {
  const explicitUsers = [
    ...document.querySelectorAll<HTMLElement>(
      "[data-message-author-role='user']",
    ),
  ];
  const candidates =
    explicitUsers.length > 0
      ? explicitUsers
      : [
          ...document.querySelectorAll<HTMLElement>(
            "[data-testid^='conversation-turn-']",
          ),
        ].filter(
          (turn) =>
            !turn.querySelector("[data-message-author-role='assistant']"),
        );

  const messages =
    recentUserTurnLimit > 0
      ? candidates.slice(-recentUserTurnLimit)
      : candidates;
  return messages
    .some((message) =>
      userTurnContainsDeliveredResult(result, message.innerText),
    );
}

export async function reconcileObservedQueuedResult(
  identity: string,
  result: string,
): Promise<boolean> {
  const sessionId = kavrithSessionId();
  const queued = pendingResult(await getOutbox(), sessionId, identity);
  if (!queued || queued.result !== result) return !queued;
  if (!resultObservedInChat(result, 0)) return false;

  await clearQueuedResult(sessionId, identity);
  await confirmMissingDirectiveRecovery(sessionId);
  return true;
}

async function waitForObservedResult(result: string): Promise<boolean> {
  const deadline = performance.now() + 2_000;
  while (performance.now() < deadline) {
    if (resultObservedInChat(result)) return true;
    await delay(80);
  }
  return resultObservedInChat(result);
}

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

async function setQueuedAutomaticRetry(
  sessionId: string,
  identity: string,
  automaticRetry: boolean,
): Promise<void> {
  await mutateOutbox(async () => {
    await browser.storage.local.set({
      [RESULT_OUTBOX_STORAGE_KEY]: withResultAutomaticRetry(
        await getOutbox(),
        sessionId,
        identity,
        automaticRetry,
      ),
    });
  });
}

async function attemptQueuedDelivery(
  sessionId: string,
  identity: string,
  result: string,
): Promise<
  | { ok: true }
  | { ok: false; message: string; automaticRetry?: boolean }
> {
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

    if (resultObservedInChat(result)) {
      await clearQueuedResult(sessionId, identity);
      await confirmMissingDirectiveRecovery(sessionId);
      return { ok: true as const };
    }

    const recoveryBaseline = captureMissingDirectiveRecoveryBaseline();
    await armMissingDirectiveRecovery(sessionId, recoveryBaseline);
    const sent = await sendToChatGPT(result, () => resultObservedInChat(result));
    const observed = await waitForObservedResult(result);
    if (observed) {
      await clearQueuedResult(sessionId, identity);
      await confirmMissingDirectiveRecovery(sessionId);
      return { ok: true as const };
    }
    if (sent.ok) {
      await clearQueuedResult(sessionId, identity);
      await confirmMissingDirectiveRecovery(sessionId);
    } else if (sent.automaticRetry === false) {
      await setQueuedAutomaticRetry(sessionId, identity, false);
    }
    return sent;
  })();

  deliveryAttempts.set(key, attempt);
  void attempt.finally(() => {
    if (deliveryAttempts.get(key) === attempt) deliveryAttempts.delete(key);
  });
  return attempt;
}

async function attemptManualQueuedDelivery(
  sessionId: string,
  identity: string,
  result: string,
): Promise<
  | { ok: true }
  | { ok: false; message: string; automaticRetry?: boolean }
> {
  const key = retryKey(sessionId, identity);
  const existing = deliveryAttempts.get(key);
  if (existing) await existing;

  const queued = pendingResult(await getOutbox(), sessionId, identity);
  if (!queued) return { ok: true };
  if (queued.result !== result) {
    return {
      ok: false,
      message: "Kavrith's queued result changed; the newer result was left untouched.",
    };
  }
  return attemptQueuedDelivery(sessionId, identity, result);
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
      if (!resultAllowsAutomaticRetry(queued)) return;

      const sent = await attemptQueuedDelivery(
        sessionId,
        identity,
        result,
      );
      if (sent.ok) return;
      if (sent.automaticRetry === false) return;

      await delay(retryDelay(attemptNumber++));
    }
  })().finally(() => automaticRetries.delete(key));
}

export function addComposerAction(
  controls: HTMLElement,
  identity: string,
  result: string,
  initialStatus = "",
): void {
  const sessionId = kavrithSessionId();
  controls.hidden = false;
  const button = createActionButton("Send result");
  const status = document.createElement("span");
  status.style.cssText = "font:12px system-ui,sans-serif;color:#dc2626;";
  status.textContent = initialStatus;
  controls.append(button, status);

  button.addEventListener("click", async () => {
    button.disabled = true;
    button.textContent = "Sending…";
    const sent = await attemptManualQueuedDelivery(
      sessionId,
      identity,
      result,
    );
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
  const deliveryResult = resultForChatGPTDelivery(result);
  const sessionId = await queueResult(identity, deliveryResult);
  const sent = await attemptQueuedDelivery(
    sessionId,
    identity,
    deliveryResult,
  );
  if (sent.ok) {
    return;
  }

  addComposerAction(controls, identity, deliveryResult, sent.message);
  if (sent.automaticRetry !== false) {
    resumeQueuedResult(identity, deliveryResult, false);
  }
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
