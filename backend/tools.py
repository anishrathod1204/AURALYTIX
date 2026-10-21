"""External information providers used by the AURALYTIX research flow."""

import json
import importlib.util
import os
import re
from concurrent.futures import ThreadPoolExecutor, as_completed, TimeoutError as FuturesTimeoutError
from datetime import datetime, timezone
from html import unescape
from email.utils import parsedate_to_datetime
from pathlib import PurePosixPath
from typing import Any, Dict, List, Optional
from urllib.parse import parse_qs, quote, urlparse
import xml.etree.ElementTree as ET

import requests
from bs4 import BeautifulSoup

HTTP_HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128.0.0.0 Safari/537.36"}
PLACEHOLDER_PATTERN = re.compile(r"your[-_ ]|replace[-_ ]|placeholder|example|change[-_]?me|x{4,}|<[^>]+>", re.I)
GITHUB_SECRET_PATTERN = re.compile(
    r"(?i)((?:api[_-]?key|access[_-]?token|secret|password|authorization)\s*[:=]\s*[\"']?)([^\s\"',;]+)"
)
GITHUB_TOKEN_PATTERN = re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-[A-Za-z0-9_-]{24,})\b")
COMMON_SECRET_PATTERN = re.compile(r"\b(?:AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|xox[baprs]-[A-Za-z0-9-]{20,})\b")
PRIVATE_KEY_PATTERN = re.compile(
    r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?-----END [A-Z0-9 ]*PRIVATE KEY-----",
    re.S,
)
SEARCH_FILLER_WORDS = {
    "what", "when", "where", "which", "who", "why", "how", "does", "did", "do", "is", "are", "was", "were",
    "the", "a", "an", "and", "or", "but", "for", "from", "with", "into", "about", "this", "that", "these",
    "those", "in", "on", "at", "to", "of", "by", "it", "its", "me", "my", "please", "show", "find", "search",
    "latest", "recent", "today", "week", "breaking", "current", "change", "changes", "changed", "changing",
    "news", "headlines", "happen", "happened", "happening", "tell", "give", "explain", "know", "want", "need",
}


def paid_apis_enabled() -> bool:
    """Paid provider integrations are opt-in; public/free fallbacks remain available."""
    return os.getenv("ENABLE_PAID_APIS", "false").strip().lower() in {"1", "true", "yes", "on"}


