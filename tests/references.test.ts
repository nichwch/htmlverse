import { packCaptureStyles } from "../lib/captureStyles";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import assert from "node:assert/strict";
import { parseCapture, MAX_CAPTURE_SIZE } from "../lib/capture";
import test from "node:test";
import { forkNodes, migrateMessageReferences, resolveMessageParts, snapshotReferences, userMessageForApi } from "../lib/mentions";
import { nodePhotos, photoSources } from "../lib/photos";
import type { ChatMessage, PromptNodeData, StoredNode } from "../lib/types";

const data = (overrides: Partial<PromptNodeData> = {}): PromptNodeData => ({ model: "test", messages: [], html: null, ...overrides });
const node = (id: string, overrides: Partial<PromptNodeData> = {}): StoredNode => ({ id, type: "prompt", position: { x: 0, y: 0 }, data: data(overrides) });

test("continued and forked chats replay the original text and all reference images after edits, renames, or deletion", () => {
  const targets = [node("spec", { name: "brief", tab: "md", markdown: "ORIGINAL BRIEF" }), node("photos", { name: "photos", tab: "photo", photos: [
    { id: "p1", name: "one", src: "original-one", marked: "marked-one", strokes: [] },
    { id: "p2", name: "two", src: "original-two", marked: null, strokes: [] },
  ] })];
  const content = "Use @photos and @brief, then @photos again.";
  const parts = resolveMessageParts([{ type: "text", value: content }], targets);
  const message: Extract<ChatMessage, { role: "user" }> = { role: "user", content, parts, images: ["attached"], referenceContext: snapshotReferences(parts, targets) };
  const expected = userMessageForApi(message);
  targets[0].data.name = "renamed";
  targets[0].data.markdown = "CHANGED";
  targets[1].data.photos = [];
  const savedFork = JSON.parse(JSON.stringify(message));
  assert.deepEqual(userMessageForApi(savedFork), expected);
  assert.match(expected.content!, /ORIGINAL BRIEF/);
  assert.deepEqual(expected.role === "user" && expected.images, ["attached", "marked-one", "original-two"]);
  assert.equal(parts.filter((part) => part.type === "mention" && part.nodeId === "photos").length, 2);
});

test("typed names respect boundaries, spaces, regex characters, and ambiguity; chips retain identity", () => {
  const targets = [node("a", { name: "photo" }), node("b", { name: "photo 2" }), node("c", { name: "a+b" }), node("d", { name: "duplicate" }), node("e", { name: "duplicate" })];
  const parts = resolveMessageParts([{ type: "text", value: "@photo 2 @photo @a+b @photograph user@photo.com @duplicate" }], targets);
  assert.deepEqual(parts.filter((part) => part.type === "mention").map((part) => part.nodeId), ["b", "a", "c"]);
  assert.deepEqual(resolveMessageParts([{ type: "mention", nodeId: "e", name: "duplicate" }], targets), [{ type: "mention", nodeId: "e", name: "duplicate" }]);
});

test("whole-canvas fork remaps links but keeps historical snapshots and source untouched", () => {
  const reference = node("a", { name: "brief", tab: "md", markdown: "original" });
  const parts = resolveMessageParts([{ type: "text", value: "@brief" }], [reference]);
  const message: ChatMessage = { role: "user", content: "@brief", parts, referenceContext: snapshotReferences(parts, [reference]) };
  const original = [reference, node("b", { messages: [message] })];
  let count = 0;
  const copied = forkNodes(original, () => `copy-${++count}`);
  const forkMessage = copied[1].data.messages[0];
  assert.equal(forkMessage.role, "user");
  if (forkMessage.role !== "user") return;
  assert.equal(forkMessage.parts?.[0].type === "mention" && forkMessage.parts[0].nodeId, "copy-1");
  assert.deepEqual(forkMessage.referenceContext, message.referenceContext);
  assert.equal(parts[0].type === "mention" && parts[0].nodeId, "a");
});

