export type ComposerRollbackDecision = "restore" | "leave-user-changes";
export type ComposerRecoveryDecision = "keep" | "reinsert" | "abort";
export type ComposerSendAcceptanceDecision =
  | "accepted"
  | "pending"
  | "changed";

export function composerOwnershipFailure(message: string) {
  return {
    ok: false as const,
    message,
    automaticRetry: false as const,
  };
}

export function composerRecoveryFailure(
  message: string,
  userEdited: boolean,
) {
  return userEdited
    ? composerOwnershipFailure(message)
    : { ok: false as const, message };
}

export function normalizedComposerText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    // Rich contenteditable editors can introduce invisible formatting marks
    // while remounting otherwise identical text. They have no visible payload
    // semantics here, so ignore them for ownership/consumption comparisons.
    .replace(/[\u200b-\u200f\u2060\u2066-\u2069\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function userTurnContainsDeliveredResult(
  result: string,
  userText: string,
): boolean {
  const expected = normalizedComposerText(result);
  const observed = normalizedComposerText(userText);
  return (
    observed === expected ||
    (expected.length > 0 && observed.startsWith(`${expected} `))
  );
}

export function composerMatchesExpected(
  expected: string,
  current: string,
): boolean {
  return normalizedComposerText(expected) === normalizedComposerText(current);
}

export function composerSendAcceptanceDecision(
  expected: string,
  current: string,
  source = expected,
  observed = false,
): ComposerSendAcceptanceDecision {
  if (observed) return "accepted";
  if (
    composerMatchesExpected(expected, current) ||
    composerMatchesExpected(source, current)
  ) {
    return "pending";
  }
  return normalizedComposerText(current).length === 0 ? "accepted" : "changed";
}

export function composerRollbackDecision(
  original: string,
  inserted: string,
  current: string,
): ComposerRollbackDecision {
  const normalizedCurrent = normalizedComposerText(current);
  const normalizedInserted = normalizedComposerText(inserted);
  const normalizedOriginal = normalizedComposerText(original);
  return normalizedCurrent === normalizedInserted &&
    normalizedInserted !== normalizedOriginal
    ? "restore"
    : "leave-user-changes";
}

export function firstUsableCandidate<T>(
  candidates: Iterable<T>,
  isUsable: (candidate: T) => boolean,
): T | undefined {
  for (const candidate of candidates) {
    if (isUsable(candidate)) return candidate;
  }
  return undefined;
}

export function composerRecoveryDecision(
  expected: string,
  current: string,
  userEdited: boolean,
  source = expected,
): ComposerRecoveryDecision {
  const normalizedCurrent = normalizedComposerText(current);
  if (
    composerMatchesExpected(expected, current) ||
    composerMatchesExpected(source, current)
  ) {
    return "keep";
  }
  if (userEdited) return "abort";
  return normalizedCurrent.length === 0 ? "reinsert" : "abort";
}
