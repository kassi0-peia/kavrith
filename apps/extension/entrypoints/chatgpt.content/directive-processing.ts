import { getChatInitialization } from "../../lib/chat-initialization";
import { kavrithSessionId } from "../../lib/kavrith-session";
import { createControls } from "./result-ui";
import {
  directiveId,
  getDirectiveState,
  parseDirective,
  setDirectiveState,
} from "./directive-scanner";
import {
  addComposerAction,
  getOutbox,
  reconcileObservedQueuedResult,
  resumeQueuedResult,
  returnResultToChatGPT,
} from "./result-delivery";
import {
  addExecAction,
  addPatchAction,
  addRunAction,
} from "./mutation-actions";
import {
  addContextAction,
  addGitAction,
  addReadAction,
  addSearchAction,
} from "./inspection-actions";
import {
  pendingResult,
  resultAllowsAutomaticRetry,
} from "../../lib/result-outbox";
import {
  directiveCodeContent,
  directiveCodeSnapshot,
  directiveSnapshotReadyForParsing,
  isUnprocessedCodeBlock,
} from "../../lib/chatgpt-code-block";
import { kavrithDirectiveParseError } from "../../lib/chatgpt-directive-error";

const PROCESSED_ATTRIBUTE = "data-kavrith-action";
const CLAIMING_ATTRIBUTE = "data-kavrith-claiming";
const ASSISTANT_CODE_SELECTOR = "[data-message-author-role='assistant'] pre";
const CODE_TEXT_REQUEST_EVENT = "kavrith:code-text-request";
const CODE_TEXT_RESPONSE_EVENT = "kavrith:code-text-response";
const CODE_READER_ID_ATTRIBUTE = "data-kavrith-code-reader-id";
const renderedActions = new WeakMap<HTMLElement, HTMLElement[]>();
const claimedMalformedDirectives = new Set<string>();
const fullTextRetryAttempts = new WeakMap<HTMLElement, number>();
const fullTextRetryTimers = new WeakMap<HTMLElement, number>();
const MAX_FULL_TEXT_RETRY_ATTEMPTS = 5;
const STARTUP_PRIME_BATCH_SIZE = 4;
let startupPrimeGeneration = 0;

function fullDirectiveCodeText(pre: HTMLElement) {
  const requestId = crypto.randomUUID();
  pre.setAttribute(CODE_READER_ID_ATTRIBUTE, requestId);
  let fullText: string | undefined;
  const onResponse = (event: Event): void => {
    if (!(event instanceof CustomEvent) || typeof event.detail !== "string") {
      return;
    }
    try {
      const response = JSON.parse(event.detail) as {
        requestId?: unknown;
        text?: unknown;
      };
      if (response.requestId !== requestId) return;
      if (typeof response.text === "string") fullText = response.text;
    } catch {
      // Ignore malformed page-world responses and use the DOM fallback.
    }
  };

  window.addEventListener(CODE_TEXT_RESPONSE_EVENT, onResponse);
  window.dispatchEvent(
    new CustomEvent(CODE_TEXT_REQUEST_EVENT, { detail: requestId }),
  );
  window.removeEventListener(CODE_TEXT_RESPONSE_EVENT, onResponse);
  if (pre.getAttribute(CODE_READER_ID_ATTRIBUTE) === requestId) {
    pre.removeAttribute(CODE_READER_ID_ATTRIBUTE);
  }
  return directiveCodeSnapshot(pre, fullText);
}

function clearFullTextRetry(pre: HTMLElement): void {
  const timer = fullTextRetryTimers.get(pre);
  if (timer !== undefined) window.clearTimeout(timer);
  fullTextRetryTimers.delete(pre);
  fullTextRetryAttempts.delete(pre);
}

