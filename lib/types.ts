/** OpenAI-style function call, as OpenRouter returns it. */
export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

/** A comment pinned to an element in the HTML preview, in the Agentation style. */
export type HtmlAnnotation = {
  id: string;
  /** 1-based marker number, matching the badge in the preview. */
  n: number;
  /** Short label shown on the cursor and chip, e.g. `button.submit-btn`. */
  label: string;
  /** CSS selector path the model can grep for. */
  selector: string;
  tag: string;
  /** Nearby text content, when the element has any. */
  text?: string;
  comment: string;
};

export type ChatMessage =
  | { role: "user"; content: string; images?: string[]; annotations?: HtmlAnnotation[] }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: ToolCall[];
      /** Provider reasoning blocks; some models require them back mid-run. */
      reasoning_details?: Record<string, unknown>[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

/** A superseded document, snapshotted whenever a generation replaces `html`. */
export type DocVersion = {
  html: string;
  ts: number;
};

/** How hard the model may think before acting; "off" disables reasoning. */
export type ReasoningEffort = "off" | "low" | "medium" | "high";

export const REASONING_EFFORTS: ReasoningEffort[] = ["off", "low", "medium", "high"];
export const DEFAULT_REASONING: ReasoningEffort = "low";

/** Token totals for a node's most recent agent run, updated live per step. */
export type RunUsage = {
  promptTokens: number;
  completionTokens: number;
  steps: number;
};

/**
 * Which editor a node's sidebar is showing, and so what its main panel
 * renders. The selected tab is also the node's output: @-mentioning a node
 * from another chat sends whatever its current tab holds.
 */
export type NodeTab = "chat" | "html" | "md" | "draw" | "wire" | "photo";

export type WireframeKind =
  | "box"
  | "ellipse"
  | "line"
  | "arrow"
  | "text"
  | "button"
  | "input"
  | "image";

export type WireframeElement = {
  id: string;
  kind: WireframeKind;
  /** Top-left corner for shapes; the start point for line/arrow. */
  x: number;
  y: number;
  /** Size for shapes; the delta to the end point (may be negative) for line/arrow. */
  w: number;
  h: number;
  label?: string;
  /** Text elements only; other labeled kinds render at the default size. */
  fontSize?: number;
};

/** One freehand stroke on the infinite draw surface, in world coordinates. */
export type DrawStroke = {
  color: string;
  width: number;
  /** Flat [x0, y0, x1, y1, …] — compact, since these live in localStorage. */
  points: number[];
};

/** A flood-filled region on the draw surface, stored as a bitmap patch. */
export type DrawImage = {
  /** World-space rect the image occupies. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** PNG data URL. */
  data: string;
};

export type DrawItem =
  | { kind: "stroke"; stroke: DrawStroke }
  | { kind: "image"; image: DrawImage };

/** Legacy layered drawing format, flattened into drawItems on first edit. */
export type DrawLayer = {
  id: string;
  name: string;
  visible: boolean;
  items: DrawItem[];
};

export type PromptNodeData = {
  model: string;
  messages: ChatMessage[];
  html: string | null;
  markdown?: string | null;
  /** Hand-drawn sketch from the draw tab, rasterized to a PNG data URL. */
  drawing?: string | null;
  /** Legacy flat stroke list, migrated into drawItems on first edit. */
  strokes?: DrawStroke[];
  /** Legacy layered format, flattened into drawItems on first edit. */
  drawLayers?: DrawLayer[];
  drawItems?: DrawItem[];
  /**
   * A sketch made before the draw surface became infinite, kept as a fixed
   * backdrop at the origin so nothing drawn back then is lost.
   */
  drawBase?: string | null;
  wireframe?: WireframeElement[];
  /** Uploaded reference photo from the photo tab, as a data URL. */
  photo?: string | null;
  /** Freehand marks on the photo, in the image's natural pixel space. */
  photoStrokes?: DrawStroke[];
  /** Photo with strokes baked in; what mentions and previews send. */
  photoMarked?: string | null;
  /** Referenced from other nodes' chats as @name. */
  name?: string;
  /** Nodes are exported unless this is set; scratch work can stay off the page. */
  hidden?: boolean;
  versions?: DocVersion[];
  usage?: RunUsage;
  reasoning?: ReasoningEffort;
  tab?: NodeTab;
  sidebarWidth?: number;
  sidebarCollapsed?: boolean;
  chatInputHeight?: number;
  loading?: boolean;
  error?: string | null;
};

export type StoredNode = {
  id: string;
  type: "prompt";
  position: { x: number; y: number };
  width?: number;
  height?: number;
  data: PromptNodeData;
};

export type CanvasMeta = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
};

/** How `exportCanvas` arranges nodes in the generated file. */
export type ExportLayout = "stacked" | "canvas";

export const DEFAULT_MODEL = "moonshotai/kimi-k3";

export const DEFAULT_NODE_WIDTH = 720;
export const DEFAULT_NODE_HEIGHT = 440;
export const MIN_NODE_WIDTH = 360;
export const MIN_NODE_HEIGHT = 240;

export const DEFAULT_SIDEBAR_WIDTH = 240;
export const MIN_SIDEBAR_WIDTH = 160;

export const DEFAULT_CHAT_INPUT_HEIGHT = 80;
export const MIN_CHAT_INPUT_HEIGHT = 48;

/** Size of a legacy fixed-canvas sketch, and the framing for a fresh draw view. */
export const SKETCH_WIDTH = 1024;
export const SKETCH_HEIGHT = 768;

export const MAX_VERSIONS = 20;
export const MAX_AGENT_STEPS = 10;

/** Only the header drags the node, so text elsewhere stays selectable. */
export const DRAG_HANDLE_CLASS = "node-drag-handle";
export const DRAG_HANDLE_SELECTOR = `.${DRAG_HANDLE_CLASS}`;

export const API_KEY_STORAGE_KEY = "proto:openrouter-key";
export const INSTRUCTIONS_STORAGE_KEY = "proto:instructions";
export const EXPORT_LAYOUT_STORAGE_KEY = "proto:export-layout";
