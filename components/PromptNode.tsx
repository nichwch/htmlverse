"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { NodeResizer, useReactFlow, useStore, type Node, type NodeProps } from "@xyflow/react";
import {
  DEFAULT_CHAT_INPUT_HEIGHT,
  DEFAULT_NODE_HEIGHT,
  DEFAULT_NODE_WIDTH,
  DEFAULT_SIDEBAR_WIDTH,
  DRAG_HANDLE_CLASS,
  DRAG_HANDLE_SELECTOR,
  DEFAULT_REASONING,
  MAX_VERSIONS,
  REASONING_EFFORTS,
  MIN_CHAT_INPUT_HEIGHT,
  MIN_NODE_HEIGHT,
  MIN_NODE_WIDTH,
  MIN_SIDEBAR_WIDTH,
  type ChatMessage,
  type HtmlAnnotation,
  type NodeTab,
  type DrawStroke,
  type PromptNodeData,
  type ReasoningEffort,
} from "@/lib/types";
import { CUSTOM_MODEL, MODEL_GROUPS, isKnownModel } from "@/lib/models";
import { getApiKey, getInstructions } from "@/lib/storage";
import { compactRun, looksLikeHtmlDocument, runAgent } from "@/lib/agent/loop";
import { buildMentionContext, splitMentions, type Mentionable } from "@/lib/mentions";
import { formatAnnotations, numberAnnotations, type AnnotateHover } from "@/lib/annotate";
import { useCanvasId } from "./CanvasContext";
import { useDebouncedValue } from "./useDebouncedValue";
import { withTailwind } from "@/lib/preview";
import { markdownDocument } from "@/lib/markdown";
import { EyeClosedIcon, EyeIcon, ForkIcon, SidebarIcon, TrashIcon, ExpandIcon, CollapseIcon, AnnotateIcon } from "./icons";
import { KindIcon, TabIcon, kindTextClass, mentionChipClass, outputKind } from "./nodeKinds";
import CodeEditor from "./CodeEditor";
import MentionInput from "./MentionInput";
import MentionChip from "./MentionChip";
import {
  DEFAULT_DRAWING_SETTINGS,
  DrawingPane,
  DrawingToolbar,
  type DrawingPaneHandle,
  type DrawingSettings,
} from "./DrawingPane";
import { resolveItems } from "@/lib/drawing";
import { WireframePane, WireframeToolbar, type WireframeTool } from "./WireframePane";
import { DEFAULT_FONT_SIZE } from "@/lib/wireframe";
import { defaultNodeName, isDefaultNodeName, matchesTabLabel } from "@/lib/nodeNames";
import { PhotoPane, PhotoToolbar, type PhotoPaneHandle } from "./PhotoPane";
import HtmlPreview from "./HtmlPreview";
import AnnotationWidget from "./AnnotationWidget";

export type PromptFlowNode = Node<PromptNodeData, "prompt">;

/** Stable identity so an undrawn node doesn't remount the draw surface. */
const EMPTY_STROKES: DrawStroke[] = [];

/**
 * Tabs in bar order. chat and html share a group because they are two views of
 * the same output — chat generates the document, html edits it directly.
 */
const TAB_GROUPS: NodeTab[][] = [["chat", "html"], ["md"], ["draw"], ["wire"], ["photo"]];

/** Icons carry no label, so the tooltip says what each tab is for. */
const TAB_TITLES: Record<NodeTab, string> = {
  chat: "chat — describe what you want and the model builds the html",
  html: "html — edit the generated document directly",
  md: "md — write markdown",
  draw: "draw — sketch by hand",
  wire: "wire — lay out a wireframe",
  photo: "photo — upload or take a reference image",
};

/** Leaves at least this much room for the preview when dragging the sidebar wider. */
const MIN_PREVIEW_WIDTH = 120;

/** Header plus tab bar, subtracted when working out how tall the chat input may grow. */
const SIDEBAR_CHROME_HEIGHT = 76;
/** Leaves at least this much room for the transcript when dragging the input taller. */
const MIN_CHAT_LOG_HEIGHT = 72;

/** Runs `onMove` for the duration of a pointer drag, then unhooks itself. */
function trackPointerDrag(onMove: (event: PointerEvent) => void) {
  const stop = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", stop);
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", stop);
}

function formatTokens(count: number): string {
  return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count);
}