function retryWhenFullTextIsReady(
  pre: HTMLElement,
  retry: () => void,
): boolean {
  if (fullTextRetryTimers.has(pre)) return true;
  const attempt = fullTextRetryAttempts.get(pre) ?? 0;
  if (attempt >= MAX_FULL_TEXT_RETRY_ATTEMPTS) return false;
  const delay = Math.min(200 * 2 ** Math.min(attempt, 5), 5_000);
  fullTextRetryAttempts.set(pre, attempt + 1);
  fullTextRetryTimers.set(
    pre,
    window.setTimeout(() => {
      fullTextRetryTimers.delete(pre);
      if (pre.isConnected) retry();
    }, delay),
  );
  return true;
}

export function assistantMessageForNode(node: Node): HTMLElement | undefined {
  const element = node instanceof HTMLElement ? node : node.parentElement;

  return (
    element?.closest<HTMLElement>("[data-message-author-role='assistant']") ??
    undefined
  );
}

function registerAction(code: HTMLElement, ...elements: HTMLElement[]): void {
  for (const element of renderedActions.get(code) ?? []) element.remove();
  renderedActions.set(code, elements);
}

type MutationDirective = Extract<
  ReturnType<typeof parseDirective>,
  { type: "exec" | "run" | "patch" }
>;

function isMutationDirective(
  directive: ReturnType<typeof parseDirective>,
): directive is MutationDirective {
  return (
    directive?.type === "exec" ||
    directive?.type === "run" ||
    directive?.type === "patch"
  );
}

function addMutationAction(
  code: HTMLElement,
  directive: MutationDirective,
  identity: string,
  pending: boolean,
): void {
  const dependencies = { currentTaskRoot, registerAction };
  switch (directive.type) {
    case "exec":
      addExecAction(code, directive.request, identity, pending, dependencies);
      break;
    case "run":
      addRunAction(code, directive.request, identity, pending, dependencies);
      break;
    case "patch":
      addPatchAction(code, directive.request, identity, pending, dependencies);
      break;
  }
}

async function handleMalformedDirective(
  pre: HTMLElement,
  code: HTMLElement,
  text: string,
): Promise<boolean> {
  const parseError = kavrithDirectiveParseError(text);
  if (!parseError) return false;

  const identity = directiveId(code, `invalid-${parseError.type}`, text);
  pre.setAttribute(PROCESSED_ATTRIBUTE, "true");

  if (identity) {
    if (claimedMalformedDirectives.has(identity)) {
      return true;
    }
    claimedMalformedDirectives.add(identity);

    if ((await getDirectiveState(identity)) !== undefined) {
      return true;
    }

    await setDirectiveState(identity, "failed");
  }

  const controls = createControls();
  const status = document.createElement("span");
  status.textContent = parseError.message;
  status.style.cssText =
    "display:block;margin-top:8px;color:#dc2626;font:12px/1.45 system-ui,sans-serif;white-space:pre-wrap;";
  controls.hidden = false;
  controls.append(status);
  pre.append(controls);
  registerAction(code, controls);

  if (identity) {
    const result = [
      "<kavrith_error>",
      `operation: directive.parse.${parseError.type}`,
      `message: ${parseError.message}`,
      "</kavrith_error>",
    ].join("\n");
    void returnResultToChatGPT(controls, identity, result);
  }

  return true;
}

async function primeMalformedDirective(
  pre: HTMLElement,
  code: HTMLElement,
  text: string,
): Promise<boolean> {
  const parseError = kavrithDirectiveParseError(text);
  if (!parseError) return false;

  const identity = directiveId(code, `invalid-${parseError.type}`, text);
  pre.setAttribute(PROCESSED_ATTRIBUTE, "true");

  if (!identity) return true;
  claimedMalformedDirectives.add(identity);
  if ((await getDirectiveState(identity)) === undefined) {
    await setDirectiveState(identity, "failed");
  }

  return true;
}

async function currentTaskRoot(): Promise<string> {
  const sessionId = kavrithSessionId();
  const initialization = await getChatInitialization(sessionId);
  if (!initialization)
    throw new Error("Kavrith is not initialized for this chat");
  return initialization.rootPath;
}

