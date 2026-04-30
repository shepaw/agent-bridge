/**
 * Glob-style wildcard matching for pattern rules.
 *
 * Ported from opencode's `packages/opencode/src/util/wildcard.ts` so
 * that our pattern-rule matching stays semantically identical to the
 * reference implementation.
 *
 * Supported syntax:
 *   `*`  matches any run of characters (including whitespace)
 *   `?`  matches a single character
 *
 * Two subtle behaviors worth calling out:
 *
 * 1. **Path normalization.** Both the input string and pattern have
 *    backslashes (`\`) rewritten to forward slashes (`/`) before
 *    matching. This lets a single pattern work on Windows and POSIX.
 *
 * 2. **Trailing ` *` is optional.** A pattern that ends in a space
 *    followed by `*` — e.g. `"ls *"` or `"npm install *"` — will match
 *    both the form with arguments (`"ls -la"`, `"npm install foo"`) and
 *    the bare command (`"ls"`, `"npm install"`). Without this, a rule
 *    like `"ls *"` would silently fail to match a plain `ls`.
 *
 * We intentionally do NOT port opencode's `all` / `allStructured` /
 * `matchSequence`; those are used by opencode for other lookup tables
 * and are not needed for our rule-evaluation flow.
 */

export function match(str: string, pattern: string): boolean {
  if (str) str = str.replaceAll('\\', '/');
  if (pattern) pattern = pattern.replaceAll('\\', '/');

  let escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape special regex chars
    .replace(/\*/g, '.*') // * becomes .*
    .replace(/\?/g, '.'); // ? becomes .

  // If pattern ends with " *" (space + wildcard), make the trailing
  // part optional. This allows "ls *" to match both "ls" and "ls -la".
  if (escaped.endsWith(' .*')) {
    escaped = escaped.slice(0, -3) + '( .*)?';
  }

  const flags = process.platform === 'win32' ? 'si' : 's';
  return new RegExp('^' + escaped + '$', flags).test(str);
}