def configured_secret(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value or PLACEHOLDER_PATTERN.search(value):
        return ""
    return value


def _safe_url(value: Optional[str]) -> str:
    if not value:
        return ""
    parsed = urlparse(value.strip())
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return ""
    return value.strip()


def _plain_text(value: Any) -> str:
    text = str(value or "")
    if re.search(r"</?[A-Za-z][^>]*>", text):
        return BeautifulSoup(text, "html.parser").get_text(" ", strip=True)
    return unescape(" ".join(text.split()))


def _unwrap_duckduckgo_url(value: str) -> str:
    parsed = urlparse(value)
    if parsed.hostname and parsed.hostname.endswith("duckduckgo.com"):
        destination = parse_qs(parsed.query).get("uddg", [""])[0]
        return _safe_url(destination)
    return _safe_url(value)


def duckduckgo_search(query: str, limit: int = 6) -> List[Dict[str, Any]]:
    """Search the public DuckDuckGo HTML endpoint when no paid search key is set."""
    try:
        response = requests.get(
            "https://html.duckduckgo.com/html/",
            params={"q": query},
            headers=HTTP_HEADERS,
            timeout=(1, 2),
        )
        response.raise_for_status()
        soup = BeautifulSoup(response.text, "html.parser")
        results: List[Dict[str, Any]] = []
        for result in soup.select(".result"):
            title_el = result.select_one(".result__a")
            if not title_el:
                continue
            url = _unwrap_duckduckgo_url(title_el.get("href", ""))
            if not url:
                continue
            snippet_el = result.select_one(".result__snippet")
            results.append({
                "title": title_el.get_text(" ", strip=True) or "Untitled result",
                "url": url,
                "snippet": snippet_el.get_text(" ", strip=True) if snippet_el else "",
                "site": urlparse(url).hostname or "",
            })
            if len(results) >= limit:
                break
        return results
    except requests.RequestException:
        return []


def _rss_search(url: str, params: Dict[str, str], limit: int = 6, result_type: str = "Web", unwrap_bing: bool = False) -> List[Dict[str, Any]]:
    """Read a public RSS search feed and normalize its items into source records."""
    try:
        response = requests.get(url, params=params, headers=HTTP_HEADERS, timeout=(1, 2))
        response.raise_for_status()
        root = ET.fromstring(response.content)
        results: List[Dict[str, Any]] = []
        for item in root.findall(".//item"):
            title = item.findtext("title") or "Untitled result"
            item_url = item.findtext("link") or ""
            if unwrap_bing and item_url:
                destination = parse_qs(urlparse(item_url).query).get("url", [""])[0]
                item_url = destination or item_url
            item_url = _safe_url(item_url)
            if not item_url:
                continue
            description = item.findtext("description") or ""
            source_node = item.find("source")
            source = (source_node.text or "").strip() if source_node is not None else ""
            source = source or (urlparse(item_url).hostname or "")
            results.append({
                "title": _plain_text(title),
                "url": item_url,
                "snippet": _plain_text(description),
                "site": source,
                "publishedAt": item.findtext("pubDate"),
                "type": result_type,
            })
            if len(results) >= limit:
                break
        if result_type == "News":
            oldest = datetime.min.replace(tzinfo=timezone.utc)
            def published_at(item: Dict[str, Any]) -> datetime:
                try:
                    parsed = parsedate_to_datetime(item.get("publishedAt") or "")
                    return parsed.astimezone(timezone.utc) if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
                except (TypeError, ValueError, OverflowError):
                    return oldest
            results.sort(key=published_at, reverse=True)
        return results
    except (requests.RequestException, ET.ParseError, ValueError, TypeError):
        return []


def _bing_web_search(query: str, limit: int = 6) -> List[Dict[str, Any]]:
    return _rss_search(
        "https://www.bing.com/search",
        {"q": query, "format": "rss"},
        limit=limit,
        result_type="Web",
        unwrap_bing=True,
    )


def _bing_news_search(query: str, limit: int = 6) -> List[Dict[str, Any]]:
    return _rss_search(
        "https://www.bing.com/news/search",
        {"q": query, "format": "rss"},
        limit=limit,
        result_type="News",
        unwrap_bing=True,
    )


def _google_news_search(query: str, limit: int = 6) -> List[Dict[str, Any]]:
    return _rss_search(
        "https://news.google.com/rss/search",
        {"q": query, "hl": "en-US", "gl": "US", "ceid": "US:en"},
        limit=limit,
        result_type="News",
    )


def _wikipedia_search(query: str, limit: int = 6) -> List[Dict[str, Any]]:
    """Use Wikipedia's public search API as a grounded fallback for reference queries."""
    try:
        response = requests.get(
            "https://en.wikipedia.org/w/api.php",
            params={"action": "query", "list": "search", "srsearch": query, "format": "json", "utf8": "1", "srlimit": limit},
            headers=HTTP_HEADERS,
            timeout=(1, 2),
        )
        response.raise_for_status()
        pages = response.json().get("query", {}).get("search", [])
        results = []
        for page in pages[:limit]:
            page_id = page.get("pageid")
            if not page_id:
                continue
            results.append({
                "title": page.get("title") or "Wikipedia reference",
                "url": "https://en.wikipedia.org/?curid=" + str(page_id),
                "snippet": _plain_text(page.get("snippet")),
                "site": "Wikipedia",
                "type": "Reference",
            })
        return results
    except (requests.RequestException, ValueError, TypeError):
        return []


def _search_query_variants(query: str) -> List[str]:
    """Keep the full question and add focused variants for multi-part searches."""
    original = re.sub(r"\s+", " ", (query or "").strip())
    if not original:
        return []
    variants: List[str] = []
    seen = set()

    def add(value: str) -> None:
        cleaned = re.sub(r"\s+", " ", value).strip(" \t\n,.;:?!")
        key = cleaned.casefold()
        if cleaned and key not in seen:
            seen.add(key)
            variants.append(cleaned)

    add(original)
    clauses = re.split(r"\b(?:and|while|whereas|versus|vs\.?)\b", original, flags=re.I)
    for clause in clauses:
        clause_terms = [
            term for term in re.findall(r"[a-z0-9]+", clause.lower())
            if (len(term) > 2 or term in {"ai", "uk", "us"}) and term not in SEARCH_FILLER_WORDS
        ]
        if len(clause_terms) >= 2:
            add(" ".join(clause_terms))

    topic_terms = [
        term for term in re.findall(r"[a-z0-9]+", original.lower())
        if (len(term) > 2 or term in {"ai", "uk", "us"}) and term not in SEARCH_FILLER_WORDS
    ]
    if len(topic_terms) >= 2:
        add(" ".join(topic_terms[:16]))
    return variants[:4]


def github_repo_target(query: str) -> Optional[Dict[str, str]]:
    """Return a validated public GitHub owner/repository target found in a query."""
    for raw_url in re.findall(r"https?://[^\s<>\"]+", query or "", flags=re.I):
        candidate = raw_url.rstrip(".,;:!?)]}")
        parsed = urlparse(candidate)
        if (parsed.hostname or "").lower() not in {"github.com", "www.github.com"}:
            continue
        parts = [part for part in parsed.path.split("/") if part]
        if len(parts) < 2:
            continue
        owner, repository = parts[0], parts[1]
        if repository.endswith(".git"):
            repository = repository[:-4]
        if not re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?", owner):
            continue
        if not re.fullmatch(r"[A-Za-z0-9_.-]{1,100}", repository) or repository in {".", ".."}:
            continue
        repo_url = f"https://github.com/{owner}/{repository}"
        return {"owner": owner, "name": repository, "url": repo_url}
    return None


def _github_get_json(url: str, max_bytes: int = 2_500_000) -> Optional[Dict[str, Any]]:
    """Read a bounded response from GitHub's public API without credentials."""
    response = None
    try:
        response = requests.get(
            url,
            headers={"Accept": "application/vnd.github+json", "User-Agent": "AURALYTIX-read-only-repository-review"},
            timeout=(2, 5),
            stream=True,
            allow_redirects=False,
        )
        if response.status_code != 200:
            return None
        chunks = []
        total = 0
        for chunk in response.iter_content(chunk_size=16_384):
            if not chunk:
                continue
            total += len(chunk)
            if total > max_bytes:
                return None
            chunks.append(chunk)
        data = json.loads(b"".join(chunks).decode("utf-8"))
        return data if isinstance(data, dict) else None
    except (requests.RequestException, UnicodeDecodeError, ValueError, TypeError):
        return None
    finally:
        if response is not None:
            response.close()


def _github_read_raw(url: str, max_bytes: int = 20_000) -> str:
    """Read a small text excerpt from raw.githubusercontent.com only."""
    response = None
    try:
        response = requests.get(url, headers=HTTP_HEADERS, timeout=(2, 4), stream=True, allow_redirects=True)
        if (urlparse(response.url).hostname or "").lower() != "raw.githubusercontent.com":
            return ""
        if response.status_code != 200:
            return ""
        chunks = []
        total = 0
        for chunk in response.iter_content(chunk_size=4096):
            if not chunk:
                continue
            remaining = max_bytes - total
            chunks.append(chunk[:remaining])
            total += min(len(chunk), remaining)
            if total >= max_bytes:
                break
        content = b"".join(chunks).decode("utf-8", errors="replace")
        if "\x00" in content:
            return ""
        content = PRIVATE_KEY_PATTERN.sub("[REDACTED PRIVATE KEY]", content)
        content = GITHUB_SECRET_PATTERN.sub(r"\1[REDACTED]", content)
        return COMMON_SECRET_PATTERN.sub("[REDACTED TOKEN]", GITHUB_TOKEN_PATTERN.sub("[REDACTED TOKEN]", content))
    except requests.RequestException:
        return ""
    finally:
        if response is not None:
            response.close()


def _github_excerpt(text: str, max_lines: int = 12, max_chars: int = 900) -> str:
    lines = []
    for index, line in enumerate(text.splitlines()[:max_lines], start=1):
        line = re.sub(r"\s+", " ", line).strip()
        if len(line) > 180:
            line = line[:177] + "..."
        lines.append(f"{index:>3}: {line}")
    excerpt = "\n".join(lines)
    return excerpt[:max_chars]


def github_repo_analysis(query: str) -> Dict[str, Any]:
    """Inspect a public GitHub repository's docs and source excerpts without running it."""
    target = github_repo_target(query)
    if not target:
        return {"error": "Paste a public GitHub repository URL to inspect its files.", "sources": []}

    owner, name, repo_url = target["owner"], target["name"], target["url"]
    api_root = f"https://api.github.com/repos/{quote(owner, safe='')}/{quote(name, safe='')}"
    metadata = _github_get_json(api_root)
    if not metadata:
        return {
            **target,
            "error": "I could not read this repository from GitHub. Check that it is public and try again; GitHub's unauthenticated API may also be rate limited.",
            "sources": [],
            "files_analyzed": 0,
        }

    branch = str(metadata.get("default_branch") or "main")
    tree = _github_get_json(f"{api_root}/git/trees/{quote(branch, safe='')}?recursive=1")
    entries = tree.get("tree", []) if tree else []
    visible_entries = [
        entry for entry in entries
        if isinstance(entry, dict) and entry.get("type") == "blob" and isinstance(entry.get("path"), str)
    ]

    manifest_names = {"package.json", "pyproject.toml", "requirements.txt", "cargo.toml", "go.mod", "pom.xml", "composer.json", "gemfile"}
    readmes = [entry for entry in visible_entries if PurePosixPath(entry["path"]).name.lower().startswith("readme")]
    readmes.sort(key=lambda entry: ("/" in entry["path"], len(entry["path"])))
    manifests = [entry for entry in visible_entries if PurePosixPath(entry["path"]).name.lower() in manifest_names]
    manifests.sort(key=lambda entry: ("/" in entry["path"], len(entry["path"])))

    code_extensions = {".py", ".js", ".jsx", ".ts", ".tsx", ".go", ".rs", ".java", ".rb", ".php", ".cs", ".sh"}
    excluded_parts = {".git", "node_modules", "vendor", "dist", "build", "coverage", "__pycache__", "tests", "test", "docs", "examples"}
    source_candidates = []
    preferred_names = {"main", "index", "app", "server", "search", "agent", "api", "cli", "inspect", "reverse", "analyze"}
    for entry in visible_entries:
        path = entry["path"]
        path_parts = {part.lower() for part in PurePosixPath(path).parts}
        file_path = PurePosixPath(path)
        if path_parts & excluded_parts or file_path.suffix.lower() not in code_extensions:
            continue
        if int(entry.get("size") or 0) > 30_000:
            continue
        preferred = file_path.stem.lower() in preferred_names
        source_root = any(part.lower() in {"src", "app", "backend", "server", "lib"} for part in file_path.parts[:-1])
        source_candidates.append((not preferred, not source_root, len(file_path.parts), len(path), entry))
    source_candidates.sort(key=lambda item: item[:4])

    selected: List[Dict[str, Any]] = []
    seen_paths = set()
    for entry in (readmes[:1] + manifests[:2] + [item[4] for item in source_candidates[:4]]):
        path = entry["path"]
        if path in seen_paths or int(entry.get("size") or 0) > 30_000:
            continue
        seen_paths.add(path)
        selected.append(entry)
        if len(selected) >= 6:
            break

    sources: List[Dict[str, Any]] = []
    raw_base = f"https://raw.githubusercontent.com/{quote(owner, safe='')}/{quote(name, safe='')}/{quote(branch, safe='/')}"
    blob_base = f"{repo_url}/blob/{quote(branch, safe='/')}"
    def read_selected(entry: Dict[str, Any]) -> tuple[Dict[str, Any], str]:
        path = entry["path"]
        raw_url = f"{raw_base}/{quote(path, safe='/')}"
        return entry, _github_read_raw(raw_url)

    with ThreadPoolExecutor(max_workers=max(1, min(6, len(selected)))) as executor:
        downloaded = list(executor.map(read_selected, selected))
    for entry, content in downloaded:
        path = entry["path"]
        if not content:
            continue
        excerpt = _github_excerpt(content, max_lines=12 if PurePosixPath(path).name.lower().startswith("readme") else 14)
        if not excerpt:
            continue
        is_readme = PurePosixPath(path).name.lower().startswith("readme")
        sources.append({
            "type": "Repository overview" if is_readme else "Repository file",
            "title": f"{owner}/{name} / {path}",
            "url": f"{blob_base}/{quote(path, safe='/')}",
            "site": "GitHub",
            "description": ("Read-only excerpt; code was not run:\n" if not is_readme else "Public README excerpt:\n") + excerpt,
        })

    summary_parts = [f"Public repository: {owner}/{name}."]
    if metadata.get("description"):
        summary_parts.append(f"Description: {str(metadata['description'])[:350]}")
    if metadata.get("language"):
        summary_parts.append(f"Primary language: {str(metadata['language'])[:80]}.")
    summary_parts.append("Analysis is limited to public documentation and small source excerpts. Repository code was not executed, so runtime behavior is unverified.")
    if tree and tree.get("truncated"):
        summary_parts.append("GitHub reported a truncated file tree, so the inspected file list may be incomplete.")
    summary = " ".join(summary_parts)
    files_analyzed = len(sources)
    sources.insert(0, {
        "type": "Repository summary",
        "title": f"{owner}/{name} repository overview",
        "url": repo_url,
        "site": "GitHub",
        "description": summary,
    })
    return {
        **target,
        "branch": branch,
        "language": metadata.get("language"),
        "summary": summary,
        "files_analyzed": files_analyzed,
        "tree_truncated": bool(tree and tree.get("truncated")),
        "error": None if files_analyzed else "GitHub returned the repository, but no readable documentation or source excerpts were available.",
        "sources": sources,
    }


def _relevant_results(query: str, results: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    stop_words = {
        "what", "when", "where", "which", "who", "why", "how", "does", "did", "do", "is", "are", "was", "were",
        "the", "a", "an", "and", "or", "but", "for", "from", "with", "into", "about", "this", "that", "these",
        "those", "in", "on", "at", "to", "of", "by", "it", "its", "me", "my", "please", "show", "find", "search",
        "latest", "recent", "today", "week", "breaking", "current", "change", "changes", "changed", "changing",
        "news", "headlines", "happen", "happened", "happening", "tell", "give", "explain", "know", "want", "need",
    }
    def normalize_token(token: str) -> str:
        if len(token) > 4 and token.endswith("ies"):
            return token[:-3] + "y"
        if len(token) > 5 and token.endswith("ing"):
            return token[:-3]
        if len(token) > 4 and token.endswith("ed"):
            return token[:-2]
        if len(token) > 4 and token.endswith("s"):
            return token[:-1]
        return token

    def tokenize(value: str) -> List[str]:
        return [normalize_token(token) for token in re.findall(r"[a-z0-9]+", value.lower())]

    terms = []
    for term in re.findall(r"[a-z0-9]+", query.lower()):
        if (len(term) > 2 or term in {"ai", "uk", "us"}) and term not in stop_words:
            normalized = normalize_token(term)
            if normalized not in terms:
                terms.append(normalized)
    if not terms:
        return results

    # Long questions often contain context and wording that will not appear in a
    # page title. Keep a relevance floor while preventing those extra words from
    # filtering out every useful result.
    required_matches = 1 if len(terms) == 1 else max(2, min(5, int(len(terms) * 0.3 + 0.999)))
    query_clauses = []
    for clause in re.split(r"\b(?:and|while|whereas|versus|vs\.?)\b", query, flags=re.I):
        clause_terms = {normalize_token(term) for term in re.findall(r"[a-z0-9]+", clause.lower())
                        if (len(term) > 2 or term in {"ai", "uk", "us"}) and term not in stop_words}
        if len(clause_terms) >= 2:
            query_clauses.append(clause_terms)
    ranked = []
    for index, item in enumerate(results):
        title = (item.get("title") or "").lower()
        snippet = (item.get("snippet") or item.get("description") or "").lower()
        title_terms = set(tokenize(title))
        snippet_terms = set(tokenize(snippet))
        matched = [term for term in terms if term in title_terms or term in snippet_terms]
        if len(matched) < required_matches:
            continue

        title_matches = sum(term in title_terms for term in matched)
        snippet_matches = sum(term in snippet_terms for term in matched)
        core_phrase = " ".join(terms)
        normalized_text = " ".join(re.findall(r"[a-z0-9]+", title + " " + snippet))
        score = (title_matches * 3) + snippet_matches + (len(matched) / len(terms))
        if core_phrase and core_phrase in normalized_text:
            score += 2
        # Reward sources that cover separate parts of a compound question.
        score += sum(1.5 for clause in query_clauses if len(clause & (title_terms | snippet_terms)) >= 2)
        ranked.append((score, index, item))

    ranked.sort(key=lambda result: (-result[0], result[1]))
    return [item for _score, _index, item in ranked]


def web_search(query: str) -> List[Dict[str, Any]]:
    """Use paid Serper only when explicitly enabled; otherwise search public indexes."""
    api_key = configured_secret("SERPER_API_KEY") if paid_apis_enabled() else ""
    if api_key:
        try:
            response = requests.post(
                "https://google.serper.dev/search",
                headers={"X-API-KEY": api_key, "Content-Type": "application/json"},
                json={"q": query, "num": 6},
                timeout=(1, 2),
            )
            response.raise_for_status()
            data = response.json()
            results = []
            for item in data.get("organic", [])[:6]:
                url = _safe_url(item.get("link"))
                if not url:
                    continue
                results.append({
                    "title": item.get("title") or "Untitled result",
                    "url": url,
                    "snippet": item.get("snippet") or "",
                    "site": urlparse(url).hostname or "",
                })
            relevant = _relevant_results(query, results)
            if relevant:
                return relevant
        except (requests.RequestException, ValueError, TypeError):
            pass
    # Search the complete question and focused clauses across both free public
    # indexes. Parallel calls keep the extra coverage from adding serial latency.
    results = []
    variants = _search_query_variants(query)[:3]
    executor = ThreadPoolExecutor(max_workers=max(2, len(variants) * 2))
    searches = []
    for variant in variants:
        searches.append(executor.submit(duckduckgo_search, variant, 4))
        searches.append(executor.submit(_bing_web_search, variant, 4))
    try:
        for search in as_completed(searches, timeout=2.8):
            try:
                results.extend(search.result())
            except Exception:
                continue
            if len(results) >= 8:
                break
    except FuturesTimeoutError:
        pass
    finally:
        executor.shutdown(wait=False, cancel_futures=True)

    unique_results = []
    seen_urls = set()
    for item in results:
        url = item.get("url")
        if url and url not in seen_urls:
            seen_urls.add(url)
            unique_results.append(item)
    relevant = _relevant_results(query, unique_results)
    if relevant:
        return relevant[:10]
    # When no page covers enough of the full wording, retain evidence that
    # directly matches an individual part rather than returning an empty search.
    focused_results = []
    focused_urls = set()
    for variant in variants[1:]:
        for item in _relevant_results(variant, unique_results):
            url = item.get("url")
            if url and url not in focused_urls:
                focused_urls.add(url)
                focused_results.append(item)
    if focused_results:
        return focused_results[:10]
    results = _wikipedia_search(query, limit=6)
    return _relevant_results(query, results) or results


def news_search(query: str) -> List[Dict[str, Any]]:
    """Retrieve recent news through paid NewsAPI only when enabled or public feeds."""
    topic_query = re.sub(
        r"\b(?:find|search|show|give me|latest|recent|breaking|news|headlines|about|youtube|videos?|lectures?|tutorials?|watch|this week|today|what changed|current events)\b",
        " ",
        query,
        flags=re.I,
    )
    topic_query = re.sub(r"\s+", " ", topic_query).strip(" ,.?\t\n")
    topic_query = re.sub(r"\b(?:and|or|with)$", "", topic_query, flags=re.I).strip(" ,.?\t\n") or query
    api_key = configured_secret("NEWS_API_KEY") if paid_apis_enabled() else ""
    if api_key:
        try:
            response = requests.get(
                "https://newsapi.org/v2/everything",
                params={"q": topic_query, "pageSize": 6, "language": "en", "sortBy": "publishedAt"},
                headers={"X-Api-Key": api_key},
                timeout=(2, 4),
            )
            response.raise_for_status()
            data = response.json()
            articles = []
            for article in data.get("articles", []):
                url = _safe_url(article.get("url"))
                if not url:
                    continue
                articles.append({
                    "title": article.get("title") or "Untitled article",
                    "source": (article.get("source") or {}).get("name") or urlparse(url).hostname,
                    "url": url,
                    "publishedAt": article.get("publishedAt"),
                    "description": article.get("description") or "",
                })
            if articles:
                return _relevant_results(query, articles) or articles
        except (requests.RequestException, ValueError, TypeError):
            pass

    # Public RSS feeds are quicker and more reliable here than the search HTML pages,
    # which can return a bot-check page with HTTP 202 and no result elements.
    variants = _search_query_variants(topic_query)[:2]
    if re.search(r"\b(?:this week|today|latest|recent|breaking|what changed|current events)\b", query, re.I):
        variants = [variant + " when:7d" for variant in variants]
    rss_articles = []
    executor = ThreadPoolExecutor(max_workers=max(2, len(variants) * 2))
    searches = []
    for variant in variants:
        searches.append(executor.submit(_google_news_search, variant, 4))
        searches.append(executor.submit(_bing_news_search, variant, 4))
    try:
        for search in as_completed(searches, timeout=2.8):
            try:
                rss_articles.extend(search.result())
            except Exception:
                continue
            if len(rss_articles) >= 8:
                break
    except FuturesTimeoutError:
        pass
    finally:
        executor.shutdown(wait=False, cancel_futures=True)
    unique_articles = []
    seen_article_urls = set()
    for article in rss_articles:
        article_url = article.get("url")
        parsed_url = urlparse(article_url or "")
        canonical_url = (parsed_url.hostname or "", parsed_url.path.rstrip("/").lower())
        if article_url and canonical_url not in seen_article_urls:
            seen_article_urls.add(canonical_url)
            unique_articles.append(article)
    rss_articles = unique_articles
    if rss_articles:
        normalized_articles = [{
            "title": item.get("title") or "Untitled article",
            "source": item.get("site") or "",
            "url": item.get("url"),
            "publishedAt": item.get("publishedAt"),
            "description": item.get("snippet") or "",
        } for item in rss_articles if item.get("url")]
        return _relevant_results(query, normalized_articles) or normalized_articles

    try:
        response = requests.get(
            "https://api.gdeltproject.org/api/v2/doc/doc",
            params={"query": topic_query, "mode": "artlist", "format": "json", "maxrecords": 6, "sort": "datedesc"},
            headers=HTTP_HEADERS,
            timeout=(1, 2),
        )
        response.raise_for_status()
        data = response.json()
        articles = []
        for article in data.get("articles", [])[:6]:
            url = _safe_url(article.get("url"))
            if not url:
                continue
            published = article.get("seendate")
            if published and re.fullmatch(r"\d{8}T\d{6}Z", str(published)):
                published = datetime.strptime(published, "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc).isoformat()
            articles.append({
                "title": article.get("title") or "Untitled article",
                "source": article.get("domain") or urlparse(url).hostname,
                "url": url,
                "publishedAt": published,
                "description": "",
            })
        if articles:
            return _relevant_results(query, articles) or articles
    except (requests.RequestException, ValueError, TypeError):
        pass

    # A generic search fallback keeps the news panel useful when RSS and GDELT are unavailable.
    results = duckduckgo_search(topic_query, limit=6)
    return [{
        "title": item.get("title") or "Untitled result",
        "source": item.get("site") or "",
        "url": item.get("url"),
        "publishedAt": None,
        "description": item.get("snippet") or "",
    } for item in results if item.get("url")]


def _weather_description(code: Any) -> str:
    try:
        value = int(code)
    except (TypeError, ValueError):
        return "Current conditions"
    descriptions = {
        0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
        45: "Fog", 48: "Depositing rime fog", 51: "Light drizzle", 53: "Drizzle",
        55: "Dense drizzle", 56: "Freezing drizzle", 57: "Freezing drizzle",
        61: "Light rain", 63: "Rain", 65: "Heavy rain", 66: "Freezing rain",
        67: "Freezing rain", 71: "Light snow", 73: "Snow", 75: "Heavy snow",
        77: "Snow grains", 80: "Rain showers", 81: "Rain showers", 82: "Heavy rain showers",
        85: "Snow showers", 86: "Heavy snow showers", 95: "Thunderstorm",
        96: "Thunderstorm with hail", 99: "Thunderstorm with hail",
    }
    return descriptions.get(value, "Current conditions")


def _weather_chart(times: List[Any], values: List[Any]) -> Optional[Dict[str, Any]]:
    pairs = []
    for label, value in zip(times, values):
        if value is None:
            continue
        try:
            numeric = float(value)
        except (TypeError, ValueError):
            continue
        pairs.append((str(label)[11:16] if len(str(label)) >= 16 else str(label), numeric))
        if len(pairs) >= 8:
            break
    if len(pairs) < 2:
        return None
    return {"title": "Hourly temperature forecast", "labels": [p[0] for p in pairs], "values": [p[1] for p in pairs]}


def _open_meteo_weather(city: str) -> Dict[str, Any]:
    geo = requests.get(
        "https://geocoding-api.open-meteo.com/v1/search",
        params={"name": city, "count": 1, "language": "en", "format": "json"},
        timeout=(2, 4),
    )
    geo.raise_for_status()
    results = geo.json().get("results") or []
    if not results:
        return {"error": "I could not match that place. Include a city and country, for example 'Pune, India'."}
    place = results[0]
    forecast = requests.get(
        "https://api.open-meteo.com/v1/forecast",
        params={
            "latitude": place["latitude"],
            "longitude": place["longitude"],
            "current": "temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m",
            "hourly": "temperature_2m",
            "forecast_days": 1,
            "timezone": "auto",
            "wind_speed_unit": "ms",
        },
        timeout=(2, 4),
    )
    forecast.raise_for_status()
    data = forecast.json()
    current = data.get("current") or {}
    hourly = data.get("hourly") or {}
    times = hourly.get("time") or []
    temperatures = hourly.get("temperature_2m") or []
    current_time = current.get("time")
    if current_time:
        try:
            current_datetime = datetime.fromisoformat(current_time)
            offset = next((index for index, value in enumerate(times) if datetime.fromisoformat(value) >= current_datetime), 0)
            times, temperatures = times[offset:offset + 8], temperatures[offset:offset + 8]
        except (TypeError, ValueError):
            times, temperatures = times[:8], temperatures[:8]
    return {
        "city": ", ".join(part for part in [place.get("name"), place.get("admin1"), place.get("country")] if part),
        "temperature": current.get("temperature_2m"),
        "condition": _weather_description(current.get("weather_code")),
        "humidity": current.get("relative_humidity_2m"),
        "wind_speed": current.get("wind_speed_10m"),
        "lat": place.get("latitude"),
        "lon": place.get("longitude"),
        "observed_at": current.get("time"),
        "provider": "Open-Meteo",
        "chart": _weather_chart(times, temperatures),
    }


def weather_info(city: str) -> Dict[str, Any]:
    """Fetch live weather through paid OpenWeatherMap only when enabled, else Open-Meteo."""
    clean_city = re.sub(r"\s+", " ", (city or "").strip(" \t\n.,?!"))
    if len(clean_city) < 2:
        return {"error": "Tell me which city or place to check."}

    api_key = configured_secret("WEATHER_API_KEY") if paid_apis_enabled() else ""
    if api_key:
        try:
            response = requests.get(
                "https://api.openweathermap.org/data/2.5/weather",
                params={"q": clean_city, "appid": api_key, "units": "metric"},
                timeout=(2, 4),
            )
            response.raise_for_status()
            data = response.json()
            result = {
                "city": data.get("name") or clean_city,
                "temperature": (data.get("main") or {}).get("temp"),
                "condition": ((data.get("weather") or [{}])[0]).get("description"),
                "humidity": (data.get("main") or {}).get("humidity"),
                "wind_speed": (data.get("wind") or {}).get("speed"),
                "lat": (data.get("coord") or {}).get("lat"),
                "lon": (data.get("coord") or {}).get("lon"),
                "provider": "OpenWeatherMap",
            }
            try:
                forecast = requests.get(
                    "https://api.openweathermap.org/data/2.5/forecast",
                    params={"q": clean_city, "appid": api_key, "units": "metric", "cnt": 8},
                    timeout=(2, 4),
                )
                forecast.raise_for_status()
                entries = forecast.json().get("list", [])
                result["chart"] = _weather_chart(
                    [entry.get("dt_txt", "") for entry in entries],
                    [(entry.get("main") or {}).get("temp") for entry in entries],
                )
            except (requests.RequestException, ValueError, TypeError):
                result["chart"] = None
            return result
        except (requests.RequestException, ValueError, TypeError):
            # The public endpoint keeps weather usable if an optional key expires.
            pass

    try:
        return _open_meteo_weather(clean_city)
    except (requests.RequestException, ValueError, KeyError, TypeError):
        return {"error": "Weather data is unavailable right now. Try again shortly."}


def _youtube_video_id(url: str) -> str:
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    if host.endswith("youtu.be"):
        candidate = parsed.path.strip("/").split("/")[0]
    elif host.endswith("youtube.com") or host.endswith("youtube-nocookie.com"):
        query = parse_qs(parsed.query)
        candidate = query.get("v", [""])[0]
        if not candidate and parsed.path.startswith("/shorts/"):
            candidate = parsed.path.split("/")[2]
    else:
        return ""
    return candidate if re.fullmatch(r"[A-Za-z0-9_-]{11}", candidate or "") else ""


def _youtube_public_search(query: str) -> List[Dict[str, Any]]:
    """Read public video metadata from YouTube's search page when no API key is configured."""
    try:
        response = requests.get(
            "https://www.youtube.com/results",
            params={"search_query": query},
            headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128.0.0.0 Safari/537.36"},
            timeout=(0.8, 1.2),
        )
        response.raise_for_status()
        page = response.text
    except requests.RequestException:
        return []

    def read_text(value: Any) -> str:
        if not isinstance(value, dict):
            return ""
        if value.get("simpleText"):
            return str(value["simpleText"])
        runs = value.get("runs") or []
        return "".join(str(run.get("text", "")) for run in runs if isinstance(run, dict))

    initial_data = None
    marker = re.search(r"ytInitialData\s*=\s*", page)
    if marker:
        object_start = page.find("{", marker.end())
        if object_start >= 0:
            try:
                initial_data, _ = json.JSONDecoder().raw_decode(page[object_start:])
            except json.JSONDecodeError:
                initial_data = None

    videos: List[Dict[str, Any]] = []
    seen = set()
    stack = [initial_data] if initial_data is not None else []
    while stack and len(videos) < 5:
        item = stack.pop()
        if isinstance(item, dict):
            renderer = item.get("videoRenderer")
            if isinstance(renderer, dict):
                video_id = renderer.get("videoId")
                if video_id and re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id) and video_id not in seen:
                    seen.add(video_id)
                    channel = read_text(renderer.get("longBylineText") or renderer.get("ownerText"))
                    videos.append({
                        "video_id": video_id,
                        "title": read_text(renderer.get("title")) or "Untitled YouTube video",
                        "channel": channel or "YouTube",
                        "url": "https://www.youtube.com/watch?v=" + video_id,
                        "thumbnail": "https://i.ytimg.com/vi/" + video_id + "/hqdefault.jpg",
                    })
            stack.extend(reversed(list(item.values())))
        elif isinstance(item, list):
            stack.extend(reversed(item))
    if videos:
        return videos

    # Page-format fallback for responses that do not expose ytInitialData as JSON.
    for match in re.finditer(r'"videoId":"([A-Za-z0-9_-]{11})"', page):
        video_id = match.group(1)
        if video_id in seen:
            continue
        seen.add(video_id)
        excerpt = page[match.start():match.start() + 2500]
        title_match = re.search(r'"title":\{"runs":\[\{"text":"((?:\\.|[^"\\])*)"', excerpt)
        title = "Untitled YouTube video"
        if title_match:
            try:
                title = json.loads('"' + title_match.group(1) + '"')
            except ValueError:
                pass
        videos.append({
            "video_id": video_id,
            "title": title,
            "channel": "YouTube",
            "url": "https://www.youtube.com/watch?v=" + video_id,
            "thumbnail": "https://i.ytimg.com/vi/" + video_id + "/hqdefault.jpg",
        })
        if len(videos) >= 5:
            break
    return videos


def youtube_search(query: str) -> List[Dict[str, Any]]:
    """Use paid YouTube API only when enabled; otherwise parse public search results."""
    api_key = configured_secret("YOUTUBE_API_KEY") if paid_apis_enabled() else ""
    if api_key:
        try:
            response = requests.get(
                "https://www.googleapis.com/youtube/v3/search",
                params={"part": "snippet", "q": query, "type": "video", "maxResults": 5, "key": api_key},
                timeout=(1, 1.5),
            )
            response.raise_for_status()
            data = response.json()
            videos = []
            for item in data.get("items", []):
                snippet = item.get("snippet", {})
                video_id = (item.get("id") or {}).get("videoId")
                if not video_id:
                    continue
                videos.append({
                    "video_id": video_id,
                    "title": snippet.get("title") or "Untitled video",
                    "channel": snippet.get("channelTitle") or "YouTube",
                    "url": "https://www.youtube.com/watch?v=" + video_id,
                    "thumbnail": ((snippet.get("thumbnails") or {}).get("medium") or {}).get("url"),
                })
            if videos:
                return videos
        except (requests.RequestException, ValueError, TypeError):
            pass

    direct_videos = _youtube_public_search(query)
    if direct_videos:
        return direct_videos

    # Keep a public-index fallback, but cap its wait so video enrichment does not
    # hold the main research response open when an external search is slow.
    fallback_executor = ThreadPoolExecutor(max_workers=1)
    fallback_search = fallback_executor.submit(duckduckgo_search, query + " YouTube video", 10)
    try:
        results = fallback_search.result(timeout=0.9)
    except Exception:
        results = []
    finally:
        fallback_executor.shutdown(wait=False, cancel_futures=True)

    videos = []
    seen = set()
    for result in results:
        video_id = _youtube_video_id(result.get("url", ""))
        if not video_id or video_id in seen:
            continue
        seen.add(video_id)
        videos.append({
            "video_id": video_id,
            "title": result.get("title") or "YouTube video",
            "channel": result.get("site") or "YouTube",
            "url": "https://www.youtube.com/watch?v=" + video_id,
            "thumbnail": "https://i.ytimg.com/vi/" + video_id + "/hqdefault.jpg",
        })
        if len(videos) >= 5:
            break
    return videos


def integration_status() -> Dict[str, bool]:
    provider = os.getenv("LLM_PROVIDER", "openrouter").strip().lower()
    if provider == "openai":
        llm_ready = bool(configured_secret("OPENAI_API_KEY"))
    elif provider == "openrouter":
        llm_ready = bool(configured_secret("OPENROUTER_API_KEY"))
    elif provider == "groq":
        llm_ready = bool(configured_secret("GROQ_API_KEY"))
    elif provider == "ollama":
        llm_ready = bool(os.getenv("OLLAMA_BASE_URL", "http://localhost:11434").strip())
    else:
        llm_ready = False
    local_speech_ready = importlib.util.find_spec("faster_whisper") is not None
    return {
        "llm": llm_ready,
        "news": paid_apis_enabled() and bool(configured_secret("NEWS_API_KEY")),
        "news_fallback": True,
        "weather": paid_apis_enabled() and bool(configured_secret("WEATHER_API_KEY")),
        "weather_fallback": True,
        "youtube": paid_apis_enabled() and bool(configured_secret("YOUTUBE_API_KEY")),
        "youtube_fallback": True,
        "search": paid_apis_enabled() and bool(configured_secret("SERPER_API_KEY")),
        "search_fallback": True,
        "github": False,
        "github_fallback": True,
        "speech": bool(configured_secret("OPENAI_API_KEY")) and os.getenv("SPEECH_PROVIDER", "auto").strip().lower() in {"auto", "openai", "api"},
        "speech_fallback": local_speech_ready,
    }


def json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False)
