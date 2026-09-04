import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_CHATGPT_RESULT_CHARS,
  resultForChatGPTDelivery,
} from "../dist-test/lib/result-delivery-payload.js";

test("small Kavrith results are delivered unchanged", () => {
  const result = "<kavrith_result>\nstatus: ok\n</kavrith_result>";
  assert.equal(resultForChatGPTDelivery(result), result);
});

test("large Kavrith results keep their beginning and end within the delivery cap", () => {
  const result =
    "<kavrith_result>\nBEGIN\n" +
    "x".repeat(MAX_CHATGPT_RESULT_CHARS * 2) +
    "\nEND\n</kavrith_result>";

  const delivered = resultForChatGPTDelivery(result);

  assert.equal(delivered.length, MAX_CHATGPT_RESULT_CHARS);
  assert.ok(delivered.startsWith("<kavrith_result>\nBEGIN\n"));
  assert.ok(delivered.endsWith("\nEND\n</kavrith_result>"));
  assert.match(delivered, /<kavrith_delivery_truncation original_chars="\d+"/);
});

test("delivery truncation is deterministic for retries and observation matching", () => {
  const result = "head\n" + "payload".repeat(10_000) + "\ntail";
  assert.equal(
    resultForChatGPTDelivery(result),
    resultForChatGPTDelivery(result),
  );
});
