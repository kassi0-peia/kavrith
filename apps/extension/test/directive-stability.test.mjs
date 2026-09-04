import assert from "node:assert/strict";
import test from "node:test";
import { deferredPrimeDecision } from "../dist-test/lib/directive-stability.js";
import {
  isKavrithResultText,
  missingDirectiveRecoveryDecision,
} from "../dist-test/lib/missing-directive-recovery.js";

test("deferred startup priming waits while the assistant is generating", () => {
  assert.equal(deferredPrimeDecision(true, true), "wait");
});

test("deferred startup priming runs after generation finishes", () => {
  assert.equal(deferredPrimeDecision(true, false), "prime");
});

test("startup priming stays idle when nothing is pending", () => {
  assert.equal(deferredPrimeDecision(false, false), "idle");
});


test("missing-directive recovery waits for a finished new assistant turn", () => {
  assert.equal(missingDirectiveRecoveryDecision({
    pending: true,
    assistantGenerating: true,
    hasNewAssistantTurn: true,
    assistantTurnSettled: true,
    hasVisibleDirective: false,
  }), "wait");

  assert.equal(missingDirectiveRecoveryDecision({
    pending: true,
    assistantGenerating: false,
    hasNewAssistantTurn: false,
    assistantTurnSettled: true,
    hasVisibleDirective: false,
  }), "wait");
});

test("missing-directive recovery clears when a visible directive appears", () => {
  assert.equal(missingDirectiveRecoveryDecision({
    pending: true,
    assistantGenerating: false,
    hasNewAssistantTurn: true,
    assistantTurnSettled: true,
    hasVisibleDirective: true,
  }), "clear");
});

test("missing-directive recovery reminds once when the reply has no directive", () => {
  assert.equal(missingDirectiveRecoveryDecision({
    pending: true,
    assistantGenerating: false,
    hasNewAssistantTurn: true,
    assistantTurnSettled: true,
    hasVisibleDirective: false,
  }), "remind");

  assert.equal(missingDirectiveRecoveryDecision({
    pending: false,
    assistantGenerating: false,
    hasNewAssistantTurn: true,
    assistantTurnSettled: true,
    hasVisibleDirective: false,
  }), "idle");
});

test("missing-directive recovery recognizes only Kavrith result turns", () => {
  assert.equal(
    isKavrithResultText("<kavrith_result>\nstatus: ok\n</kavrith_result>"),
    true,
  );
  assert.equal(
    isKavrithResultText("<kavrith_error>\nmessage: nope\n</kavrith_error>"),
    true,
  );
  assert.equal(isKavrithResultText("ordinary user message"), false);
});