export async function restoreQueuedResults(): Promise<void> {
  const sessionId = kavrithSessionId();
  const outbox = await getOutbox();
  const entries = Object.values(outbox[sessionId] ?? {});
  if (entries.length === 0) return;

  const codes = document.querySelectorAll<HTMLElement>(ASSISTANT_CODE_SELECTOR);
  for (const pre of codes) {
    const code = directiveCodeContent(pre) as HTMLElement | undefined;
    const snapshot = fullDirectiveCodeText(pre);
    const text = snapshot.text;
    if (!code || text === undefined) continue;
    if (!directiveSnapshotReadyForParsing(snapshot)) {
      retryWhenFullTextIsReady(pre, () => void restoreQueuedResults());
      continue;
    }
    const directive = parseDirective(text);
    const parseError = directive ? undefined : kavrithDirectiveParseError(text);
    if (
      !directive &&
      parseError &&
      retryWhenFullTextIsReady(pre, () => void restoreQueuedResults())
    ) {
      continue;
    }
    clearFullTextRetry(pre);
    const identity = directive
      ? directiveId(code, directive.type, text)
      : parseError
        ? directiveId(code, `invalid-${parseError.type}`, text)
        : undefined;
    if (!identity) continue;
    const queued = pendingResult(outbox, sessionId, identity);
    if (!queued) continue;
    if (await reconcileObservedQueuedResult(identity, queued.result)) {
      pre.setAttribute(PROCESSED_ATTRIBUTE, "true");
      continue;
    }

    const controls = createControls();
    addComposerAction(
      controls,
      identity,
      queued.result,
      resultAllowsAutomaticRetry(queued)
        ? "Kavrith result is queued and retrying automatically."
        : "Kavrith result is queued for manual delivery.",
    );
    if (resultAllowsAutomaticRetry(queued)) {
      resumeQueuedResult(identity, queued.result);
    }
    pre.append(controls);
    registerAction(code, controls);
  }
}

export function inspect(root: ParentNode): void {
  if (
    root instanceof HTMLElement &&
    !root.matches("pre") &&
    !root.querySelector("pre")
  )
    return;
  const codes: HTMLElement[] = [];
  if (root instanceof HTMLElement && root.matches(ASSISTANT_CODE_SELECTOR))
    codes.push(root);
  codes.push(...root.querySelectorAll<HTMLElement>(ASSISTANT_CODE_SELECTOR));
  for (const pre of codes) {
    if (!isUnprocessedCodeBlock(pre, PROCESSED_ATTRIBUTE, CLAIMING_ATTRIBUTE))
      continue;

    const code = directiveCodeContent(pre) as HTMLElement | undefined;
    const snapshot = fullDirectiveCodeText(pre);
    const text = snapshot.text;
    if (!code || text === undefined) continue;
    if (!directiveSnapshotReadyForParsing(snapshot)) {
      retryWhenFullTextIsReady(pre, () => inspect(pre));
      continue;
    }
    const directive = parseDirective(text);
    if (!directive) {
      const parseError = kavrithDirectiveParseError(text);
      if (parseError && retryWhenFullTextIsReady(pre, () => inspect(pre)))
        continue;
      clearFullTextRetry(pre);
      void handleMalformedDirective(pre, code, text);
      continue;
    }
    clearFullTextRetry(pre);

    const identity = directiveId(code, directive.type, text);
    if (!identity) continue;

    pre?.setAttribute(CLAIMING_ATTRIBUTE, "true");
    void getDirectiveState(identity).then(
      async (state) => {
        pre?.removeAttribute(CLAIMING_ATTRIBUTE);
        if (state !== undefined) {
          if (state === "pending" && isMutationDirective(directive)) {
            addMutationAction(code, directive, identity, true);
            return;
          }
          pre?.setAttribute(PROCESSED_ATTRIBUTE, "true");
          return;
        }
        await setDirectiveState(identity, "discovered");
        switch (directive.type) {
          case "context":
            addContextAction(code, directive.request, identity, {
              currentTaskRoot,
              registerAction,
            });
            break;
          case "exec":
          case "run":
          case "patch":
            addMutationAction(code, directive, identity, false);
            break;
          case "git-status":
            addGitAction(code, "status", identity, false, {
              currentTaskRoot,
              registerAction,
            });
            break;
          case "git-diff":
            addGitAction(code, "diff", identity, directive.request.staged, {
              currentTaskRoot,
              registerAction,
            });
            break;
          case "read":
            addReadAction(
              code,
              directive.request.path,
              directive.request.startLine,
              directive.request.endLine,
              identity,
              {
                currentTaskRoot,
                registerAction,
              },
            );
            break;
          case "search":
            addSearchAction(code, directive.request, identity, {
              currentTaskRoot,
              registerAction,
            });
            break;
        }
      },
      () => {
        pre?.removeAttribute(CLAIMING_ATTRIBUTE);
      },
    );
  }
}

