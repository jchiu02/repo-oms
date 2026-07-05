import json
import os
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

from flask import Flask, jsonify, render_template, request
from pricing import price_bond, fetch_boe_yield_curve, get_yield_for_bond

sys.path.insert(0, str(Path(__file__).parent.parent / "compliance"))
from compliance_prompt import run_compliance_check
from dealer_agent import run_dealer_check

app = Flask(__name__)

BOND_SPECS = {
    "GB00BYY5F144": {
        "name": "UKT 4.5% 2028",
        "coupon": 0.045,
        "maturity_date": "2028-12-07",
        "freq": 2,
        "convention": "ACT/ACT",
        "credit_spread": 0.0,
        "fallback_yield": 0.041,
    },
    "GB00BMBL1G81": {
        "name": "UKT 1.0% 2032",
        "coupon": 0.01,
        "maturity_date": "2032-01-31",
        "freq": 2,
        "convention": "ACT/ACT",
        "credit_spread": 0.0,
        "fallback_yield": 0.043,
    },
    "GB00BMV7TC07": {
        "name": "UKT 4.25% 2034",
        "coupon": 0.0425,
        "maturity_date": "2034-06-07",
        "freq": 2,
        "convention": "ACT/ACT",
        "credit_spread": 0.0,
        "fallback_yield": 0.042,
    },
    "US30303M8T60": {
        "name": "Meta 4.45% 2029",
        "coupon": 0.0445,
        "maturity_date": "2029-08-15",
        "freq": 2,
        "convention": "30/360",
        "credit_spread": 0.009,
        "fallback_yield": 0.051,
    },
    "US22890MAA09": {
        "name": "CRWV 3.0% 2029",
        "coupon": 0.03,
        "maturity_date": "2029-02-15",
        "freq": 2,
        "convention": "30/360",
        "credit_spread": 0.018,
        "fallback_yield": 0.058,
    },
    "GB00BL6C6328": {
        "name": "UKT 0.625% 2030",
        "coupon": 0.00625,
        "maturity_date": "2030-06-07",
        "freq": 2,
        "convention": "ACT/ACT",
        "credit_spread": 0.0,
        "fallback_yield": 0.040,
    },
    "US037833DX25": {
        "name": "Apple 3.25% 2032",
        "coupon": 0.0325,
        "maturity_date": "2032-02-08",
        "freq": 2,
        "convention": "30/360",
        "credit_spread": 0.005,
        "fallback_yield": 0.046,
    },
    "XS2356943897": {
        "name": "Tesco 5.125% 2031",
        "coupon": 0.05125,
        "maturity_date": "2031-09-24",
        "freq": 2,
        "convention": "30/360",
        "credit_spread": 0.013,
        "fallback_yield": 0.054,
    },
}

COUNTERPARTY_RULES = {
    "sterling-ig": [
        {"name": "Barclays", "lower_bound": -25_000_000, "upper_bound": 25_000_000},
        {"name": "JPM", "lower_bound": -40_000_000, "upper_bound": 40_000_000},
        {"name": "Goldman Sachs", "lower_bound": -20_000_000, "upper_bound": 20_000_000},
        {"name": "Morgan Stanley", "lower_bound": -45_000_000, "upper_bound": 45_000_000},
        {"name": "Citi", "lower_bound": -28_000_000, "upper_bound": 28_000_000},
        {"name": "HSBC", "lower_bound": -55_000_000, "upper_bound": 55_000_000},
    ],
    "global-credit": [
        {"name": "Barclays", "lower_bound": -45_000_000, "upper_bound": 45_000_000},
        {"name": "JPM", "lower_bound": -14_000_000, "upper_bound": 14_000_000},
        {"name": "Goldman Sachs", "lower_bound": -55_000_000, "upper_bound": 55_000_000},
        {"name": "Morgan Stanley", "lower_bound": -40_000_000, "upper_bound": 40_000_000},
        {"name": "Citi", "lower_bound": -35_000_000, "upper_bound": 35_000_000},
        {"name": "HSBC", "lower_bound": -50_000_000, "upper_bound": 50_000_000},
        {"name": "Deutsche Bank", "lower_bound": -22_000_000, "upper_bound": 22_000_000},
    ],
}

MATURITY_MV_BOUND = 55_000_000
MATURITY_PCT_BOUND = 30

CASH_BALANCES = {
    "sterling-ig":   -150_000_000,
    "global-credit": -120_000_000,
}

