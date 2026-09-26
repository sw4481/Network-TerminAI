# RAG library — user guide

> Plan 12 Phase 6 close-out. The RAG (Retrieval-Augmented Generation)
> library lets the in-app AI assistant cite **your own** vendor
> documentation when answering CCIE-style questions. It runs entirely
> on your machine — embeddings are generated locally, vectors are
> stored in your existing SQLite database, and no PDF or chunk text
> ever leaves your laptop.

## What it's for

Out of the box, the AI assistant relies on its training data, which is
generic and frequently a year or more out of date for vendor commands
that change between LTS releases. The RAG library lets you upload the
**exact** documentation you trust (Cisco IOS-XE 17.x command reference,
your team's MOP wiki export, internal runbooks, scraped Meraki API
notes) and have the assistant ground every answer in those documents.

Concretely:

- You upload PDF / HTML / Markdown / plain-text files via the
  Settings → RAG tab.
- The app extracts text, splits it into ~250-token chunks, and runs
  each chunk through a local ONNX MiniLM model to produce a 384-dim
  embedding vector. Both text and vector are stored in your existing
  `sessions.db`.
- When you chat with the assistant, the active terminal session's
  vendor (Cisco/Juniper/Arista/Meraki) determines a **tag filter**;
  the assistant only sees chunks tagged for that vendor (plus
  `generic`).
- The retrieved chunks are injected as a `system`-role prefix into
  the chat. A **Sources** badge appears under the assistant's reply;
  clicking it opens a drawer that shows the full chunk text, document
  title, chunk index, and similarity score.

If retrieval finds nothing relevant, the assistant falls back to its
base behavior — no error, no confusing "no sources" header, just no
badge.

## Uploading documents

1. Open Settings (gear icon) and click the **RAG** tab.
2. Drag and drop one or more files onto the drop zone, **or** click
   `+ Add document` to use the native file picker.
3. The upload modal appears. Pick at least one tag from the taxonomy
   (see below). The same tags apply to every file in a single upload.
4. Click **Upload**. A pipeline ribbon shows the four phases:
   `extract → chunk → embed → persist`. When all four complete the
   row joins the document list at the top.

**Supported formats:**

| Kind  | Extension(s)        | Notes                                |
|-------|---------------------|---------------------------------------|
| PDF   | `.pdf`              | Text-extracted via PyMuPDF; scanned-image PDFs without OCR yield empty chunks. |
| HTML  | `.html`, `.htm`     | DOM-stripped; styles and scripts dropped. |
| MD    | `.md`, `.markdown`  | Treated as plain text; fences are kept. |
| TXT   | `.txt`              | UTF-8 expected. |

You can drop multiple files at once. They share a single set of tags
(the modal applies the picked tags to every file in the batch).

## Tag taxonomy

There are exactly **seven** tags. They are validated at the Rust
command layer and enforced again by the React picker — no free-form
tagging.

| Tag                   | Meaning                                                              |
|-----------------------|----------------------------------------------------------------------|
| `cisco-iosxe-switch`  | IOS-XE running on a Catalyst switch (e.g. C9300, C9500)              |
| `cisco-iosxe-router`  | IOS-XE running on an ISR/ASR router (e.g. ISR4000, ASR1000)          |
| `cisco-nxos`          | Cisco Nexus / NX-OS (any 3k/5k/7k/9k)                                |
| `cisco-meraki`        | Meraki Dashboard API and MX/MR/MS device docs                        |
| `juniper-junos`       | Juniper Junos OS (MX, EX, SRX, QFX)                                  |
| `arista-eos`          | Arista EOS (any 7000-series, CloudVision)                            |
| `generic`             | Vendor-agnostic — runbooks, BGP RFCs, your team's internal MOP wiki  |

**`generic` is automatically included on every retrieval.** You don't
need to tag a doc both `cisco-nxos` and `generic`; if it's vendor-
specific, just tag it with the vendor. The Rust retriever
(`src-tauri/src/rag/retrieve.rs`) unions the active session's vendor
tag with `generic` before filtering.

A doc can carry **multiple** vendor tags (e.g. an IOS-XE feature guide
that applies to both routers and switches gets tagged
`cisco-iosxe-router` + `cisco-iosxe-switch`).

## How the AI uses your library

When you send a chat message, before any tokens are generated:

1. The Rust side calls `derive_tags_for_tab(tab_id)` to pick the
   active session's vendor tag (or `generic` if no SSH session is
   attached to the tab).
2. It calls `rag_retrieve(query, tags=[<vendor>, "generic"], k=5)`
   — top-5 chunks by cosine distance against your embedded query.
3. Retrieved chunks are formatted as a `system` prefix message:

   ```text
   # Retrieved Documentation (use these as authoritative; cite by [doc#chunk])
   [doc=12 chunk=3 tags=cisco-iosxe-router] ip route 0.0.0.0 0.0.0.0 ...
   [doc=12 chunk=4 tags=cisco-iosxe-router] On a stack member, ...
   [doc=7  chunk=0 tags=generic]            BGP best-path selection ...
   ```

4. The sidecar streams the assistant's reply tokens as usual; before
   the first token the Rust layer emits an `agent.sources` event so
   the UI can render the Sources badge immediately.