test("legacy migration is one-time, marks recovered context, and does not bind later name reuse", () => {
  const migrated = migrateMessageReferences([node("a", { name: "brief", tab: "md", markdown: "available" }), node("b", { messages: [{ role: "user", content: "@brief @missing" }] })]);
  const message = migrated[1].data.messages[0];
  assert.equal(message.role === "user" && message.referenceContext?.recovered, true);
  const before = JSON.stringify(message);
  migrated[0].data.name = "renamed";
  migrated[0].data.markdown = "changed";
  const twice = migrateMessageReferences([...migrated, node("c", { name: "missing" })]);
  assert.equal(JSON.stringify(twice[1].data.messages[0]), before);
});

test("legacy photos retain marks and an explicitly empty gallery never resurrects a removed photo", () => {
  assert.deepEqual(photoSources(data({ photo: "original", photoMarked: "marked" })), ["marked"]);
  assert.equal(nodePhotos(data({ photo: "original" }))[0].id, "legacy-photo");
  assert.deepEqual(nodePhotos(data({ photos: [], photo: "legacy" })), []);
});

test("capture nodes contribute editable HTML to referenced chats", () => {
  const targets = [node("captured", { name: "captured card", tab: "capture", html: '<article>Captured card</article>' })];
  const parts = resolveMessageParts([{ type: "text", value: "Iterate on @captured card" }], targets);
  const reference = snapshotReferences(parts, targets);
  assert.ok(reference);
  assert.match(reference.text, /<article>Captured card<\/article>/);
});


test("capture import validates format, version, content and size before replacing HTML", () => {
  const capture = { format: "proto-capture", version: 1, title: "Card", source: "http://localhost:3000/example", html: "<article>Card</article>" };
  assert.deepEqual(parseCapture(JSON.stringify(capture)), capture);
  for (const invalid of ["plain text", "null", "{}", JSON.stringify({ ...capture, version: 2 }), JSON.stringify({ ...capture, html: " " })]) {
    assert.throws(() => parseCapture(invalid));
  }
  assert.throws(() => parseCapture("x".repeat(MAX_CAPTURE_SIZE + 1)), /too large/);
});


test("style packing preserves each element's exact declarations without leaking defaults", () => {
  const styles: [string, string][][] = [
    [["color", "red"], ["display", "flex"], ["width", "100px"]],
    [["color", "blue"], ["display", "flex"], ["width", "200px"]],
    [["color", "red"], ["font-weight", "700"]],
    [],
  ];
  const packed = packCaptureStyles(styles);
  const declarations = new Map<string, [string, string][]>();
  for (const match of packed.css.matchAll(/data-proto-style~="(c\d+)"\]\{([^}]+)\}/g)) {
    declarations.set(match[1], match[2].split(";").filter(Boolean).map(declaration => {
      const colon = declaration.indexOf(":");
      return [declaration.slice(0, colon), declaration.slice(colon + 1)];
    }));
  }
  styles.forEach((expected, index) => {
    const actual = packed.tokens[index].split(" ").flatMap(token => declarations.get(token) ?? []);
    assert.deepEqual(Object.fromEntries(actual), Object.fromEntries(expected));
  });
  const repeated = Array.from({ length: 300 }, () => styles[0]);
  const compact = packCaptureStyles(repeated);
  assert.ok(compact.css.length + compact.tokens.join(" ").length < JSON.stringify(repeated).length / 10);
  const source = readFileSync("public/capture.js", "utf8");
  const helper = source.slice(source.indexOf("  function packCaptureStyles("), source.indexOf("  const key = '__protoCaptureCancel'"));
  const bookmarkletPacker = runInNewContext(helper + ";packCaptureStyles");
  assert.deepEqual(JSON.parse(JSON.stringify(bookmarkletPacker(styles))), packed);
});
