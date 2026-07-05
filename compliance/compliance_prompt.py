import json
from dotenv import load_dotenv
from anthropic import Anthropic

load_dotenv()

client = Anthropic()
MODEL = "claude-haiku-4-5"

PRODUCTION_PROMPT = """
You are a repo trading compliance validator. Given a rule configuration,
a current repo book, and one or more proposed trades, you must determine
whether adding all proposed trades would breach any parent rules and
whether PM override is required.

<evaluation_approach>
All evaluations are net and post-trade:
1. Take the current book
2. Apply ALL proposed trades (add every trade in the proposed_trades list
   to the book as a single block)
3. For each child rule, calculate the relevant net value across the
   resulting book (current_book + all proposed_trades combined)
4. Check whether that net value falls OUTSIDE the rule's
   [lower_bound, upper_bound] range - if outside, the child rule is breached
5. Combine child results at the parent level using the parent's AND/OR logic
6. PM override is required if any parent rule is breached
</evaluation_approach>

<sign_convention>
- Positive notional = reverse repo (cash out to counterparty, collateral in)
- Negative notional = repo (cash in from counterparty, collateral out)
- Positions in the same maturity window or with the same counterparty
  offset each other in net calculations
- market_value = current mark-to-market value of the position in GBP.
  Used by maturity_month rules for concentration checks
- mtm = mark-to-market exposure (positive = unrealised gain, negative =
  unrealised loss). Used by counterparty_mtm rules
- pv01 = sensitivity to a 1bp move in nominal rates (signed, GBP)
- ie01 = sensitivity to a 1bp move in inflation rates (signed, GBP)
- clearing_status = "bilateral" or "cleared"
</sign_convention>

<rule_types>
Each parent rule has a "type" that constrains its children's dimensions:
- "concentration_maturity": children can only use dimensions "maturity_month" or "maturity_pct"
- "counterparty": children can only use dimensions "counterparty", "counterparty_mtm", or "counterparty_pct"
- "counterparty_risk": children can only use dimensions "counterparty_pv01" or "counterparty_ie01"
</rule_types>

<rule_dimensions>
maturity_month: aggregate the market_value field (not notional) of all
positions whose maturity falls in the filter month (YYYY-MM format).
Maturity concentration is assessed on a mark-to-market basis

counterparty: aggregate the market_value field (not notional) of all
positions with the specified counterparty

counterparty_mtm: aggregate the mtm field (not notional) of all positions
with the specified counterparty. Each position carries an mtm field
representing its current mark-to-market exposure in GBP

maturity_pct: aggregate the absolute market_value of all positions whose
maturity falls in the filter month, then express as a percentage of the
child rule's total_limit (total book MV across all months).
Formula: net_value = (month_abs_mv / total_limit) * 100
Bounds are percentages (e.g. upper_bound=35 means max 35% of total book)

counterparty_pct: aggregate the market_value field of all positions with
the specified counterparty, then express as a percentage of the child
rule's total_limit. Formula: net_value = (net_market_value / total_limit) * 100
Bounds are percentages (e.g. lower_bound=-50, upper_bound=50 means ±50%)

counterparty_pv01: aggregate the pv01 field of all matching positions by
counterparty. Compute the signed sum, then take the absolute value.
net_value = |sum of pv01 for matching positions|. Check against upper_bound.

counterparty_ie01: same as counterparty_pv01 but using the ie01 field.
net_value = |sum of ie01 for matching positions|. Check against upper_bound.

For counterparty_pv01 and counterparty_ie01 dimensions, a child rule may
include an "applies_to" field:
- "bilateral_only": only aggregate positions where clearing_status = "bilateral"
- "all" (default if omitted): aggregate all positions regardless of clearing_status
</rule_dimensions>

<bound_resolution>
upper_bound can be either a static integer or a formula object.

Static form (unchanged): upper_bound is an integer.

Formula form: upper_bound is {"max_of": [integer_floor, {"pct": float, "ref": "benchmark_pv01" or "benchmark_ie01"}]}
Resolved bound = max(integer_floor, pct * external_inputs[ref])
where external_inputs is provided in the task input.

When upper_bound is a formula, resolve it to a concrete number before
comparing against net_value. Report the resolved integer in the output.
</bound_resolution>

<external_inputs>
The task may include an "external_inputs" object with:
- benchmark_pv01: integer (GBP, benchmark PV01)
- benchmark_ie01: integer (GBP, benchmark IE01)
These are used to resolve formula-based bounds.
</external_inputs>

<logic_rules>
OR parent rule: breached if ANY child rule is breached
AND parent rule: breached only if ALL child rules are breached
A child rule is breached when its calculated net_value falls strictly
outside the range: net_value < lower_bound OR net_value > upper_bound
</logic_rules>

<output_format>
Return your response as a JSON object with this exact structure. Fields are
ordered deliberately - compute child_results before deciding the parent's
breached flag, and write reasoning last, after the flags are settled:
{
  "parent_results": [
    {
      "parent_rule_id": "integer from input",
      "logic": "AND or OR from input",
      "child_results": [
        {
          "id": "integer from input",
          "net_value": number (calculated net post-trade: GBP for notional/mtm dimensions, percentage for pct dimensions),
          "lower_bound": integer (from input),
          "upper_bound": integer (from input),
          "breached": boolean
        }
      ],
      "breached": boolean,
      "reasoning": "explanation referencing the specific calculated net values and limits"
    }
  ],
  "pm_override_required": boolean,
  "verdict": "concise string describing the overall outcome"
}
</output_format>

<constraints>
- net_value must be the actual computed number, not a formula or string (GBP for notional/mtm, percentage for pct)
- Breach occurs when net_value is strictly outside the range (< lower_bound OR > upper_bound)
- Compute child_results first; the parent's breached flag must be derived from the child_results you just wrote, never decided before them
- pm_override_required must be true if and only if any parent has breached=true
- Maintain consistency: child breach flags must match net_value vs bounds, parent breach must follow AND/OR logic, override must follow any-parent-breach
- Return ONLY the JSON object, no markdown fences, no explanation text before or after
</constraints>

Here is the input to evaluate:

{task_json}
"""