PORTFOLIOS = [
    {
        "id": "sterling-ig",
        "name": "Sterling IG Fund",
        "bonds": [
            {
                "isin": "GB00BYY5F144",
                "positions": [
                    {"type": "bond", "notional": 50_000_000, "counterparty": None, "repo_maturity_t": None},
                    {"type": "repo", "notional": -15_000_000, "counterparty": "Barclays", "repo_maturity_t": 2},
                    {"type": "repo", "notional": -10_000_000, "counterparty": "JPM", "repo_maturity_t": 4},
                ],
            },
            {
                "isin": "GB00BMBL1G81",
                "positions": [
                    {"type": "bond", "notional": 75_000_000, "counterparty": None, "repo_maturity_t": None},
                    {"type": "repo", "notional": -20_000_000, "counterparty": "Goldman Sachs", "repo_maturity_t": 1},
                    {"type": "repo", "notional": -15_000_000, "counterparty": "Morgan Stanley", "repo_maturity_t": 3},
                    {"type": "repo", "notional": -10_000_000, "counterparty": "HSBC", "repo_maturity_t": 5},
                ],
            },
            {
                "isin": "GB00BMV7TC07",
                "positions": [
                    {"type": "bond", "notional": 100_000_000, "counterparty": None, "repo_maturity_t": None},
                    {"type": "repo", "notional": -30_000_000, "counterparty": "Citi", "repo_maturity_t": 3},
                ],
            },
            {
                "isin": "US30303M8T60",
                "positions": [
                    {"type": "bond", "notional": 30_000_000, "counterparty": None, "repo_maturity_t": None},
                    {"type": "repo", "notional": -10_000_000, "counterparty": "Barclays", "repo_maturity_t": 1},
                    {"type": "repo", "notional": -5_000_000, "counterparty": "JPM", "repo_maturity_t": 2},
                ],
            },
            {
                "isin": "GB00BL6C6328",
                "positions": [
                    {"type": "bond", "notional": 60_000_000, "counterparty": None, "repo_maturity_t": None},
                    {"type": "repo", "notional": -18_000_000, "counterparty": "Morgan Stanley", "repo_maturity_t": 2},
                    {"type": "repo", "notional": -12_000_000, "counterparty": "HSBC", "repo_maturity_t": 5},
                ],
            },
            {
                "isin": "US037833DX25",
                "positions": [
                    {"type": "bond", "notional": 35_000_000, "counterparty": None, "repo_maturity_t": None},
                    {"type": "repo", "notional": -9_000_000, "counterparty": "Goldman Sachs", "repo_maturity_t": 3},
                ],
            },
        ],
    },
    {
        "id": "global-credit",
        "name": "Global Credit Opportunities",
        "bonds": [
            {
                "isin": "GB00BMV7TC07",
                "positions": [
                    {"type": "bond", "notional": 60_000_000, "counterparty": None, "repo_maturity_t": None},
                    {"type": "repo", "notional": -25_000_000, "counterparty": "Deutsche Bank", "repo_maturity_t": 2},
                ],
            },
            {
                "isin": "US22890MAA09",
                "positions": [
                    {"type": "bond", "notional": 40_000_000, "counterparty": None, "repo_maturity_t": None},
                    {"type": "repo", "notional": -12_000_000, "counterparty": "Goldman Sachs", "repo_maturity_t": 1},
                    {"type": "repo", "notional": -8_000_000, "counterparty": "Barclays", "repo_maturity_t": 4},
                ],
            },
            {
                "isin": "GB00BYY5F144",
                "positions": [
                    {"type": "bond", "notional": 25_000_000, "counterparty": None, "repo_maturity_t": None},
                    {"type": "repo", "notional": -10_000_000, "counterparty": "Morgan Stanley", "repo_maturity_t": 3},
                ],
            },
            {
                "isin": "US30303M8T60",
                "positions": [
                    {"type": "bond", "notional": 45_000_000, "counterparty": None, "repo_maturity_t": None},
                    {"type": "repo", "notional": -15_000_000, "counterparty": "JPM", "repo_maturity_t": 1},
                    {"type": "repo", "notional": -10_000_000, "counterparty": "Citi", "repo_maturity_t": 2},
                    {"type": "repo", "notional": -5_000_000, "counterparty": "HSBC", "repo_maturity_t": 5},
                ],
            },
            {
                "isin": "XS2356943897",
                "positions": [
                    {"type": "bond", "notional": 30_000_000, "counterparty": None, "repo_maturity_t": None},
                    {"type": "repo", "notional": -11_000_000, "counterparty": "Barclays", "repo_maturity_t": 2},
                    {"type": "repo", "notional": -7_000_000, "counterparty": "Deutsche Bank", "repo_maturity_t": 4},
                ],
            },
            {
                "isin": "US037833DX25",
                "positions": [
                    {"type": "bond", "notional": 40_000_000, "counterparty": None, "repo_maturity_t": None},
                    {"type": "repo", "notional": -13_000_000, "counterparty": "Morgan Stanley", "repo_maturity_t": 3},
                ],
            },
        ],
    },
]

