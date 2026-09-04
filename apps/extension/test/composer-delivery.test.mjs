import assert from "node:assert/strict";
import test from "node:test";
import {
  composerMatchesExpected,
  composerOwnershipFailure,
  composerRecoveryFailure,
  composerRecoveryDecision,
  composerRollbackDecision,
  composerSendAcceptanceDecision,
  firstUsableCandidate,
  userTurnContainsDeliveredResult,
} from "../dist-test/lib/composer-delivery.js";

test("composer ownership failures never auto-retry", () => {
  assert.deepEqual(composerOwnershipFailure("changed"), {
    ok: false,
    message: "changed",
    automaticRetry: false,
  });
});

test("untrusted composer churn remains automatically retryable", () => {
  assert.deepEqual(composerRecoveryFailure("changed", false), {
    ok: false,
    message: "changed",
  });
});

test("trusted user editing makes composer recovery manual-only", () => {
  assert.deepEqual(composerRecoveryFailure("changed", true), {
    ok: false,
    message: "changed",
    automaticRetry: false,
  });
});

test("failed delivery restores an untouched Kavrith insertion", () => {
  assert.equal(
    composerRollbackDecision("", "queued result", "queued result"),
    "restore",
  );
});

test("editor whitespace normalization still restores Kavrith insertion", () => {
  assert.equal(
    composerRollbackDecision("", "queued result\n", "queued result\n\n"),
    "restore",
  );
});

test("failed delivery never overwrites user edits made after insertion", () => {
  assert.equal(
    composerRollbackDecision(
      "",
      "queued result",
      "queued result plus user typing",
    ),
    "leave-user-changes",
  );
});

test("rollback does not erase pre-existing composer content", () => {
  assert.equal(
    composerRollbackDecision("draft", "draft", "draft"),
    "leave-user-changes",
  );
});

test("send selection skips an unusable first match", () => {
  const candidates = [
    { id: "hidden", usable: false },
    { id: "visible", usable: true },
  ];
  assert.equal(
    firstUsableCandidate(candidates, (candidate) => candidate.usable)?.id,
    "visible",
  );
});

test("delivery keeps an intact Kavrith insertion", () => {
  assert.equal(
    composerRecoveryDecision("queued result", "queued result", false),
    "keep",
  );
});

test("retry recognizes a queued Kavrith result already in the composer", () => {
  assert.equal(
    composerMatchesExpected(
      "<kavrith_result>\nresult\n</kavrith_result>",
      "<kavrith_result>\nresult\n</kavrith_result>\n",
    ),
    true,
  );
});

test("retry tolerates delayed rich-editor whitespace normalization", () => {
  assert.equal(
    composerMatchesExpected(
      "<kavrith_result>\nline one\nline two\n</kavrith_result>",
      "<kavrith_result> line one   line two </kavrith_result>",
    ),
    true,
  );
});

test("retry ignores invisible rich-editor formatting marks", () => {
  assert.equal(
    composerMatchesExpected(
      "<kavrith_result>root: /tmp/repo status: clean</kavrith_result>",
      "\u200b<kavrith_result>root: /tmp/repo\u2060 status: clean</kavrith_result>\ufeff",
    ),
    true,
  );
});

test("invisible-mark normalization does not hide real user edits", () => {
  assert.equal(
    composerRecoveryDecision(
      "<kavrith_result>result</kavrith_result>",
      "\u200b<kavrith_result>result</kavrith_result> my draft",
      false,
    ),
    "abort",
  );
});

test("observed user turn confirms an exact Kavrith result", () => {
  assert.equal(
    userTurnContainsDeliveredResult(
      "<kavrith_result>\nstatus: clean\n</kavrith_result>",
      "<kavrith_result> status: clean </kavrith_result>",
    ),
    true,
  );
});

test("observed user turn may include a note after the Kavrith result", () => {
  assert.equal(
    userTurnContainsDeliveredResult(
      "<kavrith_result>status: clean</kavrith_result>",
      "<kavrith_result>status: clean</kavrith_result> i sent the result btw",
    ),
    true,
  );
});

test("unrelated user text does not confirm Kavrith delivery", () => {
  assert.equal(
    userTurnContainsDeliveredResult(
      "<kavrith_result>status: clean</kavrith_result>",
      "ordinary user draft",
    ),
    false,
  );
});

test("rich-editor normalization does not look like a foreign draft", () => {
  assert.equal(
    composerRecoveryDecision(
      "<kavrith_result>\nline one\nline two\n</kavrith_result>",
      "<kavrith_result> line one line two </kavrith_result>",
      false,
    ),
    "keep",
  );
});

test("trusted editing still wins over whitespace-equivalent recovery", () => {
  assert.equal(
    composerRecoveryDecision(
      "<kavrith_result>\nline one\nline two\n</kavrith_result>",
      "",
      true,
    ),
    "abort",
  );
});

test("retry does not mistake a user draft for a queued result", () => {
  assert.equal(composerMatchesExpected("queued result", "my draft"), false);
});

test("send acceptance requires ChatGPT to consume the queued result", () => {
  assert.equal(
    composerSendAcceptanceDecision("queued result", "queued result"),
    "pending",
  );
  assert.equal(
    composerSendAcceptanceDecision("queued result", ""),
    "pending",
  );
  assert.equal(
    composerSendAcceptanceDecision("queued result", "new user draft"),
    "changed",
  );
});

test("an observed user turn is required to acknowledge an emptied composer", () => {
  assert.equal(
    composerSendAcceptanceDecision("queued result", "", "queued result", true),
    "accepted",
  );
});

test("send acceptance recognizes an observed delivered user turn", () => {
  assert.equal(
    composerSendAcceptanceDecision(
      "queued result",
      "queued result",
      "queued result",
      true,
    ),
    "accepted",
  );
});

test("delivery compares against the editor-normalized insertion snapshot", () => {
  const editorSnapshot = "line one\n\nline two";
  assert.equal(
    composerRecoveryDecision(editorSnapshot, "line one\n\nline two", false),
    "keep",
  );
});

test("delivery still owns the original result after a transient editor snapshot", () => {
  assert.equal(
    composerRecoveryDecision(
      "transient editor snapshot",
      "<kavrith_context> result </kavrith_context>",
      false,
      "<kavrith_context>\nresult\n</kavrith_context>",
    ),
    "keep",
  );
});

test("send acceptance recognizes the original result after editor remount", () => {
  assert.equal(
    composerSendAcceptanceDecision(
      "transient editor snapshot",
      "<kavrith_result> result </kavrith_result>",
      "<kavrith_result>\nresult\n</kavrith_result>",
    ),
    "pending",
  );
});

test("delivery reinserts after ChatGPT resets an untouched composer", () => {
  assert.equal(
    composerRecoveryDecision("queued result", "", false),
    "reinsert",
  );
});

test("delivery never reinserts after trusted user editing", () => {
  assert.equal(
    composerRecoveryDecision("queued result", "", true),
    "abort",
  );
});

test("delivery never overwrites an unexpected non-empty draft", () => {
  assert.equal(
    composerRecoveryDecision("queued result", "my draft", false),
    "abort",
  );
});
