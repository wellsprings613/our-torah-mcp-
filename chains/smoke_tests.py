from __future__ import annotations

import asyncio
import os
import sys

from .auto_explain import AutoExplain
from .explain_with_sources import ExplainWithSourcesChain, HALACHA_TRIGGER
from .ref_resolver import RefResolverChain
from langchain_mcp_adapters.client import MultiServerMCPClient


async def run_ref_resolver_smoke(server_url: str) -> None:
    chain = RefResolverChain(server_url)
    queries = [
        "Genesis 1:1",
        "ברכות ב:א",
        "Hanukkah lights",
    ]
    for q in queries:
        result = await chain.resolve(q)
        if result.get("error"):
            raise AssertionError(f"ref_resolver failed for '{q}': {result['error']}")
        text = (result.get("text") or "").strip()
        if not text:
            raise AssertionError(f"No text returned for '{q}'")
        if len(text) < 40:
            raise AssertionError(f"Unexpectedly short text for '{q}'")


async def run_explain_smoke(server_url: str) -> None:
    api_key = os.environ.get("OPENROUTER_API_KEY")
    if not api_key:
        print("[skip] explain_with_sources: OPENROUTER_API_KEY not set", file=sys.stderr)
        return

    chain = ExplainWithSourcesChain(server_url)
    questions = [
        "Lo bashamayim hi",
        "Saving a life on Shabbat",
    ]
    for q in questions:
        output = await chain.explain(q, level="beginner", max_sources=2)
        lower = output.lower()
        if "source" not in lower:
            raise AssertionError("Missing sources section")
        if "http" not in output:
            raise AssertionError("Expected source links in output")
        if "saving a life on shabbat" in q.lower() and "disclaimer" not in lower:
            raise AssertionError("Expected halacha disclaimer")


async def run_auto_explain_smoke(server_url: str) -> None:
    api_key = os.environ.get("OPENROUTER_API_KEY")
    if not api_key:
        print("[skip] auto_explain: OPENROUTER_API_KEY not set", file=sys.stderr)
        return

    auto = AutoExplain(server_url)
    questions = [
        "Can a kohen marry a convert?",
        "Explain today's Daf Yomi.",
    ]

    for q in questions:
        output = await auto.run(q)
        lower = output.lower()
        if "quoted sources" not in lower:
            raise AssertionError(f"auto_explain missing sources for '{q}'")
        if "http" not in output:
            raise AssertionError(f"auto_explain missing links for '{q}'")
        if HALACHA_TRIGGER.search(q) and "disclaimer" not in lower:
            raise AssertionError("Expected halacha disclaimer in auto_explain output")


async def run_insight_layers_smoke(server_url: str) -> None:
    client = MultiServerMCPClient({"sefaria": {"url": server_url, "transport": "streamable_http"}})
    tools = {t.name: t for t in await client.get_tools(server_name="sefaria")}
    if 'insight_layers' not in tools:
        raise AssertionError('insight_layers tool not available')
    result = await tools['insight_layers'].ainvoke({"ref": "Genesis 1:1", "commentators": ["Rashi", "Ibn Ezra"]})
    data = result.get("structuredContent") or result
    items = (data or {}).get("items", [])
    if not isinstance(items, list) or len(items) < 2:
        raise AssertionError('insight_layers returned insufficient items')
    for it in items:
        if 'available' not in it:
            raise AssertionError('insight_layers item missing availability')


async def run_calendar_insights_smoke(server_url: str) -> None:
    client = MultiServerMCPClient({"sefaria": {"url": server_url, "transport": "streamable_http"}})
    tools = {t.name: t for t in await client.get_tools(server_name="sefaria")}
    if 'calendar_insights' not in tools:
        raise AssertionError('calendar_insights tool not available')
    result = await tools['calendar_insights'].ainvoke({})
    data = result.get("structuredContent") or result
    alerts = (data or {}).get("alerts", [])
    if not isinstance(alerts, list) or len(alerts) < 3:
        raise AssertionError('calendar_insights returned too few days')


async def run_guided_chavruta_smoke(server_url: str) -> None:
    # Ensure it runs without OPENROUTER_API_KEY
    os.environ.pop('OPENROUTER_API_KEY', None)
    chain = None
    try:
        from .guided_chavruta import GuidedChavrutaChain  # type: ignore
        chain = GuidedChavrutaChain(server_url)
    except Exception as err:
        raise AssertionError(f"guided_chavruta import failed: {err}")
    out = await chain.run("Help me learn about Shabbat candles")
    for key in ("plan", "steps", "sources", "reflection_questions", "summary"):
        if key not in out:
            raise AssertionError(f"guided_chavruta missing field: {key}")


async def main() -> None:
    server_url = os.environ.get("SEFARIA_MCP_URL", "http://localhost:3000/mcp")
    await run_ref_resolver_smoke(server_url)
    await run_explain_smoke(server_url)
    await run_auto_explain_smoke(server_url)
    await run_insight_layers_smoke(server_url)
    await run_calendar_insights_smoke(server_url)
    await run_guided_chavruta_smoke(server_url)
    print("Smoke tests passed")


if __name__ == "__main__":
    asyncio.run(main())
