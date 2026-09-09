/**
 * A curated slice of the OpenRouter catalogue for the node model picker.
 * Slugs must match https://openrouter.ai/api/v1/models exactly, and every
 * entry must accept image input, since chat supports attached screenshots.
 * Anything else is still reachable through the picker's "custom…" option.
 */
export type ModelGroup = {
  label: string;
  models: { id: string; label: string }[];
};

export const MODEL_GROUPS: ModelGroup[] = [
  {
    label: "anthropic",
    models: [
      { id: "anthropic/claude-opus-5", label: "claude opus 5" },
      { id: "anthropic/claude-opus-5-fast", label: "claude opus 5 (fast)" },
      { id: "anthropic/claude-sonnet-5", label: "claude sonnet 5" },
      { id: "anthropic/claude-haiku-4.5", label: "claude haiku 4.5" },
      { id: "anthropic/claude-fable-5", label: "claude fable 5" },
    ],
  },
  {
    label: "openai",
    models: [
      { id: "openai/gpt-6-astra", label: "gpt-6 astra" },
      { id: "openai/gpt-5.6-terra", label: "gpt-5.6 terra" },
      { id: "openai/gpt-5.6-sol", label: "gpt-5.6 sol" },
      { id: "openai/gpt-5.6-luna", label: "gpt-5.6 luna" },
      { id: "openai/gpt-5.5", label: "gpt-5.5" },
      { id: "openai/gpt-5.4-mini", label: "gpt-5.4 mini" },
    ],
  },
  {
    label: "moonshot",
    models: [
      { id: "moonshotai/kimi-k3", label: "kimi k3" },
      { id: "moonshotai/kimi-k2.7-code", label: "kimi k2.7 code" },
    ],
  },
  {
    label: "google",
    models: [
      { id: "google/gemini-3.6-flash", label: "gemini 3.6 flash" },
      { id: "google/gemini-3.1-pro-preview", label: "gemini 3.1 pro" },
    ],
  },
  {
    label: "xai",
    models: [
      { id: "x-ai/grok-4.5", label: "grok 4.5" },
      { id: "x-ai/grok-4.3", label: "grok 4.3" },
    ],
  },
  {
    label: "open weights",
    models: [
      { id: "minimax/minimax-m3", label: "minimax m3" },
      { id: "meta-llama/llama-4-maverick", label: "llama 4 maverick" },
      { id: "mistralai/mistral-large-2512", label: "mistral large" },
    ],
  },
];

/** Sentinel `<option>` value that swaps the picker for a free-text field. */
export const CUSTOM_MODEL = "__custom__";

export function isKnownModel(id: string): boolean {
  return MODEL_GROUPS.some((group) => group.models.some((model) => model.id === id));
}
