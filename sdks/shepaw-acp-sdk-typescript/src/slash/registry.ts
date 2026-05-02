/**
 * In-memory registry of slash-command handlers.
 *
 * `register()` installs a handler under its primary `name` and under each
 * of its `aliases`, so both point at the same object. `dispatch()` looks
 * up by the first token of the user's message and delegates; it returns
 * `false` for unknown names so the server can fall through to `onChat`
 * (the LLM takes care of unrecognized slash commands like `/compact`).
 *
 * `listPrimary()` returns each registered handler exactly once regardless
 * of how many aliases it has — used to populate the shepaw `/` palette
 * via `agent.commands.list`.
 */
import type { TaskContext } from '../task-context.js';
import type { SlashCommandDeps, SlashCommandHandler } from './types.js';

export class SlashCommandRegistry<C = unknown> {
  private readonly byName = new Map<string, SlashCommandHandler<C>>();

  register(handler: SlashCommandHandler<C>): this {
    this.byName.set(handler.name, handler);
    for (const alias of handler.aliases ?? []) {
      this.byName.set(alias, handler);
    }
    return this;
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  get(name: string): SlashCommandHandler<C> | undefined {
    return this.byName.get(name);
  }

  /** Distinct handlers (deduped by object identity). */
  listPrimary(): SlashCommandHandler<C>[] {
    return [...new Set(this.byName.values())];
  }

  async dispatch(
    ctx: TaskContext,
    name: string,
    args: string[],
    raw: string,
    kwargs: Record<string, unknown>,
    deps: SlashCommandDeps<C>,
  ): Promise<boolean> {
    const h = this.byName.get(name);
    if (h === undefined) return false;
    return h.handle(ctx, args, raw, kwargs, deps);
  }
}