function primeExistingDirective(pre: HTMLElement): void {
  if (
    !pre.isConnected ||
    !isUnprocessedCodeBlock(pre, PROCESSED_ATTRIBUTE, CLAIMING_ATTRIBUTE)
  )
    return;

  const code = directiveCodeContent(pre) as HTMLElement | undefined;
  const snapshot = fullDirectiveCodeText(pre);
  const text = snapshot.text;
  if (!code || text === undefined) return;
  if (!directiveSnapshotReadyForParsing(snapshot)) {
    retryWhenFullTextIsReady(pre, () => primeExistingDirective(pre));
    return;
  }
  const directive = parseDirective(text);
  if (!directive) {
    const parseError = kavrithDirectiveParseError(text);
    if (
      parseError &&
      retryWhenFullTextIsReady(pre, () => primeExistingDirective(pre))
    )
      return;
    clearFullTextRetry(pre);
    void primeMalformedDirective(pre, code, text);
    return;
  }
  clearFullTextRetry(pre);

  const identity = directiveId(code, directive.type, text);
  if (!identity) return;

  if (isMutationDirective(directive)) {
    pre.setAttribute(CLAIMING_ATTRIBUTE, "true");
    void getDirectiveState(identity).then(
      (state) => {
        pre.removeAttribute(CLAIMING_ATTRIBUTE);
        if (state !== "pending") {
          pre.setAttribute(PROCESSED_ATTRIBUTE, "true");
          return;
        }
        addMutationAction(code, directive, identity, true);
      },
      () => {
        pre.removeAttribute(CLAIMING_ATTRIBUTE);
      },
    );
    return;
  }

  pre.setAttribute(CLAIMING_ATTRIBUTE, "true");
  void setDirectiveState(identity, "completed").then(
    () => {
      pre.removeAttribute(CLAIMING_ATTRIBUTE);
      pre.setAttribute(PROCESSED_ATTRIBUTE, "true");
    },
    () => {
      pre.removeAttribute(CLAIMING_ATTRIBUTE);
    },
  );
}

export function primeExistingDirectives(): void {
  const generation = ++startupPrimeGeneration;
  const codes = document.querySelectorAll<HTMLElement>(ASSISTANT_CODE_SELECTOR);
  let index = 0;

  const processBatch = (): void => {
    // A later navigation/session prime supersedes this historical sweep.
    if (generation !== startupPrimeGeneration) return;

    const end = Math.min(index + STARTUP_PRIME_BATCH_SIZE, codes.length);
    for (; index < end; index += 1) {
      const pre = codes[index];
      if (pre) primeExistingDirective(pre);
    }

    if (index < codes.length && generation === startupPrimeGeneration) {
      // Historical discovery is background maintenance. Yield after a tiny
      // batch so clicks, typing, painting, and ChatGPT itself get main-thread
      // time even in conversations containing hundreds of code blocks.
      window.setTimeout(processBatch, 0);
    }
  };

  // Do not begin a potentially huge historical sweep inside the same task
  // that initializes the composer. Give browser input/rendering a turn first.
  window.setTimeout(processBatch, 0);
}