function formatElapsed(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Tool results the transcript should surface: executor errors and render errors. */
function isToolFailure(content: string): boolean {
  return content.startsWith("error:") || / error\(s\):/.test(content);
}

/** Past annotation chips are expanded only on the API copy of a user turn. */
function userContentForApi(m: Extract<ChatMessage, { role: "user" }>): string {
  const notes = m.annotations?.length ? formatAnnotations(m.annotations) : "";
  if (notes && m.content) return `${m.content}\n\n${notes}`;
  return notes || m.content;
}

type AnnotationDraft = AnnotateHover & { x: number; y: number };

function PromptNode({ id, data, width, height, selected }: NodeProps<PromptFlowNode>) {
  const { updateNodeData, deleteElements, setNodes, getNode, getNodes, getZoom, fitView } =
    useReactFlow<PromptFlowNode>();
  // A model saved before it was in the list — or typed by hand — opens in custom mode.
  const [customModel, setCustomModel] = useState(() => !isKnownModel(data.model));
  const chatEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const canvasId = useCanvasId();
  // Local, not node data — a per-second tick must not churn canvas storage.
  const [activity, setActivity] = useState<{ startedAt: number; tool: string | null } | null>(null);
  const [elapsed, setElapsed] = useState(0);

  // Editor session state for the draw and wire tabs; only the artwork persists.
  const [drawSettings, setDrawSettings] = useState<DrawingSettings>(DEFAULT_DRAWING_SETTINGS);
  const [drawZoom, setDrawZoom] = useState(1);
  const drawingRef = useRef<DrawingPaneHandle>(null);
  const [wireTool, setWireTool] = useState<WireframeTool>("select");
  const [wireSelection, setWireSelection] = useState<string | null>(null);
  const [wireFontSize, setWireFontSize] = useState(DEFAULT_FONT_SIZE);
  const [photoSettings, setPhotoSettings] = useState<DrawingSettings>(DEFAULT_DRAWING_SETTINGS);
  const photoRef = useRef<PhotoPaneHandle>(null);

  const [fullscreen, setFullscreen] = useState(false);
  const [annotating, setAnnotating] = useState(false);
  const [annotations, setAnnotations] = useState<HtmlAnnotation[]>([]);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [markersVisible, setMarkersVisible] = useState(true);
  const [draft, setDraft] = useState<AnnotationDraft | null>(null);
  const [draftComment, setDraftComment] = useState("");

  useEffect(() => {
    if (!activity) return;
    const tick = () => setElapsed(Math.floor((Date.now() - activity.startedAt) / 1000));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [activity]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      if (draft) {
        setDraft(null);
        setDraftComment("");
        setAnnotating(true);
        event.preventDefault();
        return;
      }
      if (annotating) {
        setAnnotating(false);
        event.preventDefault();
        return;
      }
      if (fullscreen) {
        setFullscreen(false);
        event.preventDefault();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [annotating, draft, fullscreen]);

  // Other nodes' names and tabs, kept reactive via a joined string so renames
  // and tab switches elsewhere update this node's chips/autocomplete without
  // re-rendering on every drag.
  const mentionKey = useStore((s) =>
    s.nodes
      .map((n) => {
        const nodeData = n.data as PromptNodeData;
        return `${n.id}\u0000${nodeData.name?.trim() ?? ""}\u0000${nodeData.tab ?? "chat"}`;
      })
      .join("\u0001")
  );
  const mentionables = useMemo<Mentionable[]>(
    () =>
      mentionKey
        .split("\u0001")
        .map((entry) => {
          const [nodeId, name, tab] = entry.split("\u0000");
          return { id: nodeId, name, tab: tab as NodeTab };
        })
        .filter((m) => m.name && m.id !== id),
    [mentionKey, id]
  );
  const mentionNames = useMemo(() => mentionables.map((m) => m.name), [mentionables]);

  const sidebarWidth = data.sidebarWidth ?? DEFAULT_SIDEBAR_WIDTH;
  const chatInputHeight = data.chatInputHeight ?? DEFAULT_CHAT_INPUT_HEIGHT;
  const collapsed = data.sidebarCollapsed ?? false;
  const hidden = data.hidden ?? false;
  // Persisted, so reopening a canvas restores each node to the view it was left on.
  const tab = data.tab ?? "chat";
  /** This node's own output type, which colors its title chip. */
  const kind = outputKind(tab);

  // Legacy formats (flat strokes, layers) read as a flat item list; memoized
  // so the draw surface doesn't repaint on unrelated re-renders.
  const drawItems = useMemo(
    () => resolveItems(data.strokes, data.drawLayers, data.drawItems),
    [data.strokes, data.drawLayers, data.drawItems]
  );

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ block: "nearest" });
  }, [data.messages.length, data.loading]);

  // Trailing values keep the iframe from reloading on every keystroke while editing.
  const previewMarkdown = useDebouncedValue(data.markdown ?? "");
  const previewHtml = useDebouncedValue(data.html ?? "");

  // The md tab previews the markdown; chat and html preview the generated
  // document (draw/wire/photo render their own panes instead). Hiding the
  // sidebar keeps whichever tab was last selected, so the preview does not
  // change out from under you.
  const srcDoc = useMemo(() => {
    if (tab === "md") {
      return previewMarkdown.trim() ? markdownDocument(previewMarkdown) : null;
    }
    return previewHtml ? withTailwind(previewHtml) : null;
  }, [tab, previewMarkdown, previewHtml]);

  async function send(prompt: string, images: string[]) {
    if (data.loading) return;

    const pending = annotations;
    const userMessage: ChatMessage = {
      role: "user",
      content: prompt,
      ...(images.length ? { images } : {}),
      ...(pending.length ? { annotations: pending } : {}),
    };
    const baseMessages: ChatMessage[] = [...data.messages, userMessage];
    setAnnotations([]);
    setAnnotating(false);
    setDraft(null);
    setDraftComment("");
    updateNodeData(id, {
      messages: baseMessages,
      loading: true,
      error: null,
      // Zeroed rather than cleared, so the footer ticks up from 0 this run.
      usage: { promptTokens: 0, completionTokens: 0, steps: 0 },
    });

    // Pre-agent transcripts stored whole documents in assistant turns; stub
    // them in the API copy — the route injects the current document anyway.
    const priorMessages: ChatMessage[] = data.messages.map((m) => {
      if (m.role === "assistant" && m.content && looksLikeHtmlDocument(m.content)) {
        return { ...m, content: "(rendered an earlier version of the document)" };
      }
      if (m.role === "user") {
        return {
          role: "user" as const,
          content: userContentForApi(m),
          ...(m.images?.length ? { images: m.images } : {}),
        };
      }
      return m;
    });

    const controller = new AbortController();
    abortRef.current = controller;
    setActivity({ startedAt: Date.now(), tool: null });

    // Mentions expand into the API copy of this turn only; the stored
    // transcript keeps the raw @name text for chip rendering. Mentioned nodes
    // on an image tab (draw/wire/photo) contribute their output as attachments.
    const mentionTargets = getNodes()
      .filter((n) => n.id !== id && n.data.name?.trim())
      .map((n) => ({ name: n.data.name!.trim(), data: n.data }));
    const context = buildMentionContext(prompt, mentionTargets);
    const apiImages = [...images, ...(context?.images ?? [])];
    const extras = [context?.text, formatAnnotations(pending)].filter(Boolean).join("\n\n");
    const apiMessages: ChatMessage[] = [
      ...priorMessages,
      {
        role: "user",
        content: extras ? (prompt ? `${prompt}\n\n${extras}` : extras) : prompt,
        ...(apiImages.length ? { images: apiImages } : {}),
      },
    ];

    try {
      const result = await runAgent({
        apiKey: getApiKey(),
        model: data.model,
        reasoning: data.reasoning ?? DEFAULT_REASONING,
        instructions: getInstructions(canvasId),
        messages: apiMessages,
        html: data.html,
        versions: data.versions ?? [],
        signal: controller.signal,
        onUpdate: (run, usage) => {
          updateNodeData(id, { messages: [...baseMessages, ...run], usage });
          setActivity((a) => (a ? { ...a, tool: null } : a));
        },
        onProgress: (usage, tool) => {
          updateNodeData(id, { usage });
          setActivity((a) => (a ? { ...a, tool } : a));
        },
      });

      // Snapshot the document this run replaced.
      const versions =
        data.html && data.html !== result.html
          ? [...(data.versions ?? []), { html: data.html, ts: Date.now() }].slice(-MAX_VERSIONS)
          : data.versions;

      updateNodeData(id, {
        messages: [...baseMessages, ...compactRun(result.messages)],
        html: result.html,
        versions,
        usage: result.usage,
        loading: false,
      });
    } catch (err) {
      const aborted = err instanceof DOMException && err.name === "AbortError";
      updateNodeData(id, {
        // Drop any partial run lines; the working document was never committed.
        messages: baseMessages,
        loading: false,
        error: aborted ? "canceled" : err instanceof Error ? err.message : "request failed",
      });
    } finally {
      abortRef.current = null;
      setActivity(null);
    }
  }

  function fork() {
    const node = getNode(id);
    if (!node) return;
    const nodeWidth = node.width ?? DEFAULT_NODE_WIDTH;
    const copy: PromptFlowNode = {
      id: crypto.randomUUID(),
      type: "prompt",
      position: { x: node.position.x + nodeWidth + 40, y: node.position.y },
      dragHandle: DRAG_HANDLE_SELECTOR,
      width: nodeWidth,
      height: node.height ?? DEFAULT_NODE_HEIGHT,
      selected: true,
      data: {
        ...data,
        // Names resolve mentions, so the copy must not collide with the original.
        name: data.name?.trim() ? `${data.name.trim()} fork` : undefined,
        messages: [...data.messages],
        loading: false,
        error: null,
      },
    };
    // Deselect everything else, otherwise the source node drags along with the copy.
    setNodes((current) => [...current.map((n) => ({ ...n, selected: false })), copy]);
  }

  function remove() {
    deleteElements({ nodes: [{ id }] });
  }

  // Default names follow the node's type ("wireframe 1", "md 2", …), so a tab
  // switch re-labels them; a name the user typed themselves is never touched.
  function selectTab(next: NodeTab) {
    const current = data.name?.trim() ?? "";
    if (!isDefaultNodeName(current) || (current && matchesTabLabel(current, next))) {
      updateNodeData(id, { tab: next });
      return;
    }
    const taken = getNodes()
      .filter((n) => n.id !== id)
      .map((n) => n.data.name);
    updateNodeData(id, { tab: next, name: defaultNodeName(next, taken) });
  }

  function findByName(name: string) {
    return getNodes().find((n) => n.id !== id && n.data.name?.trim() === name);
  }

  function chipTarget(name: string) {
    const node = findByName(name);
    if (!node) return null;
    return {
      tab: node.data.tab ?? ("chat" as NodeTab),
      html: node.data.html,
      markdown: node.data.markdown ?? null,
      drawing: node.data.drawing ?? null,
      wireframe: node.data.wireframe ?? [],
      photo: node.data.photoMarked ?? node.data.photo ?? null,
      width: node.width ?? DEFAULT_NODE_WIDTH,
      height: node.height ?? DEFAULT_NODE_HEIGHT,
    };
  }

  function jumpTo(name: string) {
    const node = findByName(name);
    if (node) fitView({ nodes: [{ id: node.id }], duration: 600, padding: 0.15, maxZoom: 1 });
  }

  function startSidebarResize(event: React.PointerEvent) {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    // Pointer deltas are in screen pixels; the node is drawn at the canvas zoom level.
    const zoom = fullscreen ? 1 : getZoom();
    const maxWidth = (width ?? DEFAULT_NODE_WIDTH) - MIN_PREVIEW_WIDTH;

    trackPointerDrag((moveEvent) => {
      const next = startWidth + (moveEvent.clientX - startX) / zoom;
      updateNodeData(id, {
        sidebarWidth: Math.round(Math.min(Math.max(next, MIN_SIDEBAR_WIDTH), maxWidth)),
      });
    });
  }

  function startChatInputResize(event: React.PointerEvent) {
    event.preventDefault();
    event.stopPropagation();
    const startY = event.clientY;
    const startHeight = chatInputHeight;
    const zoom = fullscreen ? 1 : getZoom();
    const maxHeight =
      (height ?? DEFAULT_NODE_HEIGHT) - SIDEBAR_CHROME_HEIGHT - MIN_CHAT_LOG_HEIGHT;

    trackPointerDrag((moveEvent) => {
      // The handle sits above the input, so dragging up grows it.
      const next = startHeight - (moveEvent.clientY - startY) / zoom;
      updateNodeData(id, {
        chatInputHeight: Math.round(
          Math.min(Math.max(next, MIN_CHAT_INPUT_HEIGHT), Math.max(maxHeight, MIN_CHAT_INPUT_HEIGHT))
        ),
      });
    });
  }

  const card = (
      <div
        className={`flex h-full w-full flex-col border bg-white ${
          selected || fullscreen ? "border-neutral-900" : "border-neutral-300"
        }`}
      >
        <div
          className={`${DRAG_HANDLE_CLASS} flex min-w-0 items-center gap-2 border-b border-neutral-200 p-2 ${
            fullscreen ? "cursor-default" : "cursor-grab active:cursor-grabbing"
          }`}
        >
          <button
            className="nodrag shrink-0 text-neutral-500 hover:text-neutral-900"
            onClick={() => updateNodeData(id, { sidebarCollapsed: !collapsed })}
            title={collapsed ? "show chat sidebar" : "hide chat sidebar"}
            aria-label={collapsed ? "show chat sidebar" : "hide chat sidebar"}
          >
            <SidebarIcon collapsed={collapsed} />
          </button>
          {/* Styled as its own mention chip, so a node reads the same here and
              wherever it is referenced. min-w-0 lets a long name shrink instead
              of pushing the header actions off the node. */}
          <span className={`${mentionChipClass(kind)} min-w-0 overflow-hidden`}>
            {/* One flex item, so the chip's gap falls only before the icon. */}
            <span className="flex min-w-0 flex-1 items-center">
              @
              <input
                className="nodrag min-w-0 max-w-full cursor-text bg-transparent outline-none placeholder:opacity-50"
                style={{ width: `${Math.max((data.name ?? "").length, 4)}ch` }}
                value={data.name ?? ""}
                onChange={(e) => updateNodeData(id, { name: e.target.value })}
                placeholder="name"
                spellCheck={false}
                title="node name — reference from other chats as @name"
              />
            </span>
            <KindIcon kind={kind} />
          </span>
          <select
            className="nodrag shrink-0 cursor-pointer bg-white text-neutral-500 outline-none hover:text-neutral-900"
            value={customModel ? CUSTOM_MODEL : data.model}
            onChange={(e) => {
              if (e.target.value === CUSTOM_MODEL) {
                setCustomModel(true);
                return;
              }
              setCustomModel(false);
              updateNodeData(id, { model: e.target.value });
            }}
            title="openrouter model"
          >
            {MODEL_GROUPS.map((group) => (
              <optgroup key={group.label} label={group.label}>
                {group.models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label}
                  </option>
                ))}
              </optgroup>
            ))}
            <option value={CUSTOM_MODEL}>custom…</option>
          </select>
          {customModel && (
            <input
              className="nodrag min-w-0 w-40 shrink cursor-text text-neutral-500 outline-none"
              value={data.model}
              onChange={(e) => updateNodeData(id, { model: e.target.value })}
              placeholder="provider/model"
              spellCheck={false}
              title="openrouter model slug"
            />
          )}
          <select
            className="nodrag shrink-0 cursor-pointer bg-white text-neutral-400 outline-none hover:text-neutral-900"
            value={data.reasoning ?? DEFAULT_REASONING}
            onChange={(e) => updateNodeData(id, { reasoning: e.target.value as ReasoningEffort })}
            title="reasoning effort — how long the model may think before acting"
          >
            {REASONING_EFFORTS.map((effort) => (
              <option key={effort} value={effort}>
                think: {effort}
              </option>
            ))}
          </select>
          <span className="min-w-0 flex-1" />
          <span className="group relative inline-flex shrink-0">
            <button
              className={`nodrag ${
                hidden ? "text-neutral-300 hover:text-neutral-500" : "text-neutral-500 hover:text-neutral-900"
              }`}
              onClick={() => updateNodeData(id, { hidden: !hidden })}
              aria-label={hidden ? "include in export" : "exclude from export"}
              aria-pressed={!hidden}
            >
              {hidden ? <EyeClosedIcon /> : <EyeIcon />}
            </button>
            <span className="pointer-events-none absolute top-full right-0 z-30 mt-1 hidden w-52 border border-neutral-300 bg-white p-2 text-neutral-500 group-hover:block">
              {hidden
                ? "Hidden — this node is left out of the canvas export. Click to include it in the generated page."
                : "Visible — this node is included in the canvas export. Click to hide it from the generated page."}
            </span>
          </span>
          <button
            className="nodrag shrink-0 text-neutral-500 hover:text-neutral-900"
            onClick={() => setFullscreen((open) => !open)}
            title={fullscreen ? "exit fullscreen" : "fullscreen — iterate on this node focused"}
            aria-label={fullscreen ? "exit fullscreen" : "fullscreen"}
            aria-pressed={fullscreen}
          >
            {fullscreen ? <CollapseIcon /> : <ExpandIcon />}
          </button>
          <button
            className="nodrag shrink-0 text-neutral-500 hover:text-neutral-900"
            onClick={fork}
            title="fork"
            aria-label="fork"
          >
            <ForkIcon />
          </button>
          <button
            className="nodrag shrink-0 text-neutral-500 hover:text-red-600"
            onClick={remove}
            title="delete"
            aria-label="delete"
          >
            <TrashIcon />
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          {!collapsed && (
            <>
              <div
                className="flex shrink-0 flex-col border-r border-neutral-200"
                style={{ width: sidebarWidth }}
              >
                <div className="flex flex-wrap items-center gap-2 border-b border-neutral-200 p-2">
                  {TAB_GROUPS.map((group) => (
                    // Buttons within a group touch; the parent gap separates groups.
                    <div key={group[0]} className="flex">
                      {group.map((name) => (
                        <button
                          key={name}
                          // The active tab wears its own output color, matching
                          // the node's title chip and its mentions elsewhere.
                          className={`nodrag flex h-6 w-6 items-center justify-center border ${
                            tab === name
                              ? `border-neutral-300 ${kindTextClass(outputKind(name))}`
                              : "border-transparent text-neutral-400 hover:text-neutral-900"
                          }`}
                          onClick={() => selectTab(name)}
                          title={TAB_TITLES[name]}
                          aria-label={name}
                          aria-pressed={tab === name}
                        >
                          <TabIcon tab={name} />
                        </button>
                      ))}
                    </div>
                  ))}
                </div>

                {tab === "chat" && (
                  <>
                    <div className="nowheel min-h-0 flex-1 cursor-auto select-text overflow-y-auto p-2">
                      {data.messages.map((m, i) => {
                        if (m.role === "user") {
                          return (
                            <p key={i} className="m-2 whitespace-pre-wrap">
                              {m.annotations && m.annotations.length > 0 && (
                                <span className="mb-1 flex flex-wrap gap-1">
                                  {m.annotations.map((a) => (
                                    <AnnotationWidget key={a.id} annotation={a} onHover={() => {}} />
                                  ))}
                                </span>
                              )}
                              {m.images && m.images.length > 0 && (
                                <span className="mb-1 flex flex-wrap gap-1">
                                  {m.images.map((src, k) => (
                                    // eslint-disable-next-line @next/next/no-img-element -- data URL thumbnail
                                    <img
                                      key={k}
                                      src={src}
                                      alt="attached"
                                      className="max-h-16 border border-neutral-200"
                                    />
                                  ))}
                                </span>
                              )}
                              {splitMentions(m.content, mentionNames).map((part, j) =>
                                part.type === "text" ? (
                                  <span key={j}>{part.value}</span>
                                ) : (
                                  <MentionChip
                                    key={j}
                                    name={part.name}
                                    target={chipTarget(part.name)}
                                    onJump={() => jumpTo(part.name)}
                                  />
                                )
                              )}
                            </p>
                          );
                        }
                        if (m.role === "tool") {
                          // Successes stay quiet; failures the model had to
                          // recover from (or render errors) are worth seeing.
                          if (!isToolFailure(m.content)) return null;
                          return (
                            <p key={i} className="m-2 ml-4 whitespace-pre-wrap text-red-400">
                              {m.content.slice(0, 300)}
                            </p>
                          );
                        }
                        return (
                          <div key={i}>
                            {m.tool_calls?.map((call, j) => (
                              <p key={j} className="m-2 text-neutral-400">
                                ↳ {call.function.name}
                              </p>
                            ))}
                            {m.content &&
                              // Pre-agent transcripts stored whole documents here.
                              (looksLikeHtmlDocument(m.content) ? (
                                <p className="m-2 text-neutral-400">rendered</p>
                              ) : (
                                <p className="m-2 whitespace-pre-wrap text-neutral-400">
                                  {m.content}
                                </p>
                              ))}
                          </div>
                        );
                      })}
                      {data.loading && (
                        <p className="m-2 text-neutral-400">
                          {activity?.tool ? `${activity.tool}…` : "generating…"}{" "}
                          {formatElapsed(elapsed)}{" "}
                          <button
                            className="nodrag underline hover:text-neutral-900"
                            onClick={() => abortRef.current?.abort()}
                          >
                            cancel
                          </button>
                        </p>
                      )}
                      {data.usage && (data.usage.steps > 0 || data.usage.completionTokens > 0) && (
                        <p className="m-2 text-neutral-300">
                          {formatTokens(data.usage.promptTokens)} in ·{" "}
                          {formatTokens(data.usage.completionTokens)} out · {data.usage.steps}{" "}
                          {data.usage.steps === 1 ? "step" : "steps"}
                        </p>
                      )}
                      {data.error && <p className="m-2 text-red-600">{data.error}</p>}
                      <div ref={chatEndRef} />
                    </div>
                    <div
                      className="nodrag h-1 shrink-0 cursor-row-resize bg-transparent hover:bg-neutral-300"
                      onPointerDown={startChatInputResize}
                      title="drag to resize"
                    />
                    <div
                      className="shrink-0 border-t border-neutral-200 p-2"
                      style={{ height: chatInputHeight }}
                    >
                      <div className="flex h-full min-h-0 gap-1">
                        <div className="flex shrink-0 flex-col gap-1">
                          <button
                            className={`nodrag flex h-6 w-6 items-center justify-center border ${
                              annotating
                                ? "border-neutral-900 text-neutral-900"
                                : srcDoc
                                  ? "border-neutral-300 text-neutral-500 hover:border-neutral-900 hover:text-neutral-900"
                                  : "border-neutral-200 text-neutral-300"
                            }`}
                            disabled={!srcDoc || data.loading}
                            onClick={() => {
                              if (!srcDoc) return;
                              setAnnotating((on) => !on);
                              setDraft(null);
                              setDraftComment("");
                            }}
                            title={
                              srcDoc
                                ? "annotate — point at an element in the preview and leave a comment"
                                : "nothing rendered yet"
                            }
                            aria-label="annotate preview"
                            aria-pressed={annotating}
                          >
                            <AnnotateIcon />
                          </button>
                          {annotations.length > 0 && (
                            <button
                              className={`nodrag flex h-6 w-6 items-center justify-center border ${
                                markersVisible
                                  ? "border-neutral-300 text-neutral-500 hover:text-neutral-900"
                                  : "border-neutral-900 text-neutral-900"
                              }`}
                              onClick={() => setMarkersVisible((on) => !on)}
                              title={markersVisible ? "hide markers" : "show markers"}
                              aria-label={markersVisible ? "hide markers" : "show markers"}
                              aria-pressed={!markersVisible}
                            >
                              {markersVisible ? <EyeIcon /> : <EyeClosedIcon />}
                            </button>
                          )}
                        </div>
                        <div className="min-h-0 min-w-0 flex-1">
                          <MentionInput
                            getOptions={() => mentionables}
                            placeholder="describe the interface… @ to reference another node"
                            disabled={data.loading}
                            allowEmpty={annotations.length > 0}
                            extraAttachments={
                              annotations.length
                                ? annotations.map((a) => (
                                    <AnnotationWidget
                                      key={a.id}
                                      annotation={a}
                                      onHover={setHighlightId}
                                      onRemove={() =>
                                        setAnnotations((current) =>
                                          numberAnnotations(current.filter((x) => x.id !== a.id))
                                        )
                                      }
                                    />
                                  ))
                                : null
                            }
                            onSubmit={send}
                          />
                        </div>
                      </div>
                    </div>
                  </>
                )}

                {tab === "html" && (
                  <CodeEditor
                    language="html"
                    value={data.html ?? ""}
                    onChange={(html) => updateNodeData(id, { html })}
                    placeholder="no source yet"
                  />
                )}

                {tab === "md" && (
                  <CodeEditor
                    language="markdown"
                    value={data.markdown ?? ""}
                    onChange={(markdown) => updateNodeData(id, { markdown })}
                    placeholder="# write an essay…"
                  />
                )}

                {tab === "draw" && (
                  <DrawingToolbar
                    settings={drawSettings}
                    zoom={drawZoom}
                    onChange={setDrawSettings}
                    onUndo={() => drawingRef.current?.undo()}
                    onClear={() => drawingRef.current?.clear()}
                    onFit={() => drawingRef.current?.fit()}
                  />
                )}

                {tab === "wire" && (
                  <WireframeToolbar
                    elements={data.wireframe ?? []}
                    tool={wireTool}
                    selectedId={wireSelection}
                    fontSize={wireFontSize}
                    onToolChange={setWireTool}
                    onSelect={setWireSelection}
                    onChange={(wireframe) => updateNodeData(id, { wireframe })}
                    onFontSizeChange={setWireFontSize}
                  />
                )}

                {tab === "photo" && (
                  <PhotoToolbar
                    photo={data.photo ?? null}
                    hasDrawings={(data.photoStrokes ?? []).length > 0}
                    settings={photoSettings}
                    onChange={(photo) =>
                      updateNodeData(id, { photo, photoStrokes: [], photoMarked: null })
                    }
                    onSettingsChange={setPhotoSettings}
                    onUndo={() => photoRef.current?.undo()}
                    onClearDrawings={() => photoRef.current?.clearDrawings()}
                    onTakePhoto={() => photoRef.current?.startWebcam()}
                  />
                )}
              </div>

              <div
                className="nodrag w-1 shrink-0 cursor-col-resize bg-transparent hover:bg-neutral-300"
                onPointerDown={startSidebarResize}
                title="drag to resize"
              />
            </>
          )}

          <div className="min-w-0 flex-1">
            {tab === "draw" ? (
              <DrawingPane
                items={drawItems}
                base={data.drawBase ?? null}
                settings={drawSettings}
                onCommit={(drawItems, drawing) =>
                  updateNodeData(id, { drawItems, drawing, strokes: undefined, drawLayers: undefined })
                }
                onZoomChange={setDrawZoom}
                handleRef={drawingRef}
              />
            ) : tab === "wire" ? (
              <WireframePane
                elements={data.wireframe ?? []}
                tool={wireTool}
                selectedId={wireSelection}
                fontSize={wireFontSize}
                onToolChange={setWireTool}
                onSelect={setWireSelection}
                onChange={(wireframe) => updateNodeData(id, { wireframe })}
              />
            ) : tab === "photo" ? (
              <PhotoPane
                photo={data.photo ?? null}
                strokes={data.photoStrokes ?? EMPTY_STROKES}
                settings={photoSettings}
                onChange={(photo) =>
                  updateNodeData(id, { photo, photoStrokes: [], photoMarked: null })
                }
                onCommit={(photoStrokes, photoMarked) =>
                  updateNodeData(id, { photoStrokes, photoMarked })
                }
                handleRef={photoRef}
              />
            ) : srcDoc ? (
              <HtmlPreview
                srcDoc={srcDoc}
                title="preview"
                annotating={annotating && !draft}
                annotations={annotations}
                highlightId={highlightId}
                markersVisible={markersVisible}
                onHover={() => {}}
                onLeave={() => {}}
                onPick={(hover, screen) => {
                  setAnnotating(false);
                  setDraft({ ...hover, x: screen.x, y: screen.y });
                  setDraftComment("");
                }}
              />
            ) : (
              <div className="flex h-full items-center justify-center text-neutral-400">
                {data.loading
                  ? "generating…"
                  : tab === "md"
                    ? "nothing written yet"
                    : "nothing rendered yet"}
              </div>
            )}
          </div>
        </div>
      </div>
  );

  return (
    <>
      <NodeResizer
        minWidth={MIN_NODE_WIDTH}
        minHeight={MIN_NODE_HEIGHT}
        isVisible={selected && !fullscreen}
        color="#171717"
        handleStyle={{ width: 8, height: 8, borderRadius: 0 }}
      />
      {fullscreen ? (
        <>
          <div className="flex h-full w-full items-center justify-center border border-neutral-300 bg-neutral-50 text-neutral-400">
            fullscreen
          </div>
          {createPortal(
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-900/30 p-6"
              onPointerDown={() => setFullscreen(false)}
            >
              <div
                className="h-[92vh] w-[92vw] overflow-hidden shadow-lg"
                onPointerDown={(event) => event.stopPropagation()}
              >
                {card}
              </div>
            </div>,
            document.body
          )}
        </>
      ) : (
        card
      )}
      {draft &&
        createPortal(
          <form
            className="nodrag nowheel fixed z-[70] w-56 border border-neutral-900 bg-white p-1 shadow-sm"
            style={{
              left: Math.min(Math.max(8, draft.x), window.innerWidth - 240),
              top: Math.min(Math.max(8, draft.y), window.innerHeight - 80),
            }}
            onSubmit={(event) => {
              event.preventDefault();
              const comment = draftComment.trim();
              if (!comment) return;
              setAnnotations((current) =>
                numberAnnotations([
                  ...current,
                  {
                    id: crypto.randomUUID(),
                    n: 0,
                    label: draft.label,
                    selector: draft.selector,
                    tag: draft.tag,
                    text: draft.text,
                    comment,
                  },
                ])
              );
              setDraft(null);
              setDraftComment("");
              setAnnotating(true);
            }}
          >
            <p className="truncate px-1 text-neutral-400">{draft.label}</p>
            <input
              autoFocus
              className="nodrag w-full px-1 outline-none"
              placeholder="what should change?"
              value={draftComment}
              onChange={(event) => setDraftComment(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  setDraft(null);
                  setDraftComment("");
                  setAnnotating(true);
                }
              }}
            />
          </form>,
          document.body
        )}
    </>
  );
}

export default memo(PromptNode);
