import type { DocVersion, ToolCall } from "@/lib/types";
import { withErrorReporting, withTailwind } from "@/lib/preview";

/**
 * The agent's tools all execute in the browser, where the document and its
 * versions actually live. The server only relays schemas and tool calls.
 */
export type ToolContext = {
  getHtml: () => string | null;
  setHtml: (html: string) => void;
  versions: DocVersion[];
};

export const TOOL_SCHEMAS = [
  {
    type: "function",
    function: {
      name: "read_document",
      description:
        "Read the exact current working HTML, including edits made during this run. Use before editing when the source is uncertain. This is the live document, not an older saved version.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "write_document",
      description:
        "Replace the entire document with new HTML. Use for the first version or for large rewrites.",
      parameters: {
        type: "object",
        properties: {
          html: { type: "string", description: "A complete, self-contained HTML document." },
        },
        required: ["html"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_document",
      description:
        "Replace an exact substring of the current document. old_str must appear exactly once; include surrounding context to disambiguate. Copy old_str from the current document, not a reference or a previous version. Failed matches return the live source; use it to correct the edit. Prefer this over write_document for small changes.",
      parameters: {
        type: "object",
        properties: {
          old_str: { type: "string", description: "Exact text to find. Must match exactly once." },
          new_str: { type: "string", description: "Text to replace it with." },
        },
        required: ["old_str", "new_str"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "check_render",
      description:
        "Render the current document in a sandbox and report page errors, unhandled rejections, and console.error output. Call after making changes; fix anything it reports.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_version",
      description:
        "Read an older saved version of the document without changing anything. n=1 is the most recently saved version, n=2 the one before that. To make an old version current, use restore_version instead — do not copy it back by hand.",
      parameters: {
        type: "object",
        properties: { n: { type: "integer", minimum: 1 } },
        required: ["n"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "restore_version",
      description:
        "Make an older saved version the current document, in one step. n=1 is the most recently saved version, n=2 the one before that. Much faster than fetching and rewriting.",
      parameters: {
        type: "object",
        properties: { n: { type: "integer", minimum: 1 } },
        required: ["n"],
      },
    },
  },
];

/** Version tools are actionable only when a prior committed document exists. */
export function toolsForDocument(versionCount: number) {
  return TOOL_SCHEMAS.filter((tool) => versionCount > 0 || !["fetch_version", "restore_version"].includes(tool.function.name));
}

/** Resolves n (1 = most recently saved) to a version, or an error message. */
function lookupVersion(n: unknown, versions: DocVersion[]): DocVersion | string {
  if (!versions.length) return "error: no older saved versions exist. Use read_document to read the current document; it is not a saved earlier version.";
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1) {
    return "error: n must be a positive integer";
  }
  const version = versions[versions.length - n];
  if (!version) {
    return `error: n must be between 1 (most recent saved) and ${versions.length} (oldest)`;
  }
  return version;
}

/** How long check_render lets the document run before reporting. */
const RENDER_CHECK_MS = 2500;

function countOccurrences(haystack: string, needle: string): number {
  return needle ? haystack.split(needle).length - 1 : 0;
}

/** Errors go back to the model as results — it recovers well from a clear message. */
export async function executeToolCall(call: ToolCall, ctx: ToolContext): Promise<string> {
  let args: Record<string, unknown>;
  try {
    args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
  } catch {
    return "error: tool arguments were not valid JSON";
  }

  switch (call.function.name) {
    case "read_document": {
      return ctx.getHtml() ?? "There is no current document yet — use write_document.";
    }

    case "write_document": {
      const html = args.html;
      if (typeof html !== "string" || !html.trim()) return "error: html must be a non-empty string";
      ctx.setHtml(html.trim());
      return `ok — document replaced (${html.length} chars)`;
    }

    case "edit_document": {
      const html = ctx.getHtml();
      if (!html) return "error: there is no document yet — use write_document";
      const { old_str: oldStr, new_str: newStr } = args;
      if (typeof oldStr !== "string" || typeof newStr !== "string") {
        return "error: old_str and new_str must be strings";
      }
      const count = countOccurrences(html, oldStr);
      if (count !== 1) {
        const reason = count === 0 ? "old_str was not found in the document" : `old_str matched ${count} times`;
        return `error: ${reason}. Nothing was changed. Correct old_str using the exact current source below and include enough context to match once. Do not repeat the failed match or fetch an older version to locate current code.\n\nCurrent document (verbatim):\n${html}`;
      }
      // A function replacement preserves literal JS replacement tokens such as
      // $&, $$, and $' in generated source instead of expanding them here.
      ctx.setHtml(html.replace(oldStr, () => newStr));
      return "ok — edit applied";
    }

    case "check_render": {
      const html = ctx.getHtml();
      if (!html) return "error: there is no document to render";
      return checkRender(html);
    }

    case "fetch_version": {
      const found = lookupVersion(args.n, ctx.versions);
      if (typeof found === "string") return found;
      return `version saved ${new Date(found.ts).toLocaleString()}:\n\n${found.html}`;
    }

    case "restore_version": {
      const found = lookupVersion(args.n, ctx.versions);
      if (typeof found === "string") return found;
      ctx.setHtml(found.html);
      return `ok — restored the version saved ${new Date(found.ts).toLocaleString()}`;
    }

    default:
      return `error: unknown tool ${call.function.name}`;
  }
}

/** Renders in a hidden sandboxed iframe and collects errors posted by withErrorReporting. */
function checkRender(html: string): Promise<string> {
  return new Promise((resolve) => {
    const nonce = crypto.randomUUID();
    const iframe = document.createElement("iframe");
    iframe.setAttribute("sandbox", "allow-scripts");
    iframe.style.cssText = "position:fixed;left:-10000px;width:720px;height:440px;visibility:hidden";

    const errors: string[] = [];
    const onMessage = (event: MessageEvent) => {
      if (
        event.source === iframe.contentWindow &&
        event.data?.nonce === nonce &&
        typeof event.data.error === "string"
      ) {
        errors.push(event.data.error);
      }
    };

    window.addEventListener("message", onMessage);
    iframe.srcdoc = withErrorReporting(withTailwind(html), nonce);
    document.body.appendChild(iframe);

    setTimeout(() => {
      window.removeEventListener("message", onMessage);
      iframe.remove();
      resolve(
        errors.length
          ? `${errors.length} error(s):\n${errors.slice(0, 10).map((e) => `- ${e}`).join("\n")}`
          : "no errors detected"
      );
    }, RENDER_CHECK_MS);
  });
}
