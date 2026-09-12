# Research agent: environment variables

Every switch below is optional. The defaults are what production runs, and an
unset or unparsable value always falls back to the default rather than failing a
request. Local development reads them from a gitignored `.env` (see
`.env.example`); the deployed runtime reads third-party keys from the
`CorpusServiceSecretArn` Secrets Manager secret and the rest from the stack's
task environment (`infra/app/app-runtime.cfn.yaml`).

## Pipeline switches

| Variable | Default | What it does |
| --- | --- | --- |
| `FRONTIER_AGENT` | off | `1\|on\|true\|yes` routes `POST /api/orchestrate` to the Nemotron-router / Grok-writer pipeline instead of the single-agent loop. |
| `RESEARCH_CLARIFY` | on | `0\|off\|false\|no` disables the pre-flight clarification panels (forum / jurisdiction / deliverable). |
| `RESEARCH_PREFETCH` | on | `off` disables the speculative last-30-days sweep that runs beside the model's first turn. |
| `WEB_RERANK` | on (`embed`) | `off` disables the Titan-embedding rerank of web candidates; ranking then stays lexical. |
| `WEB_RERANK_CAP_MS` | `1500` | Wall-clock cap for that rerank. Whatever embedded in time is fused; the rest keep their lexical rank. |
| `BEDROCK_COVERAGE_GATE` | on | The post-research coverage audit and its one re-query round. |
| `BEDROCK_SUBAGENTS` | off | `1` enables the parallel sub-question pool for file deliverables only. |
| `RESEARCH_BRIEF` | on | `off` hides the research landing's "Since you were here" headlines. |

## Models and tiers

| Variable | Default | What it does |
| --- | --- | --- |
| `BEDROCK_REGION` | `AWS_REGION`, else `us-east-1` | Region for every Converse call. |
| `BEDROCK_RESEARCH_MODEL` | `us.anthropic.claude-sonnet-5` | Think-mode tool loop and writer. |
| `BEDROCK_FAST_MODEL` | Nemotron Super locally, research model when hosted | Fast-mode tool loop driver. |
| `BEDROCK_FAST_WRITER_MODEL` | research model | Fast-mode writer. |
| `BEDROCK_AGENT_MODEL` | `us.anthropic.claude-haiku-4-5-20251001-v1:0` | Side calls: conversational replies, question resolution, coverage gate, memory refresh, follow-ups. |
| `BEDROCK_AGENT_TIER` | unset | Converse `serviceTier` for calls on `BEDROCK_AGENT_MODEL`. `priority` and `flex` need a model that supports them (Nova, Qwen, DeepSeek, MiniMax); Claude accepts only `default` and `reserved`, so a tier Claude rejects is dropped rather than sent. |
| `BEDROCK_JUDGE_MODEL` | unset | Enables the citation-faithfulness verdict. It runs after `done` and arrives as a late `verification` event, so it never delays the answer. |
| `BEDROCK_RERANK_MODEL` | `cohere.rerank-v3-5:0` | Knowledge-base rerank only. Not used by web search, which reranks with Titan embeddings because Cohere is not approved for this account. |
| `NEMOTRON_MODEL_ID` | `nvidia.nemotron-super-3-120b` | Frontier router. |
| `GROK_ORCHESTRATOR_MODEL` / `GROK_WRITER_MODEL` | `us.xai.grok-4.6` | Frontier orchestrator and writer. |

## Third-party keys

All optional. A missing key disables only its own feature.

| Variable | Used by |
| --- | --- |
| `BRAVE_API_KEY` | Extra web-search provider merged into the research fan-out. |
| `TAVILY_API_KEY` | Web-search provider; also a landing-headlines backend and Office image search. |
| `FIRECRAWL_API_KEY` | Landing-headlines backend (v2 `/search`, news source) and the intel scraper. |
| `COURTLISTENER_API_TOKEN` | `verify_citations` and RECAP lookups. |
| `DOCKETBIRD_API_KEY` | Every `db_*` docket tool. |
| `NCBI_API_KEY`, `OPENFDA_API_KEY` | Higher rate limits on PubMed and openFDA. |

## Reading the logs

One research turn prints, in order: `run_start`, `prefetch_start`, `mode`,
`research_loop`, `prefetch_merged` (only when the sweep was handed to the
model), `coverage_check`, `run_done`, then `verification`. Note that
`run_done.total_ms` measures time to the answer, so it excludes the
faithfulness judge and the memory refresh that follow it.
