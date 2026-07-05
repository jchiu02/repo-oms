import io
import zipfile
import urllib.request
from datetime import date, timedelta
from dateutil.relativedelta import relativedelta


def coupon_dates(maturity: date, freq: int, start: date) -> list[date]:
    """Generate all coupon dates from start up to and including maturity."""
    months_per_period = 12 // freq
    dates = []
    d = maturity
    while d > start:
        dates.append(d)
        d -= relativedelta(months=months_per_period)
    dates.reverse()
    return dates


def prev_coupon_date(maturity: date, freq: int, settle: date) -> date:
    months_per_period = 12 // freq
    d = maturity
    while d >= settle:
        d -= relativedelta(months=months_per_period)
    return d


def next_coupon_date(maturity: date, freq: int, settle: date) -> date:
    months_per_period = 12 // freq
    d = maturity
    while d > settle:
        prev = d - relativedelta(months=months_per_period)
        if prev < settle:
            return d
        d = prev
    return maturity


def day_count_fraction(d1: date, d2: date, convention: str, period_start: date, period_end: date) -> float:
    if convention == "ACT/ACT":
        return (d2 - d1).days / (period_end - period_start).days
    elif convention == "30/360":
        y1, m1, day1 = d1.year, d1.month, min(d1.day, 30)
        y2, m2, day2 = d2.year, d2.month, d2.day
        if day1 == 30 and day2 == 31:
            day2 = 30
        numerator = 360 * (y2 - y1) + 30 * (m2 - m1) + (day2 - day1)
        return numerator / (360 / 2)
    return (d2 - d1).days / 365.0


def calc_accrued_interest(
    coupon_rate: float, freq: int, maturity: date,
    settle: date, convention: str,
) -> float:
    if settle >= maturity:
        return 0.0
    prev_cpn = prev_coupon_date(maturity, freq, settle)
    next_cpn = next_coupon_date(maturity, freq, settle)
    if prev_cpn >= next_cpn:
        return 0.0
    coupon_payment = coupon_rate / freq * 100
    frac = day_count_fraction(prev_cpn, settle, convention, prev_cpn, next_cpn)
    return coupon_payment * frac


def calc_clean_price(
    coupon_rate: float, maturity: date, yield_rate: float,
    freq: int, settle: date,
) -> float:
    future_coupons = coupon_dates(maturity, freq, settle)
    if not future_coupons:
        return 100.0

    coupon_payment = coupon_rate / freq * 100
    prev_cpn = prev_coupon_date(maturity, freq, settle)
    next_cpn = future_coupons[0]
    period_days = (next_cpn - prev_cpn).days
    accrued_days = (settle - prev_cpn).days
    frac_into_period = accrued_days / period_days if period_days > 0 else 0

    pv = 0.0
    discount_rate = 1 + yield_rate / freq
    for i, cpn_date in enumerate(future_coupons):
        n = i + 1 - frac_into_period
        pv += coupon_payment / (discount_rate ** n)

    n_mat = len(future_coupons) - frac_into_period
    pv += 100.0 / (discount_rate ** n_mat)

    return pv


def price_bond(
    coupon_rate: float, maturity: date, yield_rate: float,
    freq: int, convention: str, settle: date = None,
) -> dict:
    if settle is None:
        settle = date.today()

    if settle >= maturity:
        return {
            "clean_price": 100.0,
            "accrued_interest": 0.0,
            "dirty_price": 100.0,
            "settle_date": settle.isoformat(),
        }

    clean = calc_clean_price(coupon_rate, maturity, yield_rate, freq, settle)
    accrued = calc_accrued_interest(coupon_rate, freq, maturity, settle, convention)
    dirty = clean + accrued

    return {
        "clean_price": round(clean, 4),
        "accrued_interest": round(accrued, 4),
        "dirty_price": round(dirty, 4),
        "settle_date": settle.isoformat(),
    }


BOE_YIELD_CURVE_URL = (
    "https://www.bankofengland.co.uk/-/media/boe/files/"
    "statistics/yield-curves/latest-yield-curve-data.zip"
)


def fetch_boe_yield_curve() -> dict[float, float] | None:
    try:
        req = urllib.request.Request(BOE_YIELD_CURVE_URL, headers={"User-Agent": "Mozilla/5.0"})
        resp = urllib.request.urlopen(req, timeout=30)
        data = resp.read()
    except Exception:
        return None

    try:
        import openpyxl
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            content = zf.read("GLC Nominal daily data current month.xlsx")
            wb = openpyxl.load_workbook(io.BytesIO(content), read_only=True)
            ws = wb["4. spot curve"]
            rows = list(ws.iter_rows(values_only=True))
            wb.close()

        tenors = rows[3]
        last_data = None
        for row in reversed(rows[4:]):
            if row[1] is not None:
                last_data = row
                break

        if last_data is None:
            return None

        curve = {}
        for i in range(1, len(tenors)):
            if tenors[i] is not None and last_data[i] is not None:
                tenor = float(tenors[i])
                yield_pct = float(last_data[i])
                curve[tenor] = yield_pct / 100
        return curve
    except Exception:
        return None


def interpolate_yield(curve: dict[float, float], years: float) -> float:
    tenors = sorted(curve.keys())
    if years <= tenors[0]:
        return curve[tenors[0]]
    if years >= tenors[-1]:
        return curve[tenors[-1]]
    for i in range(len(tenors) - 1):
        if tenors[i] <= years <= tenors[i + 1]:
            t0, t1 = tenors[i], tenors[i + 1]
            w = (years - t0) / (t1 - t0)
            return curve[t0] * (1 - w) + curve[t1] * w
    return curve[tenors[-1]]


def get_yield_for_bond(
    maturity: date, settle: date, curve: dict[float, float],
    credit_spread: float = 0.0,
) -> float:
    years = (maturity - settle).days / 365.25
    if years <= 0:
        return 0.0
    base_yield = interpolate_yield(curve, years)
    return base_yield + credit_spread


if __name__ == "__main__":
    bonds = [
        ("UKT 4.5% 2028",   0.045,   date(2028, 12, 7), 0.041, 2, "ACT/ACT"),
        ("UKT 1.0% 2032",   0.01,    date(2032, 1, 31), 0.043, 2, "ACT/ACT"),
        ("UKT 4.25% 2034",  0.0425,  date(2034, 6, 7),  0.042, 2, "ACT/ACT"),
        ("Meta 4.45% 2029",  0.0445,  date(2029, 8, 15), 0.051, 2, "30/360"),
        ("CRWV 3.0% 2029",   0.03,    date(2029, 2, 15), 0.058, 2, "30/360"),
    ]
    for name, cpn, mat, yld, freq, conv in bonds:
        result = price_bond(cpn, mat, yld, freq, conv)
        print(f"{name:20s}  clean={result['clean_price']:8.4f}  "
              f"accrued={result['accrued_interest']:7.4f}  "
              f"dirty={result['dirty_price']:8.4f}")
