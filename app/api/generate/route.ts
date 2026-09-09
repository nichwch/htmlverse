import { NextRequest, NextResponse } from "next/server";
import { ChatMessage, DEFAULT_REASONING, ReasoningEffort } from "@/lib/types";
import { assembleCompletion } from "@/lib/agent/stream";

export const maxDuration = 300;

const SYSTEM_PROMPT = [
  "You are an agent that builds and edits a user interface prototype — one complete, self-contained HTML document — using tools.",
  "The document renders in a sandboxed iframe. Tailwind CSS is injected into every render, so use utility classes freely and never add the Tailwind script yourself.",
  "You may use third-party libraries via script tags or ES module imports from jsdelivr/unpkg/esm.sh; always pin major versions.",
  "Use write_document for the first version or large rewrites, and edit_document for targeted changes — prefer edits, they are much faster. To go back to a saved version, use restore_version; never rewrite an old version by hand.",
  "read_document returns the live working source, including changes from this run. Use it whenever you are unsure of the exact text to edit. Historical assistant/tool messages may be abbreviated, and referenced nodes are inputs rather than the document being edited.",
  "If edit_document fails, nothing changed; its result includes the exact current source. Correct the match from that source instead of retrying the same text. An older version is not the current document. Use version tools only for intentionally inspecting or restoring history.",
  "After changing the document, call check_render once and fix any errors it reports.",
  "The current state of the document is provided below; user messages may include <referenced-node> blocks with content from the user's other nodes to draw from — HTML or markdown inline, or an attached image when that node's output is a hand-drawn sketch, wireframe, or photo — plus any images the user attached themselves, such as screenshots or mockups to match.",
  "When you are done, reply with a one or two sentence summary of what changed. Never include the document itself in your reply.",
  "Keep documents lean: build exactly what was asked, favor compact markup, and skip filler copy, decorative sections, and features nobody requested.",
].join(" ");

const NO_TOOLS_PROMPT = [
  "You build user interface prototypes.",
  "Reply with one complete, self-contained HTML document: inline CSS and inline JavaScript only.",
  "Tailwind CSS is already injected into every document, so use Tailwind utility classes freely and never add the Tailwind script yourself.",
  "You may use third-party libraries via script tags or ES module imports from jsdelivr/unpkg/esm.sh; always pin major versions.",
  "The document renders directly in a sandboxed iframe.",
  "User messages may include <referenced-node> blocks with content from the user's other nodes to draw from — HTML or markdown inline, or an attached image when that node's output is a hand-drawn sketch, wireframe, or photo — plus any images the user attached themselves, such as screenshots or mockups to match.",
  "Keep documents lean: build exactly what was asked, favor compact markup, and skip filler copy, decorative sections, and features nobody requested.",
  "Output raw HTML only. No markdown fences, no commentary.",
].join(" ");

/** Abort if the upstream sends nothing at all for this long — a real stall. */
const STALL_TIMEOUT_MS = 90_000;
/** Hard ceiling for one model call, stalled or not (under the route's maxDuration). */
const TOTAL_TIMEOUT_MS = 280_000;

const encoder = new TextEncoder();
const line = (value: unknown) => encoder.encode(`${JSON.stringify(value)}\n`);

export async function POST(req: NextRequest) {
  const { apiKey, model, messages, instructions, tools, html, reasoning, versionCount } =
    (await req.json()) as {
      apiKey?: string;
      model?: string;
      messages?: ChatMessage[];
      instructions?: string;
      tools?: unknown[];
      html?: string | null;
      reasoning?: ReasoningEffort;
      versionCount?: number;
    };

  if (!apiKey) {
    return NextResponse.json({ error: "missing openrouter api key" }, { status: 400 });
  }
  if (!model || !messages?.length) {
    return NextResponse.json({ error: "missing model or messages" }, { status: 400 });
  }

  const useTools = Boolean(tools?.length);
  let system = useTools ? SYSTEM_PROMPT : NO_TOOLS_PROMPT;
  // User instructions from settings apply to every node, on top of the base prompt.
  if (instructions?.trim()) {
    system += `\n\nThe user's standing instructions for every prototype:\n${instructions.trim()}`;
  }
  if (useTools) {
    system += html
      ? `\n\nCurrent document:\n${html}`
      : "\n\nThere is no document yet — create one with write_document.";
    system += versionCount
      ? `\n\nThere are ${versionCount} saved earlier version(s); n=1 is the most recently saved.`
      : "\n\nThere are no saved earlier versions yet. The first generated document is the current document; use read_document to read it. Version-history tools are unavailable.";
  }

  const upstream = new AbortController();
  const total = setTimeout(() => upstream.abort(), TOTAL_TIMEOUT_MS);
  // The browser going away should not leave a request running against OpenRouter.
  req.signal.addEventListener("abort", () => upstream.abort(), { once: true });

  let res: Response;
  try {
    res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      signal: upstream.signal,
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: system }, ...messages],
        stream: true,
        // Streaming is only used to report progress; the document is assembled here.
        usage: { include: true },
        // Ignored by non-reasoning models; "off" asks reasoners not to think.
        reasoning:
          (reasoning ?? DEFAULT_REASONING) === "off"
            ? { enabled: false }
            : { effort: reasoning ?? DEFAULT_REASONING },
        // Prototyping favors latency: route to the fastest provider for the model.
        provider: { sort: "throughput" },
        ...(useTools ? { tools } : {}),
      }),
    });
  } catch {
    clearTimeout(total);
    return NextResponse.json({ error: "could not reach openrouter" }, { status: 504 });
  }

  if (!res.ok || !res.body) {
    clearTimeout(total);
    const body = await res.text().catch(() => "");
    let message = `openrouter error (${res.status})`;
    try {
      const parsed = JSON.parse(body);
      if (parsed?.error?.message) message = parsed.error.message;
    } catch {}
    return NextResponse.json({ error: message }, { status: res.status });
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // Reset on every chunk; only true silence trips it.
      let stall: ReturnType<typeof setTimeout> | null = null;
      const armStall = () => {
        if (stall) clearTimeout(stall);
        stall = setTimeout(() => upstream.abort(), STALL_TIMEOUT_MS);
      };

      try {
        armStall();
        const { message, usage, finishReason } = await assembleCompletion(
          res.body!,
          (tokens, tool) => controller.enqueue(line({ type: "progress", tokens, tool })),
          armStall
        );

        // A truncated reply means the model ran out of room mid-document.
        if (finishReason === "length" && !message.tool_calls?.length) {
          controller.enqueue(
            line({
              type: "error",
              error: "the model hit its output limit — ask for a smaller change, or use edits",
            })
          );
        } else {
          controller.enqueue(line({ type: "done", message, usage }));
        }
      } catch {
        controller.enqueue(
          line({
            type: "error",
            error: upstream.signal.aborted
              ? "the model stopped responding"
              : "the connection to openrouter dropped",
          })
        );
      } finally {
        if (stall) clearTimeout(stall);
        clearTimeout(total);
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      // Streaming is pointless if a proxy buffers the whole body.
      "X-Accel-Buffering": "no",
    },
  });
}
