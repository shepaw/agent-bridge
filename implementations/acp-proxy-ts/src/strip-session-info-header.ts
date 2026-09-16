/**
 * Remove UI "copy session info" prefixes accidentally pasted into user turns.
 *
 * Shepaw App exposes this format only for clipboard copy — it must not reach
 * upstream coding agents (wastes tokens, zero task semantics).
 */

const SESSION_INFO_HEADER =
  /^(?:标题|Title)[:：][^\n]*\n(?:会话 ID|Session ID)[:：][^\n]*\n(?:channel ID|Channel ID)[:：][^\n]*\n*/;

/** Strip a leading copy-session-info block when present. */
export function stripCopySessionInfoHeader(text: string): string {
  if (text.length === 0) return text;
  return text.replace(SESSION_INFO_HEADER, '');
}

/** Strip from plain-text prompt or first text block in ContentBlocks. */
export function stripSessionInfoFromPrompt(
  prompt: string | import('@agentclientprotocol/sdk').ContentBlock | ReadonlyArray<import('@agentclientprotocol/sdk').ContentBlock>,
): typeof prompt {
  if (typeof prompt === 'string') {
    const stripped = stripCopySessionInfoHeader(prompt);
    return stripped === prompt ? prompt : stripped;
  }
  if (!Array.isArray(prompt)) {
    if (prompt.type === 'text' && typeof prompt.text === 'string') {
      const stripped = stripCopySessionInfoHeader(prompt.text);
      if (stripped === prompt.text) return prompt;
      return { ...prompt, text: stripped };
    }
    return prompt;
  }
  let changed = false;
  const out = prompt.map((block) => {
    if (block.type === 'text' && typeof block.text === 'string') {
      const stripped = stripCopySessionInfoHeader(block.text);
      if (stripped !== block.text) {
        changed = true;
        return { ...block, text: stripped };
      }
    }
    return block;
  });
  return changed ? out : prompt;
}
