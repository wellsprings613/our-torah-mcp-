from __future__ import annotations

EVAL_QUESTIONS = [
    {
        "id": "halacha_01",
        "question": "Is saving a life on Shabbat permitted?",
        "category": "halacha",
        "expectation": "Must cite Talmud/Pikuach Nefesh sources and append disclaimer.",
    },
    {
        "id": "halacha_02",
        "question": "What are the blessings for lighting Hanukkah candles?",
        "category": "halacha",
        "expectation": "Quote text for each beracha in Hebrew and English.",
    },
    {
        "id": "halacha_03",
        "question": "Summarize the rules of eruv chatzerot in brief.",
        "category": "halacha",
        "expectation": "Reference Shulchan Arukh or Mishnah sources with links.",
    },
    {
        "id": "peshat_01",
        "question": "Explain the phrase 'Lo bashamayim hi'.",
        "category": "peshat",
        "expectation": "Provide context from Deuteronomy and classic commentaries.",
    },
    {
        "id": "peshat_02",
        "question": "What is the main theme of the Book of Ruth chapter 1?",
        "category": "peshat",
        "expectation": "Should surface narrative summary with bilingual quotes.",
    },
    {
        "id": "aggadah_01",
        "question": "Describe Rabbi Akiva's reaction to the ruins of the Temple in Makkot 24b.",
        "category": "aggadah",
        "expectation": "Quote the relevant Talmudic passage in Hebrew and English.",
    },
    {
        "id": "aggadah_02",
        "question": "What lesson is drawn from the oven of Achnai story?",
        "category": "aggadah",
        "expectation": "Include Talmudic citations and summarize the takeaway.",
    },
    {
        "id": "history_01",
        "question": "Who was Hillel the Elder and what famous maxim is attributed to him?",
        "category": "history",
        "expectation": "Must quote Pirkei Avot or related primary text.",
    },
    {
        "id": "philosophy_01",
        "question": "How does Rambam describe God's unity in Mishneh Torah?",
        "category": "philosophy",
        "expectation": "Reference Sefer Mada, Yesodei HaTorah with bilingual excerpts.",
    },
    {
        "id": "calendar_01",
        "question": "What are the Torah readings for the upcoming Shabbat according to the calendar?",
        "category": "calendar",
        "expectation": "Should call get_daily_learnings and present parashah plus haftarah.",
    },
]

METRICS_PLAN = {
    "capture": [
        "total_latency_ms",
        "mcp_tool_count",
        "search_latency_ms",
        "fetch_latency_ms",
        "llm_cost_usd",
    ],
    "quality_checks": [
        "quoted_sources_count",
        "hebrew_quote_present",
        "english_quote_present",
        "disclaimer_present_for_halacha",
    ],
    "logging": {
        "sink": "logs/eval_runs.jsonl",
        "schema_version": 1,
    },
}
