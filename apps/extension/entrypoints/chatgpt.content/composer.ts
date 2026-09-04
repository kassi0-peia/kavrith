import {
  composerMatchesExpected,
  composerOwnershipFailure,
  composerRecoveryFailure,
  composerRecoveryDecision,
  composerRollbackDecision,
  composerSendAcceptanceDecision,
  firstUsableCandidate,
} from "../../lib/composer-delivery";

const COMPOSER_SELECTORS = [
  "#prompt-textarea[contenteditable='true']",
  "textarea#prompt-textarea",
  "textarea[data-testid='prompt-textarea']",
] as const;

type Composer = HTMLElement | HTMLTextAreaElement;
const SEND_READY_TIMEOUT_MS = 30_000;
const COMPOSER_STABLE_MS = 300;
const COMPOSER_STABLE_TIMEOUT_MS = 2_000;
const COMPOSER_RESYNC_MS = 1_000;
const SEND_ACCEPT_TIMEOUT_MS = 8_000;
const DELIVERY_POLL_MIN_MS = 40;
const DELIVERY_POLL_MAX_MS = 250;
const DELIVERY_POLL_RAMP_MS = 5_000;
const COMPOSER_SELECTOR = COMPOSER_SELECTORS.join(",");
const SEND_BUTTON_SELECTOR = [
  "button[data-testid='send-button']",
  "button[data-testid='composer-submit-button']",
  "button[aria-label='Send prompt']",
  "button[aria-label='Send']",
  "button[aria-label='Send message']",
].join(",");
const FORM_SEND_BUTTON_SELECTOR = `${SEND_BUTTON_SELECTOR},button[type='submit']`;
const USER_EDIT_EVENTS = [
  "keydown",
  "paste",
  "drop",
  "cut",
  "compositionstart",
] as const;

function composerIsUsable(element: HTMLElement): element is Composer {
  if (!element.isConnected || element.getClientRects().length === 0) return false;
  if (element instanceof HTMLTextAreaElement) {
    return !element.disabled && !element.readOnly;
  }
  return element.isContentEditable;
}

function findComposer(): Composer | undefined {
  for (const selector of COMPOSER_SELECTORS) {
    const element = firstUsableCandidate(
      document.querySelectorAll<HTMLElement>(selector),
      composerIsUsable,
    );
    if (element) return element;
  }
  return undefined;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, milliseconds);
  });
}

function deliveryPollDelay(startedAt: number): number {
  const elapsed = Math.max(0, performance.now() - startedAt);
  const progress = Math.min(1, elapsed / DELIVERY_POLL_RAMP_MS);
  return Math.round(
    DELIVERY_POLL_MIN_MS +
      (DELIVERY_POLL_MAX_MS - DELIVERY_POLL_MIN_MS) * progress,
  );
}

function waitForDeliveryPoll(startedAt: number): Promise<void> {
  return delay(deliveryPollDelay(startedAt));
}

async function waitForStableComposer(): Promise<Composer | undefined> {
  const deadline = performance.now() + COMPOSER_STABLE_TIMEOUT_MS;
  let candidate: Composer | undefined;
  let candidateSince = 0;

  while (performance.now() < deadline) {
    const current = findComposer();
    const now = performance.now();

    if (current !== candidate) {
      candidate = current;
      candidateSince = current ? now : 0;
    } else if (
      current &&
      candidateSince > 0 &&
      now - candidateSince >= COMPOSER_STABLE_MS
    ) {
      return current;
    }

    await delay(40);
  }

  return undefined;
}

function composerText(composer: Composer): string {
  return composer instanceof HTMLTextAreaElement
    ? composer.value
    : composer.innerText;
}

function findSendButton(composer: Composer): HTMLButtonElement | undefined {
  const usableSendButton = (candidate: HTMLButtonElement): boolean => {
    const testId = candidate.dataset.testid ?? "";
    const ariaLabel = candidate.getAttribute("aria-label")?.trim().toLowerCase() ?? "";
    return (
      !candidate.disabled &&
      candidate.getAttribute("aria-disabled") !== "true" &&
      candidate.getClientRects().length > 0 &&
      testId !== "stop-button" &&
      !ariaLabel.startsWith("stop")
    );
  };

  const form = composer.closest("form");
  if (form) {
    const button = firstUsableCandidate(
      form.querySelectorAll<HTMLButtonElement>(FORM_SEND_BUTTON_SELECTOR),
      usableSendButton,
    );
    if (button) return button;
  }

  return firstUsableCandidate(
    document.querySelectorAll<HTMLButtonElement>(SEND_BUTTON_SELECTOR),
    usableSendButton,
  );
}

