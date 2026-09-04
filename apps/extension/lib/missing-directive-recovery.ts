export type MissingDirectiveRecoveryDecision =
  | "idle"
  | "wait"
  | "clear"
  | "remind";

export function isKavrithResultText(value: string): boolean {
  return (
    value.includes("<kavrith_result>") ||
    value.includes("<kavrith_error>")
  );
}

export function missingDirectiveRecoveryDecision({
  pending,
  assistantGenerating,
  hasNewAssistantTurn,
  assistantTurnSettled,
  hasVisibleDirective,
}: {
  pending: boolean;
  assistantGenerating: boolean;
  hasNewAssistantTurn: boolean;
  assistantTurnSettled: boolean;
  hasVisibleDirective: boolean;
}): MissingDirectiveRecoveryDecision {
  if (!pending) return "idle";
  if (assistantGenerating || !hasNewAssistantTurn || !assistantTurnSettled) {
    return "wait";
  }
  return hasVisibleDirective ? "clear" : "remind";
}
