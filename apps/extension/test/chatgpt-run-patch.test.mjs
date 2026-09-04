import assert from "node:assert/strict";
import test from "node:test";
import { MAX_RUN_COMMAND_LENGTH, parseKavrithRun } from "../dist-test/lib/chatgpt-run.js";
import { parseKavrithPatch } from "../dist-test/lib/chatgpt-patch.js";

test("preserves multiline run commands", () => {
  assert.deepEqual(
    parseKavrithRun("# kavrith:run\nset -e\nprintf 'one\\n'\nprintf 'two\\n'"),
    { command: "set -e\nprintf 'one\\n'\nprintf 'two\\n'" },
  );
});

test("accepts CRLF run directives from editor-backed code blocks", () => {
  assert.deepEqual(parseKavrithRun("# kavrith:run\r\nset -e\r\nprintf ok"), {
    command: "set -e\nprintf ok",
  });
});

test("accepts run commands larger than the former 8000 character limit", () => {
  const command = `printf ok\n#${"x".repeat(8_100)}`;
  assert.deepEqual(parseKavrithRun(`# kavrith:run\n${command}`), { command });
});

test("rejects run commands beyond the configured maximum", () => {
  assert.equal(
    parseKavrithRun(`# kavrith:run\n${"x".repeat(MAX_RUN_COMMAND_LENGTH + 1)}`),
    undefined,
  );
});

test("accepts Kavrith patch envelopes containing standard unified hunk headers", () => {
  const patch = [
    "*** Begin Patch",
    "*** Update File: README.md",
    "@@ -1,1 +1,1 @@",
    "-old",
    "+new",
    "*** End Patch",
  ].join("\n");
  assert.deepEqual(parseKavrithPatch(`# kavrith:patch\n${patch}`), { patch });
});
