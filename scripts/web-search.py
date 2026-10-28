"""Bounded, no-key DDGS bridge. Input/output are single JSON messages.

The pinned DDGS auto backend prioritizes encyclopedias and hides non-200 HTTP
responses as empty results. Use explicit web backends and inspect their local
HTTP boundary instead. No provider message, URL diagnostic or credential leaves
this process. Install requirements-search.txt into work/search-venv.
"""
import contextlib
import io
import json
import logging
import re
import sys
import time
from urllib.parse import urlsplit, urlunsplit

BACKENDS = ("yahoo", "brave", "duckduckgo", "mojeek", "startpage")
MAX_SEARCH_SECONDS = 40
MAX_REQUEST_SECONDS = 8


class SearchFailure(Exception):
    """Only controlled state crosses the provider boundary."""

    def __init__(self, status):
        self.status = status
        super().__init__(status)


def normalize_results(hits, query, limit):
    # Engines occasionally ignore site: operators. Such hits cannot satisfy the
    # original query; do not rewrite the query or broaden it to obtain results.
    sites = [value.lower().rstrip(".") for value in re.findall(r"(?:^|\s)site:([a-zA-Z0-9.-]+)(?=\s|$)", query)]
    if len(sites) != 1 or re.search(r"\b(?:OR|NOT)\b|[()]", query):
        sites = []  # Leave complex operator semantics to the search provider.
    results, seen = [], set()
    for hit in hits[:100]:
        raw_url = str(hit.get("href") or hit.get("url") or "")
        if len(raw_url) > 4096:
            continue
        try:
            parsed = urlsplit(raw_url)
            if parsed.scheme != "https" or not parsed.hostname or "." not in parsed.hostname or parsed.username or parsed.password:
                continue
            if sites and not any(parsed.hostname == site or parsed.hostname.endswith("." + site) for site in sites):
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
    return results


def page_state(text):
    """Conservative recognition: unknown markup is not a healthy empty search."""
    from lxml import html
    try:
        tree = html.fromstring(text)
    except (ValueError, TypeError):
        return "unparsed"
    title = " ".join(tree.xpath("//title//text()")).lower()
    if re.search(r"captcha|robot|access denied|blocked|verify.{0,30}human|security check", title):
        return "blocked"
    if tree.xpath("//form[@id='challenge-form' or @id='anomaly-form'] | //*[@id='captcha' or @id='captcha-form']"):
        return "blocked"
    empty_nodes = tree.xpath("//*[contains(@class,'no-results') or contains(@class,'no_results') or contains(@class,'compNoResult')]")
    phrases = ("no results found", "no results were found", "we did not find results for", "your search did not match any documents")
    for node in empty_nodes:
        if any(phrase in " ".join(node.itertext()).lower() for phrase in phrases):
            return "empty"
    # Yahoo may render its no-result sentence outside a named container.
    if tree.xpath("//*[self::p or self::div][starts-with(normalize-space(text()), 'We did not find results for')]"):
        return "empty"
    return "unparsed"


def search(query, limit, timeout_ms=45000, *, client_factory=None, clock=time.monotonic):
    """At most five backends, sharing one deadline and the unchanged query."""
    from ddgs import DDGS
    from ddgs.exceptions import TimeoutException
    region = "cn-zh" if any("\u4e00" <= char <= "\u9fff" for char in query) else "us-en"
    deadline = clock() + min(MAX_SEARCH_SECONDS, max(0.001, (timeout_ms - 500) / 1000))
    attempts = []
    for backend in BACKENDS:
        if clock() >= deadline:
            break
        attempt = {"backend": backend, "status": "unavailable", "resultCount": 0}
        observed = {"page": "unparsed", "requestFailed": False}
        try:
            with (client_factory or DDGS)(timeout=MAX_REQUEST_SECONDS) as client:
                # Local instance hooks are intentional and covered by focused
                # tests against the pinned DDGS API. No global monkey-patching.
                selected = client._get_engines("text", backend)
                if len(selected) != 1 or selected[0].name != backend:
                    raise SearchFailure("unavailable")  # Never fall back to DDGS auto.
                engine = selected[0]
                original_request = engine.http_client.request

                def request(*args, **kwargs):
                    remaining = deadline - clock()
                    if remaining <= 0:
                        observed["requestFailed"] = True
                        attempt["status"] = "timeout"
                        raise SearchFailure("timeout")
                    kwargs["timeout"] = min(MAX_REQUEST_SECONDS, remaining)
                    try:
                        response = original_request(*args, **kwargs)
                    except TimeoutException:
                        observed["requestFailed"] = True
                        attempt["status"] = "timeout"
                        raise SearchFailure("timeout") from None
                    except Exception:
                        observed["requestFailed"] = True
                        attempt["status"] = "unavailable"
                        raise SearchFailure("unavailable") from None
                    attempt["httpStatus"] = response.status_code
                    if response.status_code != 200:
                        observed["requestFailed"] = True
                        attempt["status"] = "blocked" if response.status_code in (202, 401, 403, 429) else "unavailable"
                        raise SearchFailure(attempt["status"])
                    observed["page"] = page_state(response.text)
                    if observed["page"] == "blocked":
                        observed["requestFailed"] = True
                        attempt["status"] = "blocked"
                        raise SearchFailure("blocked")
                    return response

                engine.http_client.request = request
                hits = client.text(query, max_results=limit, backend=backend, region=region)
                results = normalize_results(hits, query, limit)
                if results:
                    attempt.update(status="ok", resultCount=len(results))
                    attempts.append(attempt)
                    return {"provider": "ddgs", "status": "ok", "results": results, "attempts": attempts}
                attempt["status"] = "empty" if observed["page"] == "empty" else "unparsed"
        except Exception:
            # DDGS also raises DDGSException for legitimate zero results. Only
            # a recognized no-result page authorizes a healthy empty outcome.
            if attempt.get("httpStatus") == 200 and not observed["requestFailed"]:
                attempt["status"] = "empty" if observed["page"] == "empty" else "unparsed"
        attempts.append(attempt)
    # One engine's genuine empty page does not establish that other engines
    # have no matching pages. Keep trying within this same query/deadline.
    if any(attempt["status"] == "empty" for attempt in attempts):
        return {"provider": "ddgs", "status": "empty", "results": [], "attempts": attempts}
    code = "SEARCH_TIMEOUT" if clock() >= deadline or (attempts and all(item["status"] == "timeout" for item in attempts)) else "SEARCH_UNAVAILABLE"
    return {"provider": "ddgs", "status": "unavailable", "error": code, "results": [], "attempts": attempts}


def main():
    request = json.loads(sys.stdin.buffer.read(16385))
    query = request.get("query")
    limit = request.get("limit", 5)
    timeout_ms = request.get("timeoutMs", 45000)
    if not isinstance(query, str) or not 1 <= len(query.strip()) <= 240 or any(ord(char) < 32 or ord(char) == 127 for char in query):
        raise ValueError("Invalid query")
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 8:
        raise ValueError("Invalid limit")
    if isinstance(timeout_ms, bool) or not isinstance(timeout_ms, int) or not 1 <= timeout_ms <= 45000:
        raise ValueError("Invalid timeout")
    logging.disable(logging.CRITICAL)
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        response = search(query.strip(), limit, timeout_ms)
    sys.stdout.write(json.dumps(response, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except BaseException:
        # Structured failures deliberately exit zero so the Node bridge can
        # retain only these controlled codes, never arbitrary child diagnostics.
        sys.stdout.write(json.dumps({"provider": "ddgs", "status": "unavailable", "error": "SEARCH_CONFIG", "results": [], "attempts": []}))
