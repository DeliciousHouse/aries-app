#!/usr/bin/env python3
import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from _canonical_outputs import write_stage_log


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def read_stdin_json() -> Any:
    raw = sys.stdin.read().strip()
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"invalid JSON on stdin: {exc}") from exc


def emit_json(payload: Any) -> None:
    json.dump(payload, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return slug or "competitor"


def make_run_id(seed: str) -> str:
    return f"{slugify(seed)}-{uuid.uuid4().hex[:8]}"


def cache_root() -> Path:
    root = Path(os.environ.get("LOBSTER_STAGE1_CACHE_DIR", Path(tempfile.gettempdir()) / "lobster-stage1-cache"))
    root.mkdir(parents=True, exist_ok=True)
    return root


def run_dir(run_id: str) -> Path:
    path = cache_root() / run_id
    path.mkdir(parents=True, exist_ok=True)
    return path


def save_step(run_id: str, step_name: str, payload: Any) -> None:
    path = run_dir(run_id) / f"{step_name}.json"
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    write_stage_log(run_id, "stage-1-research", step_name, payload)


def load_step(run_id: str, step_name: str) -> Any:
    path = run_dir(run_id) / f"{step_name}.json"
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def normalize_research_model(model: str) -> str:
    trimmed = (model or "").strip()
    return trimmed or "gemini/gemini-2.5-flash"


def gemini_api_model_name(model: str) -> str:
    normalized = normalize_research_model(model)
    if "/" in normalized:
        _provider, model_name = normalized.split("/", 1)
        return model_name
    return normalized


def parse_domain(url: str) -> str:
    if not url:
        return ""
    parsed = urllib.parse.urlparse(url)
    return (parsed.netloc or "").lower().removeprefix("www.")


def parse_facebook_profile_id(url: str) -> str:
    if not url:
        return ""
    parsed = urllib.parse.urlparse(url)
    query = urllib.parse.parse_qs(parsed.query)
    if "id" in query and query["id"]:
        return query["id"][0]
    path_bits = [bit for bit in parsed.path.split("/") if bit]
    if path_bits:
        return path_bits[-1]
    return ""


def _http_request(url: str, timeout: float = 20.0, headers: dict[str, str] | None = None) -> str:
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return response.read().decode("utf-8", errors="replace")


def fetch_json(url: str, timeout: float = 20.0, headers: dict[str, str] | None = None) -> dict[str, Any]:
    return json.loads(_http_request(url, timeout=timeout, headers=headers))


def fetch_text(url: str, timeout: float = 20.0, headers: dict[str, str] | None = None) -> str:
    return _http_request(url, timeout=timeout, headers=headers)


def web_search(query: str, max_results: int = 5) -> dict[str, Any]:
    cmd_template = os.environ.get("LOBSTER_WEB_SEARCH_CMD", "").strip()
    if cmd_template:
        try:
            if "{query}" in cmd_template or "{max_results}" in cmd_template:
                cmd = cmd_template.format(query=query, max_results=max_results)
            else:
                cmd = f"{cmd_template} {shlex.quote(query)} {int(max_results)}"
            proc = subprocess.run(
                cmd,
                shell=True,
                check=True,
                capture_output=True,
                text=True,
            )
            raw = proc.stdout.strip()
            parsed = json.loads(raw)
            results = parsed.get("results") if isinstance(parsed, dict) else parsed
            if isinstance(results, list) and results:
                return {
                    "live": True,
                    "provider": "command",
                    "results": results[:max_results],
                    "error": "",
                }
        except Exception as exc:
            return {
                "live": False,
                "provider": "command",
                "results": [],
                "error": f"{type(exc).__name__}: {exc}",
            }

    # Best-effort public web fallback. This can fail in restricted network environments.
    try:
        url = "https://duckduckgo.com/html/?" + urllib.parse.urlencode({"q": query})
        html = fetch_text(
            url,
            timeout=20.0,
            headers={"User-Agent": "lobster-stage1/1.0"},
        )
        pattern = re.compile(
            r'<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="(?P<href>[^"]+)"[^>]*>(?P<title>.*?)</a>',
            flags=re.IGNORECASE | re.DOTALL,
        )
        snippet_pattern = re.compile(
            r'<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>(?P<snippet>.*?)</a>|'
            r'<div[^>]+class="[^"]*result__snippet[^"]*"[^>]*>(?P<snippet_div>.*?)</div>',
            flags=re.IGNORECASE | re.DOTALL,
        )
        titles = []
        snippets = snippet_pattern.findall(html)
        for idx, match in enumerate(pattern.finditer(html)):
            if len(titles) >= max_results:
                break
            href = urllib.parse.unquote(match.group("href"))
            title = re.sub(r"<[^>]+>", "", match.group("title")).strip()
            snippet_text = ""
            if idx < len(snippets):
                snip = snippets[idx][0] or snippets[idx][1]
                snippet_text = re.sub(r"<[^>]+>", "", snip).strip()
            titles.append({"title": title, "url": href, "snippet": snippet_text})
        if titles:
            return {"live": True, "provider": "duckduckgo-html", "results": titles, "error": ""}
    except Exception as exc:
        return {
            "live": False,
            "provider": "duckduckgo-html",
            "results": [],
            "error": f"{type(exc).__name__}: {exc}",
        }
    return {"live": False, "provider": "none", "results": [], "error": "no search provider available"}


def summarize_with_gemini(prompt: str, research_model: str) -> dict[str, Any]:
    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    model_name = gemini_api_model_name(research_model)
    if not api_key:
        return {
            "live": False,
            "provider": "gemini",
            "model": model_name,
            "text": "",
            "error": "GEMINI_API_KEY not set",
        }
    body = {
        "contents": [
            {
                "role": "user",
                "parts": [{"text": prompt}],
            }
        ]
    }
    url = (
        f"https://generativelanguage.googleapis.com/v1beta/models/{urllib.parse.quote(model_name)}:"
        f"generateContent?key={urllib.parse.quote(api_key)}"
    )
    try:
        req = urllib.request.Request(
            url,
            data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=30.0) as response:
            parsed = json.loads(response.read().decode("utf-8", errors="replace"))
        candidates = parsed.get("candidates", [])
        if not candidates:
            return {
                "live": False,
                "provider": "gemini",
                "model": model_name,
                "text": "",
                "error": "empty candidates",
            }
        parts = candidates[0].get("content", {}).get("parts", [])
        text = "\n".join(part.get("text", "") for part in parts if part.get("text"))
        return {"live": True, "provider": "gemini", "model": model_name, "text": text.strip(), "error": ""}
    except Exception as exc:
        return {
            "live": False,
            "provider": "gemini",
            "model": model_name,
            "text": "",
            "error": f"{type(exc).__name__}: {exc}",
        }


def fetch_meta_object(object_id: str, access_token: str, fields: list[str]) -> dict[str, Any]:
    query = urllib.parse.urlencode({"fields": ",".join(fields), "access_token": access_token})
    url = f"https://graph.facebook.com/v23.0/{urllib.parse.quote(object_id)}?{query}"
    return fetch_json(url, timeout=25.0)
