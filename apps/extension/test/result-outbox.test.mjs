import assert from "node:assert/strict";
import test from "node:test";
import {
  enqueueResult,
  pendingResult,
  removeResult,
  resultAllowsAutomaticRetry,
  withResultAutomaticRetry,
} from "../dist-test/lib/result-outbox.js";

test("outbox persists completed results until delivery", () => {
  let outbox = {};
  outbox = enqueueResult(outbox, "chat", "directive", "result", 1);
  assert.equal(pendingResult(outbox, "chat", "directive")?.result, "result");
  outbox = removeResult(outbox, "chat", "directive");
  assert.equal(pendingResult(outbox, "chat", "directive"), undefined);
});

test("removing one result preserves other queued results", () => {
  let outbox = {};
  outbox = enqueueResult(outbox, "chat", "a", "one", 1);
  outbox = enqueueResult(outbox, "chat", "b", "two", 2);
  outbox = removeResult(outbox, "chat", "a");
  assert.equal(pendingResult(outbox, "chat", "b")?.result, "two");
});

test("outbox persists manual-only delivery policy", () => {
  let outbox = enqueueResult({}, "chat", "directive", "result", 1);
  outbox = withResultAutomaticRetry(outbox, "chat", "directive", false);
  assert.equal(
    pendingResult(outbox, "chat", "directive")?.automaticRetry,
    false,
  );
});

test("new results opt into automatic retry", () => {
  const entry = pendingResult(
    enqueueResult({}, "chat", "directive", "result", 1),
    "chat",
    "directive",
  );
  assert.equal(resultAllowsAutomaticRetry(entry), true);
});

test("legacy results without retry policy stay manual-only", () => {
  assert.equal(
    resultAllowsAutomaticRetry({
      directiveId: "directive",
      result: "result",
      createdAt: 1,
    }),
    false,
  );
});