If `rag_retrieve` returns zero chunks, **no system prefix is added** —
the assistant behaves exactly as it did pre-Phase 5.

### Sources badge & drawer

Under any assistant turn that used retrieval, a small **`Sources: N
docs`** badge appears. Clicking it opens a right-side drawer listing
every chunk that fed the answer:

- Document title
- Tag chips
- Chunk index
- Cosine distance (lower = more similar; e.g. `0.14` is a near match)
- The chunk's text body
- A `Copy` button per chunk

The drawer traps focus, closes on Esc, and closes on outside-click.
A11y is mirrored from the existing settings overlays.

## Privacy

**Everything stays on disk on your machine.**

- Documents and chunk text live in your existing SQLite database
  (`~/Library/Application Support/ccie-terminal/sessions.db` on macOS,
  the platform equivalent on Linux/Windows). No remote service.
- Embeddings are generated by an **ONNX MiniLM-L6-v2 model bundled
  with the app**. The bundle is set up at build time
  (`sidecar/scripts/build_sidecar.sh` populates `model.onnx` +
  `tokenizer.json`); no model API call is made on first run.
- The vector index uses the `sqlite-vec` extension (loaded as a
  shared library at startup) — same DB, same file, same backups.
- The chat path that uses retrieval still calls the AI provider you
  configured (Anthropic / OpenAI / Ollama / vLLM / Gemini). The
  retrieved chunk text **does** travel to your provider as part of
  the chat prompt — that's how the assistant cites them. If your
  policy forbids sending those chunks externally, run a local
  provider (Ollama or vLLM) and the entire retrieval-+-chat round
  trip stays on your laptop.

## Optional starter pack

If you don't have any docs yet and want a small public baseline:

1. Open Settings → RAG.
2. Scroll to the bottom of the document list.
3. Click **Download starter pack** (teal button, secondary action).

The button:

- Spawns `scripts/seed-rag/seed.py` (Python; uses `httpx`).
- Downloads the URLs catalogued in `scripts/seed-rag/sources.json` to
  `~/.ccie-terminal/rag-seed/`.
- After the script exits, the UI iterates the seed directory and
  uploads each new file via the standard `rag_upload` path.
- Skips already-uploaded docs (matched on title) so re-clicking is a
  safe no-op.

The pack ships URLs only — **no PDFs are bundled with the app**. Vendor
license terms vary; the script downloads to your local machine only.

If a vendor blocks anonymous downloads (HTTP 403/429), the script logs
a friendly message recommending a manual download from a logged-in
browser session, then continues with the next entry. You can always
drop the manually-downloaded PDF into Settings → RAG.

The default `sources.json` only includes URLs verified at packaging
time. Several major vendors (Cisco IOS-XE/NX-OS, Arista EOS) gate
their PDFs behind anti-crawler protection or a customer login; those
are deliberately omitted with a comment in `sources.json` listing the
reason.

## Removing documents

In the document list, hover a row and click `[ × ]`. The button arms a
two-step delete: it swaps to `[ Confirm delete ]` and only removes the
doc on the second click. There's no undo.

What happens on the backend:

- The row is optimistically removed from the UI.
- Rust calls `rag_delete_document(doc_id)` which cascades:
  - `rag_documents` row deleted.
  - Each `rag_chunks` row for that document deleted.
  - The matching `rag_chunks_vec` (vec0 virtual table) entries
    deleted.
- The next chat turn no longer sees those chunks.

Re-uploading the same file after deletion creates fresh chunks and
fresh embeddings — there's no merge-with-history. If you need history,
keep the doc in place and rely on the chunks being immutable per
upload.

## Troubleshooting

**The Sources badge never appears.**
Check the active tab's session: the badge only renders when retrieval
returns at least one chunk. If you have no docs uploaded at all, or no
docs whose tags match your session's vendor (plus `generic`), the
fallback path skips the badge by design.

**The starter-pack button errors with `python interpreter not found`.**
Install Python 3 from your package manager (`brew install python3`,
`apt install python3`, etc.) or build the sidecar
(`sidecar/scripts/build_sidecar.sh`). The button uses the bundled
sidecar interpreter when present and falls back to `python3` from
your `$PATH`.

**An upload sticks at the `embedding` phase.**
The ONNX model is large (~80 MB). On the first chat turn after a
fresh app install, the sidecar warms up the embedder lazily; once
warm it stays in memory. If you see embedding hang for >60 s with
no progress, check `sidecar/.venv` is populated and the sidecar
process is alive (Settings → Diagnostics → Sidecar status).

**Retrieval returns nothing useful for a vendor-specific query.**
Make sure your docs are tagged with the right vendor. The retriever
filters strictly: a `cisco-iosxe-switch` query won't surface a
`cisco-nxos` chunk even if the cosine distance is small. Use the
`generic` tag for vendor-neutral material (RFCs, generic BGP guides).

## Reference

- Design specs: [`docs/design/rag-settings-tab.md`](../design/rag-settings-tab.md), [`docs/design/rag-sources-drawer.md`](../design/rag-sources-drawer.md)
- sqlite-vec strategy: [`docs/rag/sqlite-vec-research.md`](./sqlite-vec-research.md)
- Seed script: [`scripts/seed-rag/`](../../scripts/seed-rag/)
