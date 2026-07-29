# RAG seed pack — vendor reference docs (optional)

This directory hosts an **opt-in, user-triggered** download script that
hydrates `~/.ccie-terminal/rag-seed/` with publicly-available vendor
documentation that the in-app RAG retrieval can then ingest. **Nothing
in this directory is bundled with CCIE Terminal itself** — the app
ships with an empty knowledge base by default.

## License note

> Vendor documentation PDFs are retrieved from public vendor websites;
> their licenses permit personal use but may restrict redistribution.
> The seed script downloads them to the user's local machine only —
> nothing is bundled with CCIE Terminal itself.

If you intend to share docs across a team, use the per-vendor portal
(Cisco support contract, Juniper TechLibrary login, Arista support
account) and mirror them on your own infrastructure. Don't redistribute
this directory's contents.

## Usage

### From the UI (recommended)

1. Launch CCIE Terminal.
2. Open **Settings → RAG**.
3. Scroll to the bottom of the document list.
4. Click **"Download starter pack"**.
5. The button shows `Downloading… N/M`; when complete, the docs appear
   in the list automatically.

The button calls a Tauri command (`rag_run_seed_script`) which spawns
this directory's `seed.py` and streams its progress over a Tauri event.
After the script exits, the UI iterates `~/.ccie-terminal/rag-seed/`
and uploads each new file via `rag_upload`.

### From the command line (manual)

```bash
cd scripts/seed-rag
python3 seed.py
```

This will:
- Read `sources.json` from the same directory.
- Download each entry to `~/.ccie-terminal/rag-seed/<slug>.<ext>` with
  the User-Agent header `CCIE-Terminal-Seed/1.0`, retry on transient
  errors (3 attempts, exponential backoff), and skip entries that
  return 403 or 429 with a friendly message.
- Print progress as `seed: downloaded X/Y` lines on stdout.

After the script finishes you still need to upload the files into the
app — easiest way is to open Settings → RAG and click **"Download
starter pack"** (idempotent: already-downloaded files are kept; only
new files are uploaded).

## Idempotency

- The script checks for an existing destination file before
  downloading; existing files are kept.
- The UI button checks `rag_list_documents` for a matching
  `source_path` before calling `rag_upload`; already-uploaded docs are
  skipped.

You can safely re-run the seed script or re-click the button any
number of times — the only side effect is to fill in any newly-added
entries in `sources.json`.

## Caveats

- Vendor sites may rate-limit or block anonymous downloads. The script
  sets `User-Agent: CCIE-Terminal-Seed/1.0` and respects the standard
  HTTP retry/backoff conventions. On HTTP 403 or 429 the script logs a
  message recommending a manual download from a logged-in browser
  session, then continues with the next entry.
- The default `sources.json` only includes URLs verified on the date
  in each entry's `accessed` field. Several major vendors (Cisco
  cisco.com, Arista support portal) gate their PDFs behind anti-crawler
  protection or a login; those entries are deliberately omitted with a
  comment in `sources.json` listing the reason. You can drop those
  PDFs into Settings → RAG manually after downloading them in a
  browser.
- Only `httpx` is required. Install via:
  ```bash
  python3 -m pip install httpx
  ```

## Tests

```bash
cd scripts/seed-rag
python3 -m pytest seed.test.py -v
```

The tests use mocked `httpx` and never touch the network. If `httpx`
is not installed in the local interpreter, pytest skips the suite via
`pytest.importorskip`.
