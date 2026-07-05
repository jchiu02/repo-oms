import os
from pathlib import Path
from statistics import mean

from dataset import generate_dataset
from compliance_prompt import run_compliance_check_from_inputs
from evaluator import run_evaluation

_DIR = Path(__file__).parent
DATASET_FILE = str(_DIR / "dataset.json")
JSON_OUTPUT = str(_DIR / "output.json")
HTML_OUTPUT = str(_DIR / "output.html")


def main():
    # Step 1: Generate dataset (skip if already exists)
    if os.path.exists(DATASET_FILE):
        print(f"Dataset already exists at {DATASET_FILE} — skipping generation.")
        print("Delete dataset.json to regenerate.\n")
    else:
        print("=== Step 1: Generating dataset ===")
        generate_dataset(output_file=DATASET_FILE)
        print()

    # Steps 2 & 3: Run compliance engine on each test case and grade
    print("=== Steps 2 & 3: Running compliance checks and grading ===")
    results = run_evaluation(
        run_prompt_fn=run_compliance_check_from_inputs,
        dataset_file=DATASET_FILE,
        json_output_file=JSON_OUTPUT,
        html_output_file=HTML_OUTPUT,
    )

    avg = mean([r["score"] for r in results]) if results else 0
    print(f"\nDone. Average score: {avg:.1f} / 10")
    print(f"Open {HTML_OUTPUT} to view the full report.")


if __name__ == "__main__":
    main()
