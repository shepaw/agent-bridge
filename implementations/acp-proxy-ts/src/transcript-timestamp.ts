/**
 * Extract an embedded transcript `<timestamp>...</timestamp>` tag.
 *
 * This is an **engine-side** enrichment used by acp-proxy when replaying
 * upstream sessions (Cursor embeds wall-clock stamps in user turns). The
 * result is promoted to the standard Shepaw protocol field `created_at` before
 * leaving the bridge — apps never parse engine-specific tags.
 */

const TIMESTAMP_TAG_RE = /<timestamp>\s*([^<]+?)\s*<\/timestamp>\s*/i;

export function extractEmbeddedTimestamp(content: string): {
  text: string;
  createdAt?: string;
} {
  const match = TIMESTAMP_TAG_RE.exec(content);
  if (match === null) return { text: content };

  const cleaned = content.replace(match[0]!, '');
  const raw = match[1]!.trim();
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) return { text: cleaned };
  return { text: cleaned, createdAt: new Date(ms).toISOString() };
}
