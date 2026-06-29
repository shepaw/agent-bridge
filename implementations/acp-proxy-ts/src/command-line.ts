/**
 * Parse a shell-style command line into executable + args (supports quotes).
 */

export function parseShellCommand(input: string): { command: string; args: string[] } {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new Error('ACP command must not be empty.');
  }

  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]!;
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
        continue;
      }
      if (ch === '\\' && quote === '"' && i + 1 < trimmed.length) {
        current += trimmed[++i];
        continue;
      }
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }

  if (quote !== null) {
    throw new Error('ACP command has an unclosed quote.');
  }
  if (current.length > 0) tokens.push(current);
  if (tokens.length === 0) {
    throw new Error('ACP command must not be empty.');
  }

  return { command: tokens[0]!, args: tokens.slice(1) };
}

export function formatShellCommand(command: string, args: ReadonlyArray<string>): string {
  const quote = (value: string): string => {
    if (/[\s"'\\]/.test(value)) {
      return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    }
    return value;
  };
  return [command, ...args.map(quote)].join(' ');
}
