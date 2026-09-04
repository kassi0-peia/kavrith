export type ComposerRollbackDecision = "restore" | "leave-user-changes";
export type ComposerRecoveryDecision = "keep" | "reinsert" | "abort";
export type ComposerSendAcceptanceDecision =
  | "accepted"
  | "pending"
  | "changed";

function normalizedComposerText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
): ComposerSendAcceptanceDecision {
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
