import json
from pathlib import Path
from statistics import mean
from dotenv import load_dotenv
from anthropic import Anthropic

_DIR = Path(__file__).parent

load_dotenv()

client = Anthropic()
MODEL = "claude-haiku-4-5"


GRADER_PROMPT = """You are grading a repo pre-trade compliance engine's output against the expected ground truth.

## Scenario
{scenario_label}

## Engine input (task)
```json
{task_json}
```

## Expected output (ground truth)
```json
{expected_json}
```

## Engine output (under test)
{engine_output}

## Scoring rubric
- 1-3: Wrong `pm_override_required` (the most critical error — mandatory fail at this level)
- 4-6: Correct `pm_override_required` but wrong per-parent breached status, or AND/OR logic errors
- 7-8: Correct verdicts with minor net_value calculation errors, or incomplete reasoning
- 9-10: Fully correct — right `pm_override_required`, right per-parent and per-child breach flags, mathematically accurate net_values, reasoning that cites specific numbers

Pay particular attention to AND-logic parents: an AND parent is NOT breached unless ALL children breach — a partial child breach must NOT trigger the parent. Penalize heavily if this is wrong.

Return JSON with this exact structure:
```json
{{
    "strengths": ["...", "..."],
    "weaknesses": ["...", "..."],
    "reasoning": "concise explanation referencing specific values",
    "score": <integer 1-10>
}}
```
"""


def grade_output(test_case: dict, engine_output: str) -> dict:
    prompt = GRADER_PROMPT.format(
        scenario_label=test_case.get("scenario_label", ""),
        task_json=json.dumps(test_case["task"], indent=2),
        expected_json=json.dumps(test_case["expected"], indent=2),
        engine_output=engine_output,
    )

    text = client.messages.create(
        model=MODEL,
        max_tokens=1000,
        temperature=0.0,
        messages=[
            {"role": "user", "content": prompt},
            {"role": "assistant", "content": "```json"},
        ],
        stop_sequences=["```"],
    ).content[0].text

    return json.loads(text)


def run_test_case(test_case: dict, run_prompt_fn) -> dict:
    output = run_prompt_fn(test_case)
    grade = grade_output(test_case, output)
    return {
        "test_case": test_case,
        "output": output,
        "score": grade["score"],
        "reasoning": grade["reasoning"],
        "strengths": grade.get("strengths", []),
        "weaknesses": grade.get("weaknesses", []),
    }


def _generate_html_report(results: list) -> str:
    total = len(results)
    scores = [r["score"] for r in results]
    avg = mean(scores) if scores else 0
    pass_rate = 100 * len([s for s in scores if s >= 7]) / total if total else 0

    rows = ""
    for r in results:
        tc = r["test_case"]
        score = r["score"]
        score_class = "score-high" if score >= 8 else ("score-low" if score <= 5 else "score-medium")
        task_json = json.dumps(tc["task"], indent=2)
        expected_json = json.dumps(tc["expected"], indent=2)
        rows += f"""
        <tr>
            <td>{tc.get('scenario_label', '')}</td>
            <td><pre>{task_json}</pre></td>
            <td><pre>{expected_json}</pre></td>
            <td><pre>{r['output']}</pre></td>
            <td class="score-col"><span class="score {score_class}">{score}</span></td>
            <td>{r['reasoning']}</td>
        </tr>"""

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Repo Compliance Evaluation Report</title>
<style>
  body {{ font-family: Arial, sans-serif; margin: 0; padding: 20px; color: #333; }}
  .header {{ background: #f0f0f0; padding: 20px; border-radius: 5px; margin-bottom: 20px; }}
  .summary-stats {{ display: flex; gap: 10px; flex-wrap: wrap; }}
  .stat-box {{ background: #fff; border-radius: 5px; padding: 15px;
               box-shadow: 0 2px 5px rgba(0,0,0,.1); flex-basis: 30%; min-width: 180px; }}
  .stat-value {{ font-size: 24px; font-weight: bold; margin-top: 5px; }}
  table {{ width: 100%; border-collapse: collapse; margin-top: 20px; }}
  th {{ background: #4a4a4a; color: #fff; text-align: left; padding: 12px; }}
  td {{ padding: 10px; border-bottom: 1px solid #ddd; vertical-align: top; width: 18%; }}
  tr:nth-child(even) {{ background: #f9f9f9; }}
  pre {{ background: #f5f5f5; border: 1px solid #ddd; border-radius: 4px; padding: 8px;
         font-size: 12px; white-space: pre-wrap; word-wrap: break-word; margin: 0; }}
  .score {{ font-weight: bold; padding: 5px 10px; border-radius: 3px; display: inline-block; }}
  .score-high {{ background: #c8e6c9; color: #2e7d32; }}
  .score-medium {{ background: #fff9c4; color: #f57f17; }}
  .score-low {{ background: #ffcdd2; color: #c62828; }}
  .score-col {{ width: 60px; }}
</style>
</head>
<body>
<div class="header">
  <h1>Repo Compliance Engine — Evaluation Report</h1>
  <div class="summary-stats">
    <div class="stat-box"><div>Total Test Cases</div><div class="stat-value">{total}</div></div>
    <div class="stat-box"><div>Average Score</div><div class="stat-value">{avg:.1f} / 10</div></div>
    <div class="stat-box"><div>Pass Rate (≥7)</div><div class="stat-value">{pass_rate:.1f}%</div></div>
  </div>
</div>
<table>
  <thead>
    <tr>
      <th>Scenario</th><th>Task</th><th>Expected</th>
      <th>Engine Output</th><th>Score</th><th>Reasoning</th>
    </tr>
  </thead>
  <tbody>{rows}</tbody>
</table>
</body>
</html>"""


def run_evaluation(
    run_prompt_fn,
    dataset_file: str = None,
    json_output_file: str = None,
    html_output_file: str = None,
) -> list[dict]:
    if dataset_file is None:
        dataset_file = str(_DIR / "dataset.json")
    if json_output_file is None:
        json_output_file = str(_DIR / "output.json")
    if html_output_file is None:
        html_output_file = str(_DIR / "output.html")

    with open(dataset_file) as f:
        dataset = json.load(f)

    results = []
    total = len(dataset)
    for i, tc in enumerate(dataset, start=1):
        try:
            result = run_test_case(tc, run_prompt_fn)
        except Exception as e:
            print(f"[{i}/{total}] ERROR — {tc.get('scenario_label', '?')}: {e}")
            continue
        results.append(result)
        print(f"[{i}/{total}] score={result['score']} — {tc.get('scenario_label', '?')}")

    avg = mean([r["score"] for r in results]) if results else 0
    print(f"\nAverage score: {avg:.1f} / 10")

    with open(json_output_file, "w") as f:
        json.dump(results, f, indent=2)

    with open(html_output_file, "w", encoding="utf-8") as f:
        f.write(_generate_html_report(results))

    print(f"Results → {json_output_file}  |  Report → {html_output_file}")
    return results
