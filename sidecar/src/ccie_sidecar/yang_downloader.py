"""
YANG model downloader and indexer.

Downloads YANG files from github.com/YangModels/yang using Git Data API
to avoid rate limits, saves them to the cache directory, and parses metadata.
"""

import os
from pathlib import Path
from typing import Iterator

import requests


def download_yang_release(
    vendor: str,
    os_name: str,
    release: str,
    cache_base: str,
) -> Iterator[dict]:
    """
    Download YANG files from a YangModels/yang release directory.

    Uses GitHub's Git Data API to fetch the tree recursively in one request,
    then downloads individual files via raw URLs (which don't count against API limits).

    Args:
        vendor: Vendor name (e.g., "cisco", "juniper")
        os_name: OS name (e.g., "xe", "nxos", "junos")
        release: Release version (e.g., "17151", "10.3R1")
        cache_base: Base cache directory (e.g., ~/.ccie-terminal/yang-cache)

    Yields:
        Progress events:
        - {"type": "start", "path": str}
        - {"type": "fetching_tree"}
        - {"type": "progress", "files_done": int, "files_total": int, "current_file": str}
        - {"type": "done", "cache_dir": str, "file_count": int}
        - {"type": "error", "message": str}
    """
    path = f"vendor/{vendor}/{os_name}/{release}"
    yield {"type": "start", "path": path}

    try:
        # Create cache directory
        cache_dir = Path(cache_base) / vendor / os_name / release
        cache_dir.mkdir(parents=True, exist_ok=True)

        yield {"type": "fetching_tree"}

        # Get the main branch SHA
        branch_url = "https://api.github.com/repos/YangModels/yang/git/refs/heads/main"
        branch_resp = requests.get(branch_url, timeout=30)
        branch_resp.raise_for_status()
        main_sha = branch_resp.json()["object"]["sha"]

        # Get the commit to find the tree SHA
        commit_url = f"https://api.github.com/repos/YangModels/yang/git/commits/{main_sha}"
        commit_resp = requests.get(commit_url, timeout=30)
        commit_resp.raise_for_status()
        tree_sha = commit_resp.json()["tree"]["sha"]

        # Get the recursive tree (includes all files in one request)
        tree_url = f"https://api.github.com/repos/YangModels/yang/git/trees/{tree_sha}?recursive=1"
        tree_resp = requests.get(tree_url, timeout=60)
        tree_resp.raise_for_status()
        tree = tree_resp.json()["tree"]

        # Filter for .yang files in our target path (exact directory match)
        yang_files = [
            item for item in tree
            if item["type"] == "blob"
            and item["path"].startswith(path + "/")
            and item["path"].endswith(".yang")
        ]

        total_files = len(yang_files)

        if total_files == 0:
            yield {
                "type": "error",
                "message": f"No YANG files found at {path}. Check that the release exists.",
            }
            return

        downloaded = 0

        # Download each file via raw GitHub URL (doesn't count against API rate limit)
        for item in yang_files:
            file_path_str = item["path"]
            # Remove the base path to get relative path
            relative_path = file_path_str[len(path)+1:]  # +1 for the leading slash
            local_path = cache_dir / relative_path

            # Create subdirectories if needed
            local_path.parent.mkdir(parents=True, exist_ok=True)

            # Download via raw URL
            raw_url = f"https://raw.githubusercontent.com/YangModels/yang/main/{file_path_str}"
            file_resp = requests.get(raw_url, timeout=30)
            file_resp.raise_for_status()

            local_path.write_bytes(file_resp.content)
            downloaded += 1

            yield {
                "type": "progress",
                "files_done": downloaded,
                "files_total": total_files,
                "current_file": local_path.name,
            }

        yield {
            "type": "done",
            "cache_dir": str(cache_dir),
            "file_count": downloaded,
        }

    except requests.exceptions.HTTPError as e:
        if e.response and e.response.status_code == 404:
            yield {
                "type": "error",
                "message": f"Release not found: {vendor}/{os_name}/{release}. Check the release exists on GitHub.",
            }
        else:
            yield {"type": "error", "message": f"HTTP error: {e}"}
    except KeyError as e:
        yield {"type": "error", "message": f"Unexpected GitHub API response format: {e}"}
    except Exception as e:
        yield {"type": "error", "message": str(e)}


def index_yang_modules(cache_dir: str) -> list[dict]:
    """
    Parse YANG files in a cache directory and extract metadata.

    Args:
        cache_dir: Path to extracted release cache directory

    Returns:
        List of module metadata dicts with keys:
        - name: Module name
        - namespace: Module namespace URI (if present)
        - revision: Latest revision date (if present)
        - file_path: Absolute path to .yang file
    """
    modules = []
    cache_path = Path(cache_dir)

    # Find all .yang files recursively
    for yang_file in cache_path.rglob("*.yang"):
        try:
            metadata = parse_yang_metadata(str(yang_file))
            if metadata:
                modules.append(metadata)
        except Exception as e:
            # Log parse failures to stderr (not stdout, which is JSON stream)
            import sys
            print(f"Warning: Failed to parse {yang_file}: {e}", file=sys.stderr)

    return modules


def parse_yang_metadata(file_path: str) -> dict | None:
    """
    Extract name, namespace, and revision from a YANG file.

    Uses simple text parsing (not full pyang) for speed.
    Looks for:
    - module <name> or submodule <name>
    - namespace "<uri>";
    - revision "YYYY-MM-DD" (takes the latest)

    Args:
        file_path: Path to .yang file

    Returns:
        Dict with {name, namespace, revision, file_path} or None if invalid
    """
    with open(file_path, "r", encoding="utf-8", errors="ignore") as f:
        content = f.read()

    lines = content.splitlines()
    name = None
    namespace = None
    revisions = []

    for line in lines:
        stripped = line.strip()

        # module <name> { or module <name>;
        if stripped.startswith("module ") and not name:
            parts = stripped.split()
            if len(parts) >= 2:
                name = parts[1].rstrip("{;")

        # submodule <name> { or submodule <name>;
        if stripped.startswith("submodule ") and not name:
            parts = stripped.split()
            if len(parts) >= 2:
                name = parts[1].rstrip("{;")

        # namespace "<uri>";
        if stripped.startswith("namespace ") and not namespace:
            # Extract quoted string
            if '"' in stripped:
                start = stripped.index('"') + 1
                end = stripped.index('"', start)
                namespace = stripped[start:end]

        # revision "YYYY-MM-DD"
        if stripped.startswith("revision "):
            if '"' in stripped:
                start = stripped.index('"') + 1
                end = stripped.index('"', start)
                rev_date = stripped[start:end]
                revisions.append(rev_date)

    if not name:
        return None

    # Use latest revision if multiple
    revision = max(revisions) if revisions else None

    return {
        "name": name,
        "namespace": namespace,
        "revision": revision,
        "file_path": file_path,
    }
