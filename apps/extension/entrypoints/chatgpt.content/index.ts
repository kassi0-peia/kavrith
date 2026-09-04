import { syncKavrithSessionForCurrentPage } from "../../lib/kavrith-session";
import { deferredPrimeDecision } from "../../lib/directive-stability";
import { ensureChatInitializer } from "./initializer";
import {
  assistantMessageForNode,
  inspect,
  primeExistingDirectives,
  restoreQueuedResults,
} from "./directive-processing";

export default defineContentScript({
  matches: ["https://chatgpt.com/*"],
  runAt: "document_idle",
  main() {
    let activeSessionId: string | undefined;
    let lastSessionHref = location.href;
    let pendingInitialPrime = false;
    let rescanTimer: number | undefined;
    let observedConversationRoot: Element | undefined;
    const pendingAssistantMessages = new Set<HTMLElement>();

    const conversationRoot = (): Element | undefined => {
      const composer = document.querySelector<HTMLElement>("#prompt-textarea");
      const assistantMessage = document.querySelector<HTMLElement>(
        "[data-message-author-role='assistant']",
      );
      return (
        composer?.closest("main,[role='main']") ??
        assistantMessage?.closest("main,[role='main']") ??
        document.querySelector("main,[role='main']") ??
        undefined
      );
    };

    const assistantIsGenerating = (): boolean => {
      const selectors = [
        "button[data-testid='stop-button']",
        "button[aria-label^='Stop']",
      ];
      return selectors.some((selector) =>
        [...document.querySelectorAll<HTMLElement>(selector)].some(
          (button) => button.getClientRects().length > 0,
        ),
      );
    };

    const scheduleRescan = (delay: number): void => {
      if (rescanTimer !== undefined) {
        window.clearTimeout(rescanTimer);
      }
      rescanTimer = window.setTimeout(scanWhenStable, delay);
    };

    const syncSession = async (): Promise<void> => {
      const sessionId = await syncKavrithSessionForCurrentPage();
      lastSessionHref = location.href;
      if (activeSessionId !== sessionId) {
        activeSessionId = sessionId;
        pendingInitialPrime = true;
        await restoreQueuedResults();

        const decision = deferredPrimeDecision(
          pendingInitialPrime,
          assistantIsGenerating(),
        );
        if (decision === "prime") {
          primeExistingDirectives();
          pendingInitialPrime = false;
        } else if (decision === "wait") {
          scheduleRescan(1_000);
        }
      }
      // The ChatGPT composer can mount after document_idle. Retry rendering on
      // later DOM mutations even when the logical Kavrith session is unchanged.
      ensureChatInitializer();
    };

    const nodeTouchesCodeBlock = (node: Node): boolean => {
      const element = node instanceof Element ? node : node.parentElement;
      if (!element) return false;
      return Boolean(
        element.closest("pre") ||
          (element instanceof HTMLElement &&
            element.querySelector("pre") !== null),
      );
    };

    const nodeTouchesComposer = (node: Node): boolean => {
      const element = node instanceof Element ? node : node.parentElement;
      if (!element) return false;
      return Boolean(
        element.matches?.("#prompt-textarea") ||
          (element instanceof HTMLElement &&
            element.querySelector("#prompt-textarea") !== null),
      );
    };

    async function scanWhenStable(): Promise<void> {
      rescanTimer = undefined;
      if (assistantIsGenerating()) {
        scheduleRescan(1_000);
        return;
      }

      await syncSession();

      if (deferredPrimeDecision(pendingInitialPrime, false) === "prime") {
        primeExistingDirectives();
        pendingInitialPrime = false;
      }

      for (const message of pendingAssistantMessages) {
        inspect(message);
      }
      pendingAssistantMessages.clear();
    }

    void syncSession();

    const observer = new MutationObserver((records) => {
      const changedAssistantMessages = new Set<HTMLElement>();
      let composerChanged = false;

      for (const record of records) {
        if (record.type === "characterData") {
          if (nodeTouchesCodeBlock(record.target)) {
            const message = assistantMessageForNode(record.target);
            if (message) changedAssistantMessages.add(message);
          }
        }

        for (const node of record.addedNodes) {
          if (nodeTouchesComposer(node)) composerChanged = true;

          if (nodeTouchesCodeBlock(node)) {
            const message = assistantMessageForNode(node);
            if (message) changedAssistantMessages.add(message);
          }
        }
      }

      if (composerChanged) {
        // Reposition/recreate Kavrith when ChatGPT replaces the composer without
        // paying for another conversation/session lookup.
        ensureChatInitializer();
      }

      if (changedAssistantMessages.size === 0) return;

      for (const message of changedAssistantMessages) {
        pendingAssistantMessages.add(message);
      }

      scheduleRescan(1_200);
    });

    const ensureConversationObserver = (): void => {
      const root = conversationRoot();
      if (
        root === observedConversationRoot &&
        observedConversationRoot?.isConnected
      ) {
        return;
      }

      observer.disconnect();
      observedConversationRoot = root;
      if (!root) return;

      observer.observe(root, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    };

    ensureConversationObserver();

    // Avoid observing all of documentElement merely to discover SPA navigation
    // or a remounted conversation root. This cheap identity check keeps sidebar,
    // menus, tooltips, and unrelated React hydration out of Kavrith's observer.
    window.setInterval(() => {
      ensureConversationObserver();
      if (location.href !== lastSessionHref) void syncSession();
    }, 1_000);
  },
});