_last_refreshed = None
_price_cache = {}
SENT_TRADES = {}  # {portfolio_id: [trade_dict, ...]}


def refresh_prices():
    global _last_refreshed, _price_cache
    today = date.today()
    curve = fetch_boe_yield_curve()

    for isin, spec in BOND_SPECS.items():
        mat = date.fromisoformat(spec["maturity_date"])

        if curve:
            yld = get_yield_for_bond(mat, today, curve, spec["credit_spread"])
        else:
            yld = spec["fallback_yield"]

        result = price_bond(spec["coupon"], mat, yld, spec["freq"], spec["convention"], today)
        result["yield_rate"] = round(yld * 100, 4)
        result["source"] = "BoE" if curve else "fallback"
        _price_cache[isin] = result

    _last_refreshed = datetime.now().isoformat(timespec="seconds")


def _count_business_days_to(target: date) -> int:
    """Count business days from today (inclusive of tomorrow) to target date."""
    today = date.today()
    d = today
    while d.weekday() >= 5:
        d += timedelta(days=1)
    if target <= d:
        return 0
    count = 0
    cursor = d
    while cursor < target:
        cursor += timedelta(days=1)
        if cursor.weekday() < 5:
            count += 1
    return count


def _auto_settle(ptf: dict):
    """Merge confirmed trades whose sdate has passed into PORTFOLIOS positions."""
    today = date.today()
    for trade in SENT_TRADES.get(ptf["id"], []):
        if trade.get("status") != "confirmed":
            continue
        try:
            sdate = date.fromisoformat(trade["sdate"])
        except (KeyError, ValueError):
            continue
        if sdate > today:
            continue
        # Find the matching bond entry
        bond_entry = next((b for b in ptf["bonds"] if b["isin"] == trade["isin"]), None)
        if bond_entry is None:
            continue
        mdate = date.fromisoformat(trade["mdate"])
        repo_maturity_t = _count_business_days_to(mdate)
        bond_entry["positions"].append({
            "type": "repo",
            "notional": trade["notional"],
            "counterparty": trade["counterparty"],
            "repo_maturity_t": repo_maturity_t,
        })
        trade["status"] = "settled"


def build_portfolio_response():
    out = []
    for ptf in PORTFOLIOS:
        _auto_settle(ptf)
        cpty_names = [c["name"] for c in COUNTERPARTY_RULES.get(ptf["id"], [])]
        bonds = []
        for bond_entry in ptf["bonds"]:
            isin = bond_entry["isin"]
            spec = BOND_SPECS[isin]
            pricing = _price_cache.get(isin, {})
            dirty = pricing.get("dirty_price", 100.0)

            positions = []
            for pos in bond_entry["positions"]:
                mv = dirty / 100 * pos["notional"]
                positions.append({**pos, "market_value": round(mv, 2)})

            bonds.append({
                "isin": isin,
                "name": spec["name"],
                "coupon": spec["coupon"] * 100,
                "maturity_date": spec["maturity_date"],
                "clean_price": pricing.get("clean_price"),
                "accrued_interest": pricing.get("accrued_interest"),
                "dirty_price": pricing.get("dirty_price"),
                "positions": positions,
            })
        out.append({
            "id": ptf["id"],
            "name": ptf["name"],
            "counterparties": cpty_names,
            "cash_balance": CASH_BALANCES.get(ptf["id"], 0),
            "sent_trades": SENT_TRADES.get(ptf["id"], []),
            "bonds": bonds,
        })
    return {"portfolios": out, "last_refreshed": _last_refreshed}


def formatMv(v):
    return f"{abs(v) / 1_000_000:.1f}M"


def _business_day_offset(start: date, days: int) -> date:
    d = start
    count = 0
    while count < days:
        d += timedelta(days=1)
        if d.weekday() < 5:
            count += 1
    return d


