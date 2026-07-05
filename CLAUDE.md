# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Structure

```
compliance/          # Agentic compliance engine (LLM-based evaluation pipeline)
oms/                 # OMS web application (Flask + vanilla JS)
```

## Setup

Requires an `ANTHROPIC_API_KEY` in a `.env` file at the project root. All compliance scripts call `load_dotenv()` automatically.

Install dependencies: `pip install anthropic python-dotenv flask`

## Running the compliance engine

```bash
cd compliance

# Full pipeline: generate dataset -> run compliance checks -> grade -> output report
python run_eval.py

# Regenerate dataset (delete existing first if needed)
python dataset.py

# Smoke test the compliance engine against a single hardcoded case
python compliance_prompt.py
```

`run_eval.py` skips dataset generation if `dataset.json` already exists — delete it to regenerate. Outputs are written to `output.json` and `output.html`.

## Running the OMS

```bash
cd oms
python server.py
# Open http://localhost:5000
```

## Architecture

### Compliance Engine (`compliance/`)

Three-stage evaluation pipeline:

**Stage 1 — `dataset.py`**: Generates 20 synthetic test cases in batches of 3 (to stay within output token limits) using `claude-haiku-4-5` at `temperature=1.0`. Each test case includes a rule config, a current repo book, a proposed trade, and the expected compliance output with pre-computed net values.

**Stage 2 — `compliance_prompt.py`**: The system under test. Sends each task to `claude-haiku-4-5` at `temperature=0.0`. The model must compute post-trade net positions by dimension (counterparty or maturity_month), evaluate child rules against bounds, combine children via AND/OR logic at the parent level, and return a structured JSON verdict.

**Stage 3 — `evaluator.py`**: Iterates the dataset sequentially. Grades each compliance engine output against the expected result using a second `claude-haiku-4-5` call (LLM-as-judge). Uses prefill (assistant prefill `"```json"` + `stop_sequences=["```"]`) to extract clean JSON from grader responses. Generates `output.html` with color-coded scores (green >=8, yellow 6-7, red <=5) and `output.json` with the full per-case results.

### OMS (`oms/`)

Flask web application serving a portfolio viewer:

- `server.py` — Flask app with routes (`GET /`, `GET /api/portfolios`) and hardcoded sample portfolio data
- `templates/index.html` — HTML structure (no inline CSS/JS)
- `static/css/styles.css` — financial-app styling
- `static/js/app.js` — client-side logic: fetch data, render tree-grid table, expand/collapse, T+n projections

The table displays bond holdings with parent/child netting:
- **Parent row** = net available (bond notional minus active repo notionals)
- **Child rows** = individual bond position + repo positions
- **T+0 to T+5** columns project notional across settlement dates; repos mature at specific T+n, increasing net availability

## Domain: Repo trading compliance

- **Positive notional** = reverse repo (cash out, collateral in)
- **Negative notional** = repo (cash in, collateral out)
- Net values are computed **post-trade** across the full book
- `parent_rule_id` and child `id` are integers (sequential within each test case), not strings
- Each parent rule has a `type`: `"concentration_maturity"` or `"counterparty"`
  - `concentration_maturity` parents can only contain children with dimension `maturity_month`
  - `counterparty` parents can only contain children with dimensions `counterparty`, `counterparty_mtm`, or `counterparty_pct`
- Child rules aggregate by dimension and check whether the net falls within `[lower_bound, upper_bound]`:
  - `counterparty` — aggregate `market_value` by counterparty
  - `maturity_month` — aggregate `market_value` (not notional) by maturity month; maturity concentration is assessed on a mark-to-market basis
  - `counterparty_mtm` — aggregate the `mtm` field (not notional) by counterparty; bounds are absolute MtM limits
  - `counterparty_pct` — aggregate `market_value` by counterparty expressed as a percentage of the rule's `total_limit`; bounds are percentages
- **OR parent**: breached if ANY child breaches
- **AND parent**: breached only if ALL children breach — partial breach does NOT trigger the parent (the critical AND edge case)
- `pm_override_required` is true if and only if any parent is breached