function clearDeliveredResultResidue(result: string): void {
  const composer = findComposer();
  if (!composer) return;
  if (!composerMatchesExpected(result, composerText(composer))) return;
  try {
    writeComposer(composer, "");
  } catch {
    // Delivery is already confirmed by the visible user turn. A residue that
    // cannot be cleared is annoying but must not turn successful delivery into
    // a failed/duplicate send.
  }
}

async function waitForSendAcceptance(
  expectedComposerText: string,
  sourceResult: string,
  resultObserved?: () => boolean,
): Promise<
  | { ok: true }
  | { ok: false; message: string; automaticRetry: false }
> {
  const deadline = performance.now() + SEND_ACCEPT_TIMEOUT_MS;
  let sawComposer = false;

  while (performance.now() < deadline) {
    const observed = resultObserved?.() ?? false;
    if (observed) {
      clearDeliveredResultResidue(sourceResult);
      return { ok: true };
    }
    const current = findComposer();
    if (!current) {
      await delay(80);
      continue;
    }
    sawComposer = true;

    const decision = composerSendAcceptanceDecision(
      expectedComposerText,
      composerText(current),
      sourceResult,
      observed,
    );
    if (decision === "accepted") return { ok: true };
    if (decision === "changed") {
      return {
        ok: false,
        automaticRetry: false,
        message:
          "Result queued — the composer changed after Kavrith clicked Send, so delivery could not be confirmed. Check the chat, then use Send result if needed.",
      };
    }
    await delay(80);
  }

  return {
    ok: false,
    automaticRetry: false,
    message: sawComposer
      ? "Result queued — Kavrith clicked Send but ChatGPT did not confirm delivery. The result was kept queued; use Send result to retry."
      : "Result queued — ChatGPT's composer disappeared after Kavrith clicked Send, so delivery could not be confirmed. Check the chat, then use Send result if needed.",
  };
}

function dispatchInput(composer: Composer, value: string): void {
  composer.dispatchEvent(
    new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: value,
    }),
  );
  composer.dispatchEvent(new Event("change", { bubbles: true }));
}

function resyncComposerState(composer: Composer): void {
  composer.focus();
  dispatchInput(composer, composerText(composer));
}

function writeTextarea(composer: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  if (!setter) throw new Error("Unable to update the ChatGPT composer");
  setter.call(composer, value);
}

function writeComposer(composer: Composer, value: string): void {
  if (composer instanceof HTMLTextAreaElement) {
    writeTextarea(composer, value);
  } else {
    composer.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(composer);
    selection?.removeAllRanges();
    selection?.addRange(range);
    if (!document.execCommand("insertText", false, value)) {
      composer.textContent = value;
    }
  }
  dispatchInput(composer, value);
}

