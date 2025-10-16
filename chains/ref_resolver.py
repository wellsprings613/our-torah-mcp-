"""RefResolverChain: lightweight helper to resolve Torah refs via the Sefaria MCP server.

Usage:
    python3 chains/ref_resolver.py "Genesis 1:1"

It prints fetched bilingual text for direct refs and the best hit for natural-language prompts.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
from typing import Any, Dict, Optional
import logging

from langchain_mcp_adapters.client import MultiServerMCPClient


REF_PATTERN = re.compile(r"([\w\s'\-]+\d+:\d+)|(#[\u0590-\u05FF]+)" )
HEBREW_REF_PATTERN = re.compile(r"[\u0590-\u05FF]+\s*\d+[:\.\s]?\d*")


def _structured(result: Dict[str, Any] | str) -> Dict[str, Any]:
    if isinstance(result, str):
        try:
            result = json.loads(result)
        except json.JSONDecodeError:
            return {}
    if isinstance(result, dict):
        structured = result.get("structuredContent")
        if structured:
            return structured
        for item in result.get("content", []):
            if item.get("type") == "text":
                try:
                    return json.loads(item.get("text", "{}"))
                except json.JSONDecodeError:
                    continue
        return result
    return {}


logger = logging.getLogger(__name__)


class RefResolverChain:
    """Resolve refs by combining fetch + search MCP tools."""

    def __init__(self, server_url: str) -> None:
        self.client = MultiServerMCPClient(
            {
                "sefaria": {
                    "url": server_url,
                    "transport": "streamable_http",
                }
            }
        )
        self.tools: Dict[str, Any] = {}

    async def _ensure_tools(self) -> None:
        if self.tools:
            return
        tool_list = await self.client.get_tools(server_name="sefaria")
        self.tools = {tool.name: tool for tool in tool_list}

    async def resolve(self, query: str, *, max_chars: int = 800) -> Dict[str, Any]:
        logger.debug("resolve.start", extra={"query": query})
        await self._ensure_tools()
        if self._query_is_pure_ref(query):
            detail = await self._resolve_ref(query, max_chars=max_chars)
            detail["query"] = query
            detail["resolution_path"] = ["direct"]
            logger.debug("resolve.direct", extra={"query": query})
            return detail

        hits: list[Dict[str, Any]] = []
        search_error: Optional[Exception] = None
        resolution_path: list[str] = ["search"]
        try:
            search_result = await self.tools["search"].ainvoke({"query": query, "size": 5})
            hits = _structured(search_result).get("results", [])
        except Exception as err:  # type: ignore[bare-except]
            search_error = err

        simplified = ""
        if not hits:
            simplified = self._simplify_query(query)
            if simplified and simplified != query:
                try:
                    simplified_result = await self.tools["search"].ainvoke({"query": simplified, "size": 5})
                    simplified_hits = _structured(simplified_result).get("results", [])
                    if simplified_hits:
                        hits = simplified_hits
                        resolution_path.append("search_simplified")
                except Exception as err:  # type: ignore[bare-except]
                    search_error = search_error or err

        if not hits:
            topic_query = simplified or query
            try:
                topic_result = await self.tools["topics_search"].ainvoke({"topic": topic_query})
                topic_hits = _structured(topic_result).get("results", [])
            except Exception:
                topic_hits = []

            if topic_hits:
                hits = [
                    {
                        "id": item.get("ref"),
                        "title": item.get("title", item.get("ref")),
                        "url": item.get("url"),
                    }
                    for item in topic_hits
                    if item.get("ref")
                ]
                if hits:
                    resolution_path.append("topics_search")

        if not hits:
            matches: list[Dict[str, Any]] = []
            try:
                find_result = await self.tools["find_refs"].ainvoke({"text": query})
                matches = _structured(find_result).get("matches", [])
            except Exception:
                matches = []

            if matches:
                ref = matches[0].get("ref")
                if ref:
                    detail = await self._resolve_ref(ref, max_chars=max_chars)
                    detail["query"] = query
                    detail["ref_matches"] = matches
                    detail["resolution_path"] = resolution_path + ["find_refs"]
                    if search_error:
                        detail["search_error"] = str(search_error)
                    return detail

            if search_error:
                return {"error": f"Search failed: {search_error}", "query": query}
            logger.debug("resolve.none", extra={"query": query})
            return {"error": "No sources found", "query": query}

        top = hits[0]
        detail = await self._resolve_hit(top, max_chars=max_chars)
        detail["search_results"] = hits
        detail["query"] = query
        detail["resolution_path"] = resolution_path
        if search_error:
            detail["search_error"] = str(search_error)
        logger.debug("resolve.done", extra={"query": query})
        return detail

    @staticmethod
    def _simplify_query(query: str) -> str:
        tokens = re.findall(r"[\w']+", query.lower())
        stopwords = {
            "where",
            "does",
            "the",
            "and",
            "or",
            "a",
            "an",
            "of",
            "to",
            "in",
            "is",
            "about",
            "discuss",
            "discusses",
            "discussing",
            "tell",
            "me",
            "does",
            "do",
            "it",
            "on",
            "for",
            "with",
            "by",
            "what",
            "which",
            "who",
            "when",
            "how",
            "why",
        }
        filtered = [tok for tok in tokens if tok not in stopwords and len(tok) > 2]
        simplified = " ".join(filtered[:8])
        return simplified.strip()

    async def _fetch(self, fetch_id: str, *, max_chars: int) -> Dict[str, Any]:
        result = await self.tools["fetch"].ainvoke(
            {"id": fetch_id, "langPref": "bi", "maxChars": max_chars}
        )
        structured = _structured(result)
        structured.setdefault("id", fetch_id)
        return structured

    async def _resolve_ref(self, ref: str, *, max_chars: int) -> Dict[str, Any]:
        fetch_id = f"{ref.strip()}|auto|primary"
        structured = await self._fetch(fetch_id, max_chars=max_chars)
        structured.setdefault("ref", ref)
        structured.setdefault("url", self._ref_to_url(ref))
        return structured

    async def _resolve_hit(self, hit: Dict[str, Any], *, max_chars: int) -> Dict[str, Any]:
        fetch_id: Optional[str] = hit.get("id")
        if not fetch_id:
            ref = hit.get("title") or hit.get("url") or "Unknown Ref"
            fetch_id = f"{ref}|auto|primary"
        structured = await self._fetch(fetch_id, max_chars=max_chars)
        structured.setdefault("title", hit.get("title"))
        structured.setdefault("url", hit.get("url"))
        return structured

    @staticmethod
    def _ref_to_url(ref: str) -> str:
        from urllib.parse import quote

        encoded = quote(ref.replace(" ", "_").strip())
        return f"https://www.sefaria.org/{encoded}?lang=bi"

    @staticmethod
    def _looks_like_direct_ref(query: str) -> bool:
        query = query.strip()
        return bool(REF_PATTERN.search(query) or HEBREW_REF_PATTERN.search(query))

    @staticmethod
    def _query_is_pure_ref(query: str) -> bool:
        q = query.strip()
        if not q:
            return False
        if any(ch in q for ch in "?!" ):
            return False
        lowered = q.lower()
        if lowered.split()[0] in {"what", "where", "who", "how", "why", "when", "tell", "explain"}:
            return False
        if len(q.split()) > 6:
            return False
        return RefResolverChain._looks_like_direct_ref(q)


async def main() -> None:
    parser = argparse.ArgumentParser(description="Resolve Torah refs via MCP")
    parser.add_argument("query", nargs="?", help="Reference or natural-language query")
    parser.add_argument(
        "--max-chars", type=int, default=800, help="Max characters per fetched text"
    )
    args = parser.parse_args()

    sample_queries = [
        "Genesis 1:1",
        "בראשית א:א",
        "Where does it say to add lights each night of Hanukkah?",
    ]
    queries = [args.query] if args.query else sample_queries

    server_url = os.environ.get("SEFARIA_MCP_URL", "http://localhost:3000/mcp")
    resolver = RefResolverChain(server_url)

    for q in queries:
        result = await resolver.resolve(q, max_chars=args.max_chars)
        print("==============================")
        print(f"Query: {q}")
        if "error" in result:
            print("Error: ", result["error"])
            continue
        print("Title:", result.get("title"))
        print("URL:", result.get("url"))
        print("Text:\n", result.get("text"))


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    asyncio.run(main())
