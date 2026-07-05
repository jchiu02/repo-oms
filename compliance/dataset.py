import json
from pathlib import Path
from dotenv import load_dotenv
from anthropic import Anthropic

_DIR = Path(__file__).parent

load_dotenv()

client = Anthropic()
MODEL = "claude-haiku-4-5"

GENERATOR_PROMPT = """You are generating synthetic test cases for evaluating an AI compliance pre-screening system for repo trading at an asset manager.

<system_being_tested>
The system receives a rule configuration, a current repo book, and a proposed new trade. It must determine whether adding the proposed trade breaches any parent rules, and whether PM override is required.

Rules are hierarchical:
- Parent rules contain child rules
- Each parent rule combines its children with AND or OR logic
- OR: parent breached if ANY child breached
- AND: parent breached only if ALL children breached
- PM override required if ANY parent rule is breached

Rule configurations vary per test case because they come from different client mandates.

All evaluations are net and post-trade: take the current book, apply the proposed trade, then check the resulting net position against each rule.
</system_being_tested>

<sign_convention>
- Positive notional = reverse repo (cash out to counterparty, collateral in)
- Negative notional = repo (cash in from counterparty, collateral out)
- Positions in the same maturity window offset each other in net calculations
- pv01 = sensitivity to a 1bp move in nominal rates (signed, GBP)
- ie01 = sensitivity to a 1bp move in inflation rates (signed, GBP)
- clearing_status = "bilateral" or "cleared"
</sign_convention>

<rule_types>
Each parent rule has a "type" that constrains its children's dimensions:
- "concentration_maturity": children can only use dimensions "maturity_month" or "maturity_pct"
- "counterparty": children can only use dimensions "counterparty", "counterparty_mtm", or "counterparty_pct"
- "counterparty_risk": children can only use dimensions "counterparty_pv01" or "counterparty_ie01"
Do NOT mix dimension types within a single parent rule.
</rule_types>

<rule_dimensions>
Child rules aggregate on one of these dimensions:
maturity_month - aggregate the market_value field (not notional) across all positions maturing in a given month, check against a numeric range. Maturity concentration is assessed on a mark-to-market basis
maturity_pct - aggregate absolute market_value for a maturity month as a percentage of total_limit
counterparty - aggregate the market_value field across all positions with a given counterparty, check against a numeric range (lower_bound, upper_bound)
counterparty_mtm - aggregate the mtm field (not notional) of all positions with a given counterparty, check against a numeric range
counterparty_pct - aggregate market_value with a given counterparty, express as percentage of the child rule's total_limit. Bounds are percentages
counterparty_pv01 - aggregate the pv01 field by counterparty, compute signed sum then take absolute value. net_value = |sum(pv01)|. Check against upper_bound
counterparty_ie01 - same as counterparty_pv01 but using ie01 field. net_value = |sum(ie01)|. Check against upper_bound

For counterparty_pv01 and counterparty_ie01, a child rule may include "applies_to":
- "bilateral_only": only aggregate positions where clearing_status = "bilateral"
- "all" (default): aggregate all positions
</rule_dimensions>

<bound_forms>
upper_bound can be either:
- Static: an integer (existing behaviour)
- Formula: {"max_of": [integer_floor, {"pct": float, "ref": "benchmark_pv01" or "benchmark_ie01"}]}
  Resolved = max(integer_floor, pct * external_inputs[ref])
The resolved value is used for breach comparison.
</bound_forms>

<external_inputs>
Each task may include an "external_inputs" object with:
- benchmark_pv01: integer (GBP)
- benchmark_ie01: integer (GBP)
These are used to resolve formula-based upper_bound values.
Include external_inputs in every test case that uses formula bounds.
</external_inputs>

<task>
Generate diverse test cases. Each test case contains:
1. A rule configuration (one or more parent rules with children and AND/OR logic)
2. A current repo book (3-8 positions with signed notionals)
3. A proposed new trade (signed notional)
4. The expected output after applying the rules

Vary scenarios to cover:
- Clean pass (no parent rules breached)
- OR parent breached (at least one child triggers)
- AND parent breached (all children trigger)
- AND parent NOT breached despite partial child breach (critical edge case)
- Multiple parent rules breached simultaneously
- Net calculation reduces exposure (proposed trade offsets existing position)
- Net calculation increases exposure beyond limit
- Edge cases at exactly the threshold
- PV01 counterparty breach where the integer floor binds (benchmark is small, so pct*benchmark < floor)
- PV01 counterparty breach where the percentage binds (benchmark is large, so pct*benchmark > floor)
- IE01 breach where the same trade passes the PV01 rule
- Bilateral-only rule where a cleared position is correctly excluded from the aggregation
- AND parent combining a PV01 child and an IE01 child, where only one breaches
- Edge case where net IE01 exactly equals the cap (boundary, no breach)
</task>

<output_format>
Return a JSON array. Each element:
{
  "scenario_label": "short description of what this case tests",
  "task": {
    "rules": [
      {
        "parent_rule_id": integer (sequential starting from 1),
        "type": "concentration_maturity" or "counterparty",
        "logic": "AND" or "OR",
        "children": [
          {
            "id": integer (sequential starting from 1, continuing across parents),
            "description": "human readable rule",
            "dimension": "maturity_month" or "maturity_pct" or "counterparty" or "counterparty_mtm" or "counterparty_pct" or "counterparty_pv01" or "counterparty_ie01",
            "filter": "YYYY-MM for maturity dimensions, counterparty name for counterparty dimensions",
            "lower_bound": integer (GBP, can be negative),
            "upper_bound": integer or {"max_of": [integer_floor, {"pct": float, "ref": "benchmark_pv01" or "benchmark_ie01"}]},
            "applies_to": "all" or "bilateral_only" (optional, for counterparty_pv01/ie01 only, defaults to "all")
          }
        ]
      }
    ],
    "external_inputs": {
      "benchmark_pv01": integer (GBP, only needed if formula bounds used),
      "benchmark_ie01": integer (GBP, only needed if formula bounds used)
    },
    "current_book": [
      {"counterparty": "string", "notional": integer (signed), "maturity": "YYYY-MM-DD", "market_value": integer, "pv01": integer (signed, GBP), "ie01": integer (signed, GBP), "clearing_status": "bilateral" or "cleared"}
    ],
    "proposed_trades": [
      {"counterparty": "string", "notional": integer (signed), "maturity": "YYYY-MM-DD", "market_value": integer, "pv01": integer (signed, GBP), "ie01": integer (signed, GBP), "clearing_status": "bilateral" or "cleared"}
    ]
  },
  "expected": {
    "parent_results": [
      {
        "parent_rule_id": integer,
        "logic": "AND" or "OR",
        "breached": boolean,
        "child_results": [
          {
            "id": integer,
            "breached": boolean,
            "net_value": number (calculated net for that dimension/filter post-trade),
            "lower_bound": integer,
            "upper_bound": integer (resolved value if formula was used)
          }
        ],
        "reasoning": "explanation referencing specific numbers"
      }
    ],
    "pm_override_required": boolean,
    "verdict": "string describing overall outcome"
  }
}
</output_format>

<constraints>
- All net calculations must be mathematically correct based on the book + proposed trade
- A child rule breaches when net_value falls OUTSIDE the [lower_bound, upper_bound] range
- Counterparty names from: Barclays, JPM, Goldman Sachs, Morgan Stanley, Citi, HSBC, BNP Paribas, Deutsche Bank
- Maturity dates between 2026-06-15 and 2026-12-31
- Notionals between -800000000 and +800000000 (signed)
- pm_override_required is true if and only if any parent_results entry has breached=true
- For AND logic scenarios, deliberately include cases where some but not all children breach
- Reasoning must reference specific calculated values and limits
- Each parent rule's type must match its children's dimensions (concentration_maturity -> maturity_month/maturity_pct only; counterparty -> counterparty/counterparty_mtm/counterparty_pct only; counterparty_risk -> counterparty_pv01/counterparty_ie01 only)
- Do NOT mix dimension types within a single parent rule
- parent_rule_id and child id are integers, not strings
- Every position in current_book and proposed_trades must include pv01, ie01, clearing_status, and market_value fields
- For counterparty_pv01 and counterparty_ie01, net_value = |signed sum of matching pv01/ie01|. The signed sum is computed first, then absolute value taken
- When applies_to = "bilateral_only", only positions with clearing_status = "bilateral" contribute to the sum
- When upper_bound is a formula object, resolve it as max(floor, pct * external_inputs[ref]) and use the resolved integer for breach comparison. Include external_inputs in the task when formula bounds are used
- pv01 values typically between -200000 and +200000 (GBP)
- ie01 values typically between -150000 and +150000 (GBP)
</constraints>

Generate 20 diverse test cases. Include at least one of each new scenario type (PV01 floor binds, PV01 pct binds, IE01 breach with PV01 pass, bilateral-only exclusion, AND with PV01+IE01 partial breach, IE01 at exact cap). The rest should cover existing scenario types with the new fields present on all positions."""


def _call_generator() -> list[dict]:
    chunks = []
    with client.messages.stream(
        model=MODEL,
        max_tokens=32000,
        temperature=1.0,
        messages=[{"role": "user", "content": GENERATOR_PROMPT}],
    ) as stream:
        for text_chunk in stream.text_stream:
            chunks.append(text_chunk)
    text = "".join(chunks)

    # Extract the outermost JSON array, ignoring any markdown fences or
    # commentary the model may add before/after it.
    start = text.find("[")
    end = text.rfind("]")
    if start == -1 or end == -1:
        raise ValueError(f"No JSON array found in model output:\n{text[:500]}")

    return json.loads(text[start : end + 1])


def generate_dataset(output_file: str = None) -> list[dict]:
    """Generate 20 test cases in a single call."""
    if output_file is None:
        output_file = str(_DIR / "dataset.json")
    print("Generating dataset...")

    dataset = _call_generator()
    print(f"Generated {len(dataset)} test cases.")

    with open(output_file, "w") as f:
        json.dump(dataset, f, indent=2)

    print(f"Saved to {output_file}")
    return dataset


if __name__ == "__main__":
    generate_dataset()
