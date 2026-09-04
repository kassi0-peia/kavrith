export const MAX_CHATGPT_RESULT_CHARS = 24 * 1024;

export function resultForChatGPTDelivery(
  result: string,
  maxChars = MAX_CHATGPT_RESULT_CHARS,
): string {
  if (result.length <= maxChars) return result;

  const marker = [
    "",
    "",
    `<kavrith_delivery_truncation original_chars="${result.length}" note="middle omitted; full result remains in the local Kavrith panel" />`,
    "",
    "",
  ].join("\n");

  if (maxChars <= marker.length) return marker.slice(0, maxChars);

  const remaining = maxChars - marker.length;
  const headChars = Math.ceil(remaining / 2);
  const tailChars = remaining - headChars;

  return (
    result.slice(0, headChars) +
    marker +
    result.slice(result.length - tailChars)
  );
}