def run_compliance_check(task: dict) -> str:
    """
    Run a compliance check for a single test case task.
    Returns the raw model output string.
    """
    prompt = PRODUCTION_PROMPT.replace("{task_json}", json.dumps(task, indent=2))

    message = client.messages.create(
        model=MODEL,
        max_tokens=8000,
        temperature=0.0,
        messages=[{"role": "user", "content": prompt}],
    )

    return message.content[0].text


def run_compliance_check_from_inputs(test_case: dict) -> str:
    """Adapter for the evaluator: extracts task from a test case and runs the check."""
    return run_compliance_check(test_case["task"])


if __name__ == "__main__":
    # Smoke test against a minimal hand-crafted case
    task = {
        "rules": [
            {
                "parent_rule_id": 1,
                "type": "counterparty",
                "logic": "OR",
                "children": [
                    {
                        "id": 1,
                        "description": "JPM net exposure within [-200M, 200M]",
                        "dimension": "counterparty",
                        "filter": "JPM",
                        "lower_bound": -200_000_000,
                        "upper_bound": 200_000_000,
                    }
                ],
            }
        ],
        "current_book": [
            {"counterparty": "JPM", "notional": 180_000_000, "maturity": "2026-09-30"}
        ],
        "proposed_trades": [
            {
                "counterparty": "JPM",
                "notional": 50_000_000,
                "maturity": "2026-10-31",
            }
        ],
    }

    output = run_compliance_check(task)
    print(output)
    # Expected: JPM net = 230M > 200M → child breached → OR parent breached → pm_override_required=True
