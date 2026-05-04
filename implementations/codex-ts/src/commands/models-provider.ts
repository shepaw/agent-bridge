/**
 * Codex-specific `ModelsProvider`.
 *
 * Unlike Claude or CodeBuddy, the Codex SDK wraps a CLI subprocess and does
 * NOT expose a `supportedModels()` / `getAvailableModels()` API. We therefore
 * return a curated static list of the OpenAI models that Codex is known to
 * support well, and surface whatever model is currently configured as the
 * selected one.
 *
 * The list is intentionally kept short to keep the radio-group picker
 * readable on a phone screen. Users who need a different model can always
 * supply `--model` on the CLI or pick one from the list.
 */
import type { ModelInfoEntry, ModelsProvider } from 'shepaw-acp-sdk';

const KNOWN_MODELS: ModelInfoEntry[] = [
  {
    id: 'codex-mini-latest',
    name: 'Codex Mini (latest)',
    description: 'Default Codex model — fast and efficient for everyday coding tasks',
  },
  {
    id: 'o4-mini',
    name: 'o4-mini',
    description: 'Compact reasoning model — great balance of speed and capability',
  },
  {
    id: 'o3',
    name: 'o3',
    description: 'Full o3 reasoning model — maximum capability for complex tasks',
  },
  {
    id: 'o3-mini',
    name: 'o3-mini',
    description: 'Compact o3 variant — efficient reasoning at lower cost',
  },
  {
    id: 'gpt-4.1',
    name: 'GPT-4.1',
    description: 'Latest GPT-4.1 — strong general coding with large context window',
  },
  {
    id: 'gpt-4o',
    name: 'GPT-4o',
    description: 'Multimodal model — handles text, images, and code',
  },
];

export interface CodexModelsProviderOptions {
  /** Currently-selected model id (if any). */
  getCurrentModel?(): string | undefined;
}

export class CodexModelsProvider implements ModelsProvider {
  constructor(private readonly opts: CodexModelsProviderOptions = {}) {}

  async list(): Promise<ModelInfoEntry[]> {
    const current = this.opts.getCurrentModel?.();
    if (current !== undefined && !KNOWN_MODELS.some((m) => m.id === current)) {
      // The user passed a custom/unknown model via --model; prepend it so it
      // still appears in the picker rather than silently disappearing.
      return [
        { id: current, name: current, description: 'Custom model (from --model flag)' },
        ...KNOWN_MODELS,
      ];
    }
    return KNOWN_MODELS;
  }
}
