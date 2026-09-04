export interface KavrithRunRequest {
  command: string;
}

export const MAX_RUN_COMMAND_LENGTH = 65_536;

export function parseKavrithRun(text: string): KavrithRunRequest | undefined {
  const prefix = "# kavrith:run\n";
  if (!text.startsWith(prefix)) return undefined;
  const command = text.slice(prefix.length).trim();
  return command && command.length <= MAX_RUN_COMMAND_LENGTH && !command.includes("\0")
    ? { command }
    : undefined;
}
