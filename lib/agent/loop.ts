import {
  MAX_AGENT_STEPS,
  type ChatMessage,
  type DocVersion,
  type ReasoningEffort,
  type RunUsage,
  type ToolCall,
} from "@/lib/types";
import { toolsForDocument, executeToolCall, type ToolContext } from "./tools";
import type { CompletionMessage, CompletionUsage } from "./stream";

export type RunAgentOptions = {
  apiKey: string;
  model: string;
  reasoning: ReasoningEffort;
  instructions: string;
  /** Full transcript for the API, ending with the new user turn (mentions already expanded). */
  messages: ChatMessage[];
  html: string | null;
  versions: DocVersion[];
  signal: AbortSignal;
  /** Fires with the run's new messages and usage so the transcript updates live. */
  onUpdate?: (runMessages: ChatMessage[], usage: RunUsage) => void;
  /** Fires while a step is still streaming, so progress is visible mid-call. */
  onProgress?: (usage: RunUsage, tool: string | null) => void;
};

export type RunAgentResult = {
  /** Only the messages produced by this run (assistant turns and tool results). */
  messages: ChatMessage[];
  html: string | null;
  usage: RunUsage;
};

/**
 * The agent loop: call the model, execute any tool calls locally, feed results
 * back, repeat until it answers in plain text. The document is edited on a
 * working copy — nothing is committed if the run throws or is aborted.
 */
export async function runAgent(opts: RunAgentOptions): Promise<RunAgentResult> {
  const run: ChatMessage[] = [];
  const usage: RunUsage = { promptTokens: 0, completionTokens: 0, steps: 0 };
  let working = opts.html;
  const ctx: ToolContext = {
    getHtml: () => working,
    setHtml: (html) => {
      working = html;
    },
    versions: opts.versions,
  };

  for (let step = 0; step < MAX_AGENT_STEPS; step++) {
    // Committed totals; the in-flight step adds its live estimate on top.
    const settled = { ...usage };
    const { message, usage: stepUsage } = await requestCompletion(
      opts,
      [...opts.messages, ...run],
      working,
      (tokens, tool) => {
        usage.completionTokens = settled.completionTokens + tokens;
        usage.steps = settled.steps + 1;
        opts.onProgress?.({ ...usage }, tool);
      }
    );
    usage.steps = settled.steps + 1;
    usage.promptTokens = settled.promptTokens + (stepUsage?.prompt_tokens ?? 0);
    usage.completionTokens =
      settled.completionTokens + (stepUsage?.completion_tokens ?? usage.completionTokens - settled.completionTokens);
    const toolCalls: ToolCall[] | undefined = message.tool_calls?.length
      ? message.tool_calls
      : undefined;

    if (!toolCalls) {
      // Some models ignore tools and reply with the document itself; accept it.
      const doc = extractDocument(message.content);
      if (doc) working = doc;
      run.push({ role: "assistant", content: doc ? "(rendered)" : message.content ?? null });
      opts.onUpdate?.([...run], usage);
      return { messages: run, html: working, usage };
    }

    run.push({
      role: "assistant",
      content: message.content ?? null,
      tool_calls: toolCalls,
      // Passed back on the next step; some providers reject tool loops without it.
      ...(message.reasoning_details ? { reasoning_details: message.reasoning_details } : {}),
    });
    opts.onUpdate?.([...run], usage);

    for (const call of toolCalls) {
      if (opts.signal.aborted) throw new DOMException("aborted", "AbortError");
      run.push({ role: "tool", tool_call_id: call.id, content: await executeToolCall(call, ctx) });
    }
    opts.onUpdate?.([...run], usage);
  }

  throw new Error(`stopped after ${MAX_AGENT_STEPS} steps without finishing`);
}

type WirePart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

/** User messages with images become multimodal content parts on the wire. */
function toWireMessage(m: ChatMessage): ChatMessage | { role: "user"; content: WirePart[] } {
  if (m.role !== "user") return m;
  const user: Extract<ChatMessage, { role: "user" }> = {
    role: "user",
    content: m.content,
    ...(m.images?.length ? { images: m.images } : {}),
  };
  if (!user.images?.length) return user;
  return {
    role: "user",
    content: [
      ...(user.content ? [{ type: "text" as const, text: user.content }] : []),
      ...user.images.map((url) => ({ type: "image_url" as const, image_url: { url } })),
    ],
  };
}

