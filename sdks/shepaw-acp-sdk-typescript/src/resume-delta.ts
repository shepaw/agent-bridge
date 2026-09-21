/**
 * Cursor maths for `agent.taskResume`.
 *
 * The replay buffer accumulates `ui.textContent` chunks into a JS string, and
 * the client tells us how much of it it already has (`known_length`), so the
 * resume answer is exactly the missing suffix.
 */

/**
 * Clamp and surrogate-align the resume cursor.
 *
 * `knownLength` counts UTF-16 code units (what the client received), but a
 * client that measured in characters can land in the middle of a surrogate
 * pair. Slicing there starts the delta with an orphaned low surrogate, which
 * renders as garbage and corrupts every CJK/emoji chunk after it — so we back
 * up one code unit and resend the whole pair instead.
 */
export function resumeDeltaBase(accumulated: string, knownLength: number): number {
  let base = Math.max(0, Math.min(knownLength, accumulated.length));
  if (base > 0 && base < accumulated.length) {
    const prev = accumulated.charCodeAt(base - 1);
    const cur = accumulated.charCodeAt(base);
    const prevIsHighSurrogate = prev >= 0xd800 && prev <= 0xdbff;
    const curIsLowSurrogate = cur >= 0xdc00 && cur <= 0xdfff;
    if (prevIsHighSurrogate && curIsLowSurrogate) base -= 1;
  }
  return base;
}