function appendToComposer(
  composer: Composer,
  result: string,
): { ok: true } | { ok: false; message: string } {
  const existing = composerText(composer);
  const value =
    existing.trim().length === 0 ? result : `${existing}\n\n${result}`;
  try {
    writeComposer(composer, value);
    composer.focus();
    return { ok: true };
  } catch (cause) {
    return {
      ok: false,
      message: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

export async function sendToChatGPT(
  result: string,
  resultObserved?: () => boolean,
): Promise<
  | { ok: true }
  | { ok: false; message: string; automaticRetry?: boolean }
> {
  let composer = await waitForStableComposer();
  if (!composer) {
    return {
      ok: false,
      message:
        "Result queued — ChatGPT's composer isn't ready. Try Send result again.",
    };
  }
  const original = composerText(composer);
  const resultAlreadyPresent = composerMatchesExpected(result, original);
  if (original.trim().length > 0 && !resultAlreadyPresent) {
    return composerOwnershipFailure(
      "ChatGPT composer contains a draft. Kavrith left it untouched; send the result after finishing your message.",
    );
  }

  let userEdited = false;
  let kavrithWriting = false;
  const onUserEditIntent = (event: Event): void => {
    if (!event.isTrusted) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.matches(COMPOSER_SELECTOR) || target.closest(COMPOSER_SELECTOR)) {
      userEdited = true;
    }
  };
  for (const type of USER_EDIT_EVENTS) {
    document.addEventListener(type, onUserEditIntent as EventListener, true);
  }

  let expectedComposerText = resultAlreadyPresent ? original : "";
  let lastComposerWriteAt = resultAlreadyPresent ? 0 : performance.now();
  const writeResult = (
    target: Composer,
  ): { ok: true } | { ok: false; message: string } => {
    kavrithWriting = true;
    try {
      const insertion = appendToComposer(target, result);
      if (insertion.ok) {
        // ChatGPT's rich editor may normalize the raw string as it is inserted.
        // Treat the text we immediately read back from the live composer as the
        // canonical Kavrith insertion for subsequent remount/change detection.
        expectedComposerText = composerText(target);
        lastComposerWriteAt = performance.now();
      }
      return insertion;
    } finally {
      kavrithWriting = false;
    }
  };

  try {
    if (!resultAlreadyPresent) {
      const insertion = writeResult(composer);
      if (!insertion.ok) return insertion;
    }

    const deliveryStartedAt = performance.now();
    const deadline = deliveryStartedAt + SEND_READY_TIMEOUT_MS;
    let emptyComposer: Composer | undefined;
    let emptySince = 0;
    let lastResync = performance.now();
    let lastComposer = composer;
    let composerRemounts = 0;
    let reinsertions = 0;
    let resyncs = 0;

    while (performance.now() < deadline) {
      const currentComposer = findComposer();
      if (!currentComposer) {
        emptyComposer = undefined;
        emptySince = 0;
        await waitForDeliveryPoll(deliveryStartedAt);
        continue;
      }

      if (currentComposer !== lastComposer) {
        composerRemounts += 1;
        lastComposer = currentComposer;
      }
      composer = currentComposer;
      const recovery = composerRecoveryDecision(
        expectedComposerText,
        composerText(composer),
        userEdited,
        result,
      );
      if (recovery === "abort") {
        return composerRecoveryFailure(
          "Result queued — ChatGPT changed the composer before Kavrith could send it.",
          userEdited,
        );
      }
      if (recovery === "reinsert") {
        const now = performance.now();
        if (emptyComposer !== composer) {
          emptyComposer = composer;
          emptySince = now;
          await waitForDeliveryPoll(deliveryStartedAt);
          continue;
        }
        if (now - emptySince < COMPOSER_STABLE_MS) {
          await waitForDeliveryPoll(deliveryStartedAt);
          continue;
        }
        const reinsertion = writeResult(composer);
        if (!reinsertion.ok) return reinsertion;
        reinsertions += 1;
        emptyComposer = undefined;
        emptySince = 0;
      } else {
        emptyComposer = undefined;
        emptySince = 0;
      }

      const send = findSendButton(composer);
      const now = performance.now();
      if (
        send &&
        (lastComposerWriteAt === 0 ||
          now - lastComposerWriteAt >= COMPOSER_STABLE_MS)
      ) {
        // The contenteditable DOM can change before ChatGPT's internal editor
        // state catches up. Clicking Send in the same task as insertion can
        // clear the visible composer without creating a user turn. Give the
        // application one stable window after every write/reinsertion first.
        send.click();
        return await waitForSendAcceptance(
          expectedComposerText,
          result,
          resultObserved,
        );
      }

      if (
        recovery === "keep" &&
        !userEdited &&
        now - lastResync >= COMPOSER_RESYNC_MS
      ) {
        // ChatGPT can mount the visible rich editor before its application
        // listeners are fully ready. Re-announce the unchanged editor value so
        // a late-attached listener can synchronize state and enable Send.
        resyncComposerState(composer);
        lastResync = now;
        lastComposerWriteAt = now;
        resyncs += 1;
      }

      await waitForDeliveryPoll(deliveryStartedAt);
    }

    const finalComposer = findComposer() ?? composer;
    const finalRecovery = composerRecoveryDecision(
      expectedComposerText,
      composerText(finalComposer),
      userEdited,
      result,
    );
    if (finalRecovery === "abort") {
      return composerRecoveryFailure(
        "Result queued — ChatGPT changed the composer before Kavrith could send it.",
        userEdited,
      );
    }

    // Sending failed after Kavrith inserted the result. Roll back only if the
    // active composer still contains exactly our insertion; never overwrite
    // user edits. If ChatGPT already reset it to empty, there is nothing to undo.
    if (
      finalRecovery === "keep" &&
      composerRollbackDecision(
        original,
        expectedComposerText,
        composerText(finalComposer),
      ) === "restore"
    ) {
      try {
        kavrithWriting = true;
        writeComposer(finalComposer, original);
      } catch {
        return {
          ok: false,
          message: "Result queued — ChatGPT wasn't ready to send it.",
        };
      } finally {
        kavrithWriting = false;
      }
    }

    return {
      ok: false,
      message:
        `Result queued — ChatGPT's send control never became ready after ${Math.round(
          (performance.now() - deliveryStartedAt) / 1_000,
        )}s (composer remounts: ${composerRemounts}, reinserts: ${reinsertions}, resyncs: ${resyncs}). Use Send result to retry.`,
    };
  } finally {
    for (const type of USER_EDIT_EVENTS) {
      document.removeEventListener(
        type,
        onUserEditIntent as EventListener,
        true,
      );
    }
  }
}
