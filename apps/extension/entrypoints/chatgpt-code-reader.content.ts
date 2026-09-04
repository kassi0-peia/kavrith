import { preferredCodeMirrorDocumentText } from "../lib/chatgpt-code-block";

type CodeMirrorDoc = {
  toString(): string;
};

type CodeMirrorContent = HTMLElement & {
  cmTile?: {
    view?: {
      state?: {
        doc?: CodeMirrorDoc;
      };
    };
  };
};

const REQUEST_EVENT = "kavrith:code-text-request";
const RESPONSE_EVENT = "kavrith:code-text-response";
const BLOCK_ID_ATTRIBUTE = "data-kavrith-code-reader-id";
const READONLY_TEXTBOX_SELECTOR = '[role="textbox"][aria-readonly="true"]';

export default defineContentScript({
  matches: ["https://chatgpt.com/*"],
  world: "MAIN",
  runAt: "document_start",
  main() {
    window.addEventListener(REQUEST_EVENT, (event) => {
      if (!(event instanceof CustomEvent)) return;
      const requestId =
        typeof event.detail === "string" ? event.detail : undefined;
      if (!requestId) return;

      const pre = document.querySelector<HTMLElement>(
        `pre[${BLOCK_ID_ATTRIBUTE}="${CSS.escape(requestId)}"]`,
      );
      const contents = pre
        ? [...pre.querySelectorAll<CodeMirrorContent>(READONLY_TEXTBOX_SELECTOR)]
        : [];
      const documents = contents
        .map((content) => content.cmTile?.view?.state?.doc?.toString())
        .filter((text): text is string => typeof text === "string");
      const text = preferredCodeMirrorDocumentText(documents);

      window.dispatchEvent(
        new CustomEvent(RESPONSE_EVENT, {
          detail: JSON.stringify({
            requestId,
            ...(typeof text === "string" ? { text } : {}),
          }),
        }),
      );
    });
  },
});
