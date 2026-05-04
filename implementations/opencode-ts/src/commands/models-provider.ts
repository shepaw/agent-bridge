/**
 * OpenCode `ModelsProvider` — fetches the live list of models from the
 * running OpenCode server via `GET /provider`.
 *
 * The response groups models by provider. We flatten them into
 * `ModelInfoEntry` objects keyed as `providerID/modelID` so the Shepaw model
 * picker can display them with provider context.
 *
 * Connected providers are listed first; within each group, models are sorted
 * alphabetically by name. If the OpenCode server is unreachable (e.g. during
 * startup) we return an empty list rather than crashing.
 */
import type { ModelInfoEntry, ModelsProvider } from 'shepaw-acp-sdk';

import type { OpencodeClient } from '@opencode-ai/sdk';

import { log } from '../debug.js';

export interface OpenCodeModelsProviderOptions {
  /** Lazily resolve the client (may be undefined until `init()` completes). */
  getClient(): OpencodeClient | undefined;
  /** Currently-selected model key in `providerID/modelID` form. */
  getCurrentModelKey?(): string | undefined;
}

export class OpenCodeModelsProvider implements ModelsProvider {
  constructor(private readonly opts: OpenCodeModelsProviderOptions) {}

  async list(): Promise<ModelInfoEntry[]> {
    const client = this.opts.getClient();
    if (!client) return [];

    try {
      const res = await client.provider.list();
      if (!res.data) return [];

      const { all: providers, connected } = res.data;
      const connectedSet = new Set(connected ?? []);

      const entries: ModelInfoEntry[] = [];

      // Sort providers: connected first, then alphabetical.
      const sorted = [...providers].sort((a, b) => {
        const aC = connectedSet.has(a.id) ? 0 : 1;
        const bC = connectedSet.has(b.id) ? 0 : 1;
        if (aC !== bC) return aC - bC;
        return a.name.localeCompare(b.name);
      });

      for (const provider of sorted) {
        const modelEntries = Object.values(provider.models ?? {});
        // Sort models alphabetically by name within each provider.
        modelEntries.sort((a, b) => a.name.localeCompare(b.name));

        for (const model of modelEntries) {
          const key = `${provider.id}/${model.id}`;
          entries.push({
            id: key,
            name: `${provider.name}: ${model.name}`,
            description: buildDescription(model, connectedSet.has(provider.id)),
          });
        }
      }

      return entries;
    } catch (err) {
      log.gateway('models-provider: GET /provider failed: %s', (err as Error).message);
      return [];
    }
  }
}

function buildDescription(
  model: {
    reasoning: boolean;
    attachment: boolean;
    tool_call: boolean;
    limit: { context: number; output: number };
    status?: 'alpha' | 'beta' | 'deprecated';
    experimental?: boolean;
  },
  isConnected: boolean,
): string {
  const parts: string[] = [];

  if (!isConnected) parts.push('not connected');
  if (model.status === 'deprecated') parts.push('deprecated');
  else if (model.status === 'alpha') parts.push('alpha');
  else if (model.status === 'beta') parts.push('beta');
  if (model.experimental) parts.push('experimental');

  const caps: string[] = [];
  if (model.reasoning) caps.push('reasoning');
  if (model.attachment) caps.push('vision');
  if (model.tool_call) caps.push('tools');
  if (caps.length > 0) parts.push(caps.join('+'));

  const ctxK = Math.round(model.limit.context / 1000);
  if (ctxK > 0) parts.push(`${ctxK}k ctx`);

  return parts.join(' · ');
}
