export interface KavrithRunRequest {
  command: string;
}

export const MAX_RUN_COMMAND_LENGTH = 65_536;
export const RUN_END_MARKER = "# kavrith:end";

export function parseKavrithRun(text: string): KavrithRunRequest | undefined {
  text = text.replace(/\r\n?/g, "\n");
  const prefix = "# kavrith:run\n";
  if (!text.startsWith(prefix)) return undefined;
  const payload = text.slice(prefix.length).trimEnd();
  const suffix = `\n${RUN_END_MARKER}`;
  if (!payload.endsWith(suffix)) return undefined;
  const command = payload.slice(0, -suffix.length).trim();
  return command && command.length <= MAX_RUN_COMMAND_LENGTH && !command.includes("\0")
    ? { command }
    : undefined;
}
