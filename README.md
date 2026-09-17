# proto

A canvas for prototyping interfaces fast. Create nodes — each node is half chat, half window. The window renders the HTML that the chat prompts the model into producing. Fork a node to branch an idea and compare variants side by side.

## Setup

```bash
npm install
npm run dev
```

Open http://localhost:3000, paste your [OpenRouter](https://openrouter.ai/) API key into the top bar, and create a node.

## How it works

- Each node has its own model (defaults to `anthropic/claude-fable-5`) and its own chat history.
- Every reply is a full self-contained HTML document, rendered in a sandboxed iframe. Each turn fully replaces the previous render; the old render stays visible until the new one is ready.
- Forking copies the chat history and the last rendered artifact.
- The whole canvas (nodes, positions, chats, artifacts) and your API key persist in localStorage. The key is only sent to the server per-request and never stored there.

## Stack

Next.js (App Router) + Tailwind + [React Flow](https://reactflow.dev/) + OpenRouter.


## Capture from another project

Open a node’s **Capture** tab (beside Chat and HTML) and drag **Send to canvas** to your bookmarks bar. Open your other project, click that bookmark, then hover and click a component. Press **↑** to expand selection to its parent or **Esc** to cancel.

Paste the copied capture into the Capture tab and click **Import capture**. If clipboard access is unavailable, use **Download file** in the capture overlay, then **Import file** in the node. Captures become the node’s normal HTML output; use Chat to iterate, HTML to edit, and fork to compare versions. Replacing existing HTML saves it in version history.

The bookmarklet runs locally and includes rendered styles and form values (excluding passwords). Captures are static: application behavior, pseudo-elements, shadow DOM, embedded frames, some fonts, and assets requiring authentication may not transfer. Some sites block bookmarklets. Nothing is sent to the model until you prompt the node.


Captures now consolidate repeated computed CSS into shared rules, including when importing captures made with an older bookmarklet. The current bookmarklet includes matching accessible `@font-face` rules and embeds font files within a 1 MB asset budget. Fonts from inaccessible cross-origin stylesheets or failed/oversized downloads can still fall back. Replace an existing bookmark with the current **Send to canvas** link to receive these capture changes. Importing older captures reduces their size, but cannot recover font definitions that were never captured.
