import { browser } from "wxt/browser";
import { createAsyncMutationQueue } from "../../lib/async-mutation-queue";
import { kavrithSessionId } from "../../lib/kavrith-session";
import { missingDirectiveRecoveryDecision } from "../../lib/missing-directive-recovery";
import { sendToChatGPT } from "./composer";

const STORAGE_KEY = "missingVisibleDirectiveRecovery";
const ASSISTANT_SELECTOR = "[data-message-author-role='assistant']";
const RECOVERY_TTL_MS = 120_000;
const RECOVERY_PROMPT = [
  "Kavrith: No visible Kavrith directive was found in your last reply.",
  "If repository work is still required, put the # kavrith:... directive in a fenced code block in the visible assistant message body, not hidden reasoning.",
  "Do not merely describe the command; emit the actual visible Kavrith directive.",
].join(" ");

export interface MissingDirectiveRecoveryBaseline {
  assistantCount: number;
  latestAssistantIdentity?: string;
}

interface RecoveryMarker extends MissingDirectiveRecoveryBaseline {
  armedAt: number;
  resultObservedAt?: number;
}

type RecoveryByChat = Record<string, RecoveryMarker>;

const mutateRecovery = createAsyncMutationQueue();
const pendingBySession = new Map<string, RecoveryMarker>();
const loadedSessions = new Set<string>();
const reminderAttempts = new Map<string, Promise<void>>();

function assistantTurnIdentity(message: HTMLElement | undefined): string | undefined {
  if (!message) return undefined;
  const turn = message.closest<HTMLElement>(
    "[data-message-id], [data-testid^='conversation-turn-']",
  );
  return turn?.dataset.messageId ?? turn?.dataset.testid;
}

function assistantMessages(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(ASSISTANT_SELECTOR)];
}

export function captureMissingDirectiveRecoveryBaseline(): MissingDirectiveRecoveryBaseline {
  const messages = assistantMessages();
  const identity = assistantTurnIdentity(messages.at(-1));
  return {
    assistantCount: messages.length,
    ...(identity === undefined ? {} : { latestAssistantIdentity: identity }),
  };
}

async function storedRecovery(): Promise<RecoveryByChat> {
  const stored = await browser.storage.local.get(STORAGE_KEY);
  const value = stored[STORAGE_KEY];
  return typeof value === "object" && value !== null
    ? (value as RecoveryByChat)
    : {};
}

async function ensureSessionLoaded(sessionId: string): Promise<void> {
  if (loadedSessions.has(sessionId)) return;
  const marker = (await storedRecovery())[sessionId];
  if (marker) pendingBySession.set(sessionId, marker);
  loadedSessions.add(sessionId);
}

async function persistMarker(
  sessionId: string,
  marker: RecoveryMarker,
): Promise<void> {
  pendingBySession.set(sessionId, marker);
  loadedSessions.add(sessionId);

  await mutateRecovery(async () => {
    await browser.storage.local.set({
      [STORAGE_KEY]: {
        ...(await storedRecovery()),
        [sessionId]: marker,
      },
    });
  });
}

async function clearMarker(sessionId: string): Promise<void> {
  pendingBySession.delete(sessionId);

  await mutateRecovery(async () => {
    const stored = await storedRecovery();
    if (!stored[sessionId]) return;
    const next = { ...stored };
    delete next[sessionId];
    await browser.storage.local.set({ [STORAGE_KEY]: next });
  });
}

export async function armMissingDirectiveRecovery(
  sessionId: string,
  baseline: MissingDirectiveRecoveryBaseline,
): Promise<void> {
  await persistMarker(sessionId, { ...baseline, armedAt: Date.now() });
}

export async function confirmMissingDirectiveRecovery(
  sessionId: string,
): Promise<void> {
  await ensureSessionLoaded(sessionId);
  const marker = pendingBySession.get(sessionId);
  if (!marker) return;
  await persistMarker(sessionId, {
    ...marker,
    resultObservedAt: Date.now(),
  });
}

function messageHasVisibleDirective(message: HTMLElement): boolean {
  for (const pre of message.querySelectorAll<HTMLElement>("pre")) {
    if (!pre.isConnected || pre.getClientRects().length === 0) continue;
    if (pre.innerText.trimStart().startsWith("# kavrith:")) return true;
  }
  return false;
}

function isNewAssistantTurn(
  marker: RecoveryMarker,
  messages: HTMLElement[],
  latestIdentity: string | undefined,
): boolean {
  if (marker.latestAssistantIdentity && latestIdentity) {
    return marker.latestAssistantIdentity !== latestIdentity;
  }
  return messages.length > marker.assistantCount;
}

export async function maybeRecoverMissingVisibleDirectiveForMessage(
  message: HTMLElement,
): Promise<void> {
  const sessionId = kavrithSessionId();
  await ensureSessionLoaded(sessionId);

  const marker = pendingBySession.get(sessionId);
  if (!marker) return;

  if (Date.now() - marker.armedAt > RECOVERY_TTL_MS) {
    await clearMarker(sessionId);
    return;
  }

  const messages = assistantMessages();
  const messageIdentity = assistantTurnIdentity(message);
  const hasNewAssistantTurn = isNewAssistantTurn(
    marker,
    messages,
    messageIdentity,
  );

  const decision = missingDirectiveRecoveryDecision({
    pending: true,
    assistantGenerating: false,
    hasNewAssistantTurn,
    assistantTurnSettled: true,
    hasVisibleDirective: messageHasVisibleDirective(message),
  });

  if (decision === "wait") return;

  if (decision === "clear") {
    await clearMarker(sessionId);
    return;
  }

  if (decision !== "remind") return;
  if (reminderAttempts.has(sessionId)) return;

  // Clear before sending so the recovery prompt itself can never recurse.
  await clearMarker(sessionId);

  const attempt = (async () => {
    await sendToChatGPT(RECOVERY_PROMPT);
  })();

  reminderAttempts.set(sessionId, attempt);
  void attempt.finally(() => {
    if (reminderAttempts.get(sessionId) === attempt) {
      reminderAttempts.delete(sessionId);
    }
  });
}
