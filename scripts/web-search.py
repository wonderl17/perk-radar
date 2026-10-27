"""Bounded, no-key search bridge. Input and output are single JSON messages.

Install requirements-search.txt into work/search-venv or select a Python runtime
with PERK_SEARCH_PYTHON. No Hermes configuration or model credential is read.
"""
import contextlib
import io
import json
import logging
import sys
from urllib.parse import urlsplit, urlunsplit


def main():
    request = json.loads(sys.stdin.buffer.read(16385))
    query = request.get("query")
    limit = request.get("limit", 5)
    if not isinstance(query, str) or not 1 <= len(query.strip()) <= 240:
        raise ValueError("Invalid query")
    if any(ord(char) < 32 or ord(char) == 127 for char in query):
        raise ValueError("Invalid query")
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 8:
        raise ValueError("Invalid limit")
    logging.disable(logging.CRITICAL)
    # A provider's diagnostics must never share the result pipe or caller logs.
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        from ddgs import DDGS
        with DDGS(timeout=15) as client:
            region = "cn-zh" if any("\u4e00" <= char <= "\u9fff" for char in query) else "wt-wt"
            hits = client.text(query.strip(), max_results=limit, backend="auto", region=region)
        results = []
        seen = set()
        for hit in hits[:100]:
            raw_url = str(hit.get("href") or hit.get("url") or "")
            if len(raw_url) > 4096:
                continue
            try:
                parsed = urlsplit(raw_url)
                if parsed.scheme != "https" or not parsed.hostname or "." not in parsed.hostname or parsed.username or parsed.password:
                    continue
                url = urlunsplit((parsed.scheme, parsed.netloc, parsed.path, parsed.query, ""))
            except (ValueError, TypeError):
                continue
            title = str(hit.get("title") or "").strip()[:240]
            if not title or url in seen:
                continue
            seen.add(url)
            results.append({"title": title, "url": url, "description": str(hit.get("body") or hit.get("description") or "").strip()[:1200]})
            if len(results) >= limit:
                break
    sys.stdout.write(json.dumps({"provider": "ddgs", "results": results}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except BaseException:
        sys.stdout.write(json.dumps({"provider": "ddgs", "error": "Web search failed."}))
        sys.exit(1)
