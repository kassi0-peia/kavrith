export type ComposerRollbackDecision = "restore" | "leave-user-changes";
export type ComposerRecoveryDecision = "keep" | "reinsert" | "abort";

function normalizedComposerText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .trimEnd();
}

export function composerMatchesExpected(
  expected: string,
  current: string,
): boolean {
  return normalizedComposerText(expected) === normalizedComposerText(current);
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
): ComposerRecoveryDecision {
  const normalizedCurrent = normalizedComposerText(current);
  if (composerMatchesExpected(expected, current)) return "keep";
  if (userEdited) return "abort";
  return normalizedCurrent.length === 0 ? "reinsert" : "abort";
}