def build_compliance_task(portfolio_id, draft_trades):
    ptf = next((p for p in PORTFOLIOS if p["id"] == portfolio_id), None)
    if not ptf:
        return None

    book = []
    proposed = []
    maturity_months = set()

    today = date.today()
    for bond_entry in ptf["bonds"]:
        isin = bond_entry["isin"]
        spec = BOND_SPECS[isin]
        pricing = _price_cache.get(isin, {})
        dirty = pricing.get("dirty_price", 100.0)

        for pos in bond_entry["positions"]:
            if pos["type"] != "repo":
                continue
            mv = dirty / 100 * pos["notional"]
            repo_mat = _business_day_offset(today, pos.get("repo_maturity_t", 0))
            repo_mat_str = repo_mat.isoformat()
            book.append({
                "counterparty": pos["counterparty"],
                "notional": pos["notional"],
                "market_value": round(mv, 2),
                "maturity": repo_mat_str,
            })

    for trade in draft_trades:
        isin = trade.get("isin", "")
        spec = BOND_SPECS.get(isin)
        mat_date = trade.get("maturity", "2026-01-01")
        pricing = _price_cache.get(isin, {})
        dirty = pricing.get("dirty_price", 100.0)
        notional = trade.get("notional", 0)
        mv = dirty / 100 * notional
        proposed.append({
            "counterparty": trade.get("counterparty", "Unknown"),
            "notional": round(notional),
            "market_value": round(mv, 2),
            "maturity": mat_date,
        })
        maturity_months.add(mat_date[:7])

    total_book_mv = sum(abs(p["market_value"]) for p in book)
    total_book_mv += sum(abs(pricing.get("dirty_price", 100.0) / 100 * t.get("notional", 0))
                         for t in draft_trades
                         for pricing in [_price_cache.get(t.get("isin", ""), {})])

    rules = []
    child_id = 1
    parent_id = 1

    mv_desc = f"MV limit ±{MATURITY_MV_BOUND // 1_000_000}M"
    pct_desc = f"Max {MATURITY_PCT_BOUND}% of total book"

    for month in sorted(maturity_months):
        rules.append({
            "parent_rule_id": parent_id,
            "type": "concentration_maturity",
            "logic": "OR",
            "description": f"{month}: {mv_desc} OR {pct_desc}",
            "children": [
                {
                    "id": child_id,
                    "description": f"{month} {mv_desc}",
                    "dimension": "maturity_month",
                    "filter": month,
                    "lower_bound": -MATURITY_MV_BOUND,
                    "upper_bound": MATURITY_MV_BOUND,
                },
                {
                    "id": child_id + 1,
                    "description": f"{month} {pct_desc} ({formatMv(total_book_mv)} total)",
                    "dimension": "maturity_pct",
                    "filter": month,
                    "total_limit": round(total_book_mv),
                    "lower_bound": 0,
                    "upper_bound": MATURITY_PCT_BOUND,
                },
            ],
        })
        parent_id += 1
        child_id += 2

    cpty_rules = COUNTERPARTY_RULES.get(portfolio_id, [])
    for cr in cpty_rules:
        limit_desc = f"MV limit [{formatMv(cr['lower_bound'])}, +{formatMv(cr['upper_bound'])}]"
        rules.append({
            "parent_rule_id": parent_id,
            "type": "counterparty",
            "logic": "OR",
            "description": f"{cr['name']}: {limit_desc}",
            "children": [{
                "id": child_id,
                "description": f"{cr['name']} {limit_desc}",
                "dimension": "counterparty",
                "filter": cr["name"],
                "lower_bound": cr["lower_bound"],
                "upper_bound": cr["upper_bound"],
            }],
        })
        parent_id += 1
        child_id += 1

    rule_map = {}
    for r in rules:
        rule_map[r["parent_rule_id"]] = {
            "type": r["type"],
            "logic": r["logic"],
            "description": r.get("description", ""),
            "children": {c["id"]: c for c in r["children"]},
        }

    task = {
        "rules": rules,
        "current_book": book,
        "proposed_trades": proposed,
    }
    return task, rule_map


