import assert from "node:assert/strict";
import test from "node:test";
import {
  composerMatchesExpected,
  composerRecoveryDecision,
  composerRollbackDecision,
  firstUsableCandidate,
} from "../dist-test/lib/composer-delivery.js";

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

test("retry does not mistake a user draft for a queued result", () => {
  assert.equal(composerMatchesExpected("queued result", "my draft"), false);
});

test("delivery compares against the editor-normalized insertion snapshot", () => {
  const editorSnapshot = "line one\n\nline two";
  assert.equal(
    composerRecoveryDecision(editorSnapshot, "line one\n\nline two", false),
    "keep",
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
