/**
 * Summarise a tool invocation for display to the user on their phone.
 */
export function summarizeToolInput(toolName: string, input: Record<string, unknown>): string {
  const get = (key: string): string =>
    typeof input[key] === 'string' ? (input[key] as string) : '';

  switch (toolName) {
    case 'Read':
      return get('file_path');
    case 'Write': {
      const path = get('file_path');
      const content = get('content');
      return `${path} (${content.length} chars)`;
    }
    case 'Edit': {
      const path = get('file_path');
      const oldStr = get('old_string');
      return `${path} (replacing ${oldStr.length} chars)`;
    }
    case 'Bash': {
      let cmd = get('command');
      if (cmd.length > 120) cmd = `${cmd.slice(0, 120)}...`;
      const desc = get('description');
      return desc ? `${cmd}\n(${desc})` : cmd;
    }
    case 'Glob':
      return get('pattern');
    case 'Grep': {
      const pattern = get('pattern');
      const path = get('path');
      return path ? `/${pattern}/ in ${path}` : `/${pattern}/`;
    }
    case 'WebSearch':
      return get('query');
    case 'WebFetch':
      return get('url');
    case 'Task':
      return get('description');
    default: {
      // Fall back to showing the first field, truncated.
      for (const [k, v] of Object.entries(input)) {
        let vs = typeof v === 'string' ? v : JSON.stringify(v);
        if (vs.length > 80) vs = `${vs.slice(0, 80)}...`;
        return `${k}=${vs}`;
      }
      return '';
    }
  }
}