/** One model call via the pass-through route, retrying transient failures. */
async function requestCompletion(
  opts: RunAgentOptions,
  messages: ChatMessage[],
  html: string | null,
  onProgress: (tokens: number, tool: string | null) => void
): Promise<{ message: CompletionMessage; usage: CompletionUsage }> {
  let lastError = "request failed";

  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(attempt * 2000, opts.signal);

    let res: Response;
    try {
      res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // The run's own signal (cancel button) plus a per-request stall guard.
        signal: AbortSignal.any([opts.signal, AbortSignal.timeout(300_000)]),
        body: JSON.stringify({
          apiKey: opts.apiKey,
          model: opts.model,
          reasoning: opts.reasoning,
          instructions: opts.instructions,
          messages: messages.map(toWireMessage),
          html,
          versionCount: opts.versions.length,
          // Squeezing a whole document through a JSON tool argument is slow and
          // truncation-prone, so the first generation runs without tools and
          // replies with raw HTML.
          ...(html ? { tools: toolsForDocument(opts.versions.length) } : {}),
        }),
      });
    } catch (err) {
      if (opts.signal.aborted) throw new DOMException("aborted", "AbortError");
      if (err instanceof DOMException && err.name === "TimeoutError") {
        throw new Error("timed out after 5 minutes");
      }
      lastError = "could not reach the server";
      continue;
    }

    if (!res.ok || !res.body) {
      const body = await res.json().catch(() => null);
      lastError = body?.error ?? `request failed (${res.status})`;
      // Rate limits and upstream blips are worth retrying; anything else is not.
      if (res.status !== 429 && res.status < 500) throw new Error(lastError);
      continue;
    }

    const result = await readStream(res.body, onProgress);
    if (result.error) throw new Error(result.error);
    if (result.message) return { message: result.message, usage: result.usage };
    lastError = "empty response from model";
  }

  throw new Error(lastError);
}

/** Reads the route's NDJSON progress stream, returning the assembled message. */
async function readStream(
  body: ReadableStream<Uint8Array>,
  onProgress: (tokens: number, tool: string | null) => void
): Promise<{ message?: CompletionMessage; usage: CompletionUsage; error?: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let message: CompletionMessage | undefined;
  let usage: CompletionUsage = null;
  let error: string | undefined;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const raw of lines) {
      if (!raw.trim()) continue;
      let event: {
        type: string;
        tokens?: number;
        tool?: string | null;
        message?: CompletionMessage;
        usage?: CompletionUsage;
        error?: string;
      };
      try {
        event = JSON.parse(raw);
      } catch {
        continue;
      }
      if (event.type === "progress") onProgress(event.tokens ?? 0, event.tool ?? null);
      if (event.type === "error") error = event.error;
      if (event.type === "done") {
        message = event.message;
        usage = event.usage ?? null;
      }
    }
  }

  return { message, usage, error };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException("aborted", "AbortError"));
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function stripFences(text: string): string {
  const match = text.match(/^\s*```[a-z]*\n([\s\S]*?)\n```\s*$/i);
  return match ? match[1] : text;
}

/** Detects a model that answered with a raw HTML document instead of a tool call. */
function extractDocument(content: string | null | undefined): string | null {
  if (!content) return null;
  const stripped = stripFences(content).trim();
  return /^(<!doctype|<html)/i.test(stripped) ? stripped : null;
}

export function looksLikeHtmlDocument(content: string): boolean {
  return /^\s*(<!doctype|<html)/i.test(content);
}

const MAX_STORED_TOOL_RESULT = 400;
const MAX_STORED_TOOL_ARGS = 2000;

/**
 * Shrinks a finished run before it enters the stored transcript: documents in
 * write_document args and bulky tool results (fetched versions) are stubbed —
 * these are historical actions, not a source of current HTML. Future turns
 * get the live document and can reread it with read_document. Earlier turns are never touched, so
 * the prompt keeps a stable, cacheable prefix.
 */
export function compactRun(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => {
    if (m.role === "tool" && m.content.length > MAX_STORED_TOOL_RESULT) {
      return { ...m, content: `${m.content.slice(0, MAX_STORED_TOOL_RESULT)}… (truncated)` };
    }
    if (m.role === "assistant" && m.tool_calls) {
      // Reasoning blocks only matter inside the run that produced them.
      const rest = { ...m };
      delete rest.reasoning_details;
      return {
        ...rest,
        tool_calls: m.tool_calls.map((call) =>
          call.function.name === "write_document" ||
          call.function.arguments.length > MAX_STORED_TOOL_ARGS
            ? {
                ...call,
                function: {
                  ...call.function,
                  arguments: JSON.stringify({ note: "(historical content omitted — use read_document for current source)" }),
                },
              }
            : call
        ),
      };
    }
    return m;
  });
}