def parse_compliance_results(raw_output, rule_map):
    text = raw_output.strip()
    # Strip markdown fences in any format
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else text[3:]
    if text.endswith("```"):
        text = text[:-3].strip()
    # Try to extract JSON object if there's surrounding text
    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end != -1:
        text = text[start:end + 1]

    try:
        result = json.loads(text)
    except json.JSONDecodeError:
        return {"error": f"Failed to parse compliance engine response: {text[:200]}"}

    maturity_results = []
    counterparty_results = []

    for pr in result.get("parent_results", []):
        pid = pr["parent_rule_id"]
        meta = rule_map.get(pid, {})
        rule_children_spec = meta.get("children", {})

        child_results = []
        for cr in pr.get("child_results", []):
            spec = rule_children_spec.get(cr["id"], {})
            child_results.append({
                "id": cr["id"],
                "description": spec.get("description", ""),
                "filter": spec.get("filter", ""),
                "net_value": cr["net_value"],
                "lower_bound": cr["lower_bound"],
                "upper_bound": cr["upper_bound"],
                "breached": cr["breached"],
            })

        entry = {
            "parent_rule_id": pid,
            "description": meta.get("description", ""),
            "logic": meta.get("logic", pr.get("logic", "")),
            "breached": pr["breached"],
            "child_results": child_results,
        }

        if meta.get("type") == "counterparty":
            entry["tradeable"] = not pr["breached"]
            counterparty_results.append(entry)
        else:
            maturity_results.append(entry)

    return {
        "maturity_results": maturity_results,
        "counterparty_results": counterparty_results,
        "pm_override_required": result.get("pm_override_required", False),
        "verdict": result.get("verdict", ""),
    }


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/portfolios")
def get_portfolios():
    return jsonify(build_portfolio_response())


@app.route("/api/refresh-prices", methods=["POST"])
def api_refresh_prices():
    refresh_prices()
    return jsonify(build_portfolio_response())


@app.route("/api/run-compliance", methods=["POST"])
def api_run_compliance():
    body = request.get_json()
    portfolio_id = body.get("portfolio_id")
    draft_trades = body.get("draft_trades", [])

    result = build_compliance_task(portfolio_id, draft_trades)
    if result is None:
        return jsonify({"error": "Portfolio not found"}), 404

    task, rule_map = result
    raw_output = run_compliance_check(task)
    results = parse_compliance_results(raw_output, rule_map)
    return jsonify(results)


@app.route("/api/send-trade", methods=["POST"])
def api_send_trade():
    body = request.get_json()
    portfolio_id = body.get("portfolio_id")
    trades = body.get("trades", [])

    if portfolio_id not in SENT_TRADES:
        SENT_TRADES[portfolio_id] = []

    sent_at = datetime.now().isoformat(timespec="seconds")
    for trade in trades:
        isin = trade.get("isin", "")
        spec = BOND_SPECS.get(isin, {})
        pricing = _price_cache.get(isin, {})
        dirty = pricing.get("dirty_price", 100.0)
        notional = trade.get("notional", 0)
        mv = dirty / 100 * notional

        approved = trade.get("approved_counterparties", [])
        SENT_TRADES[portfolio_id].append({
            "id": trade.get("id", sent_at),
            "isin": isin,
            "bond_name": spec.get("name", trade.get("bond_name", isin)),
            "notional": round(notional),
            "market_value": round(mv, 2),
            "counterparty": "",
            "approved_counterparties": approved,
            "sdate": trade.get("sdate", ""),
            "mdate": trade.get("mdate", ""),
            "reason": trade.get("reason", "repo"),
            "status": "ordered",
            "sent_at": sent_at,
        })

    return jsonify({"sent_trades": SENT_TRADES[portfolio_id]})


@app.route("/api/sent-trades/<portfolio_id>")
def api_get_sent_trades(portfolio_id):
    return jsonify({"sent_trades": SENT_TRADES.get(portfolio_id, [])})


@app.route("/api/reset", methods=["POST"])
def api_reset():
    SENT_TRADES.clear()
    return jsonify(build_portfolio_response())


@app.route("/api/execute-trade", methods=["POST"])
def api_execute_trade():
    body = request.get_json()
    portfolio_id = body.get("portfolio_id")
    trade_id = body.get("trade_id")

    trades = SENT_TRADES.get(portfolio_id, [])
    trade = next((t for t in trades if t["id"] == trade_id), None)
    if trade is None or trade.get("status") != "ordered":
        return jsonify({"error": "Trade not found or not in ordered state"}), 404

    result = run_dealer_check(trade)
    confirmed_at = datetime.now().isoformat(timespec="seconds")

    if result.get("confirmed"):
        trade["status"] = "confirmed"
        trade["counterparty"] = result.get("chosen_counterparty", trade.get("approved_counterparties", ["Unknown"])[0])
        trade["repo_rate"] = result.get("repo_rate")
        trade["dealer_commentary"] = result.get("dealer_commentary", "")
        trade["confirmed_at"] = confirmed_at
        return jsonify({"trade": trade})
    else:
        trade["status"] = "rejected"
        trade["rejection_reason"] = result.get("rejection_reason", "")
        trade["dealer_commentary"] = result.get("dealer_commentary", "")
        return jsonify({"rejected": True, "trade": trade})


if __name__ == "__main__":
    refresh_prices()
    port = int(os.environ.get("PORT", 5000))
    app.run(debug=False, host="0.0.0.0", port=port)
