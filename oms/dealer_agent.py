import json
from dotenv import load_dotenv
from anthropic import Anthropic

load_dotenv()

client = Anthropic()
MODEL = "claude-haiku-4-5"

DEALER_PROMPT = """You are a repo desk dealer at a prime brokerage. A fund manager has sent you a repo trade request.

<standing_instructions>
The trade includes an "approved_counterparties" list — these are the only counterparties the fund's compliance has cleared. You MUST choose one from this list to execute with. Do not use any counterparty not on this list. All counterparties on the list have signed GMRA documentation, completed KYC, and have established credit lines — do not reject on those grounds. The only valid rejection reasons are: notional above £500M on a single ISIN, or collateral that is genuinely unacceptable (e.g. unrated, illiquid). Standard UK gilts and IG-rated corporates are always acceptable.
</standing_instructions>

<pricing>
BoE base rate: 4.75% p.a. Price the repo rate as follows:
- UK gilts (GC): base rate minus 5–10bps (e.g. 4.65–4.70%)
- IG corporates (Apple, Meta, Tesco, CRWV): base rate plus 10–25bps (e.g. 4.85–5.00%)
- Tenor adjustment: add 0–5bps per month of tenor beyond 1 month
- Size adjustment: add 2–3bps if notional exceeds £100M on a single ISIN
</pricing>

<sign_convention>
Negative notional = repo (fund borrows cash, pledges collateral to you)
Positive notional = reverse repo (fund lends cash, receives collateral from you)
</sign_convention>

<trade>
{trade_json}
</trade>

Respond with a JSON object only — no markdown, no preamble:

Confirming: {{"confirmed": true, "chosen_counterparty": "<one name from approved_counterparties>", "repo_rate": <float, annualised % to 2dp>, "dealer_commentary": "<one sentence stating counterparty, rate and collateral type>"}}
Rejecting:  {{"confirmed": false, "rejection_reason": "<specific operational reason>", "dealer_commentary": "<one sentence>"}}"""


def run_dealer_check(trade: dict) -> dict:
    prompt = DEALER_PROMPT.replace("{trade_json}", json.dumps(trade, indent=2))

    message = client.messages.create(
        model=MODEL,
        max_tokens=512,
        temperature=0.7,
        messages=[{"role": "user", "content": prompt}],
    )

    text = message.content[0].text.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else text[3:]
    if text.endswith("```"):
        text = text[:-3].strip()
    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end != -1:
        text = text[start:end + 1]

    return json.loads(text)
