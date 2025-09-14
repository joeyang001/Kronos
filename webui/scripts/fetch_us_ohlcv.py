# save as scripts/fetch_us_ohlcv.py (run from repo root)
import pandas as pd, yfinance as yf
from zoneinfo import ZoneInfo

ticker = "AAPL"
# 5-min bars for ~60 days (Yahoo limit for 5m)
df = yf.Ticker(ticker).history(period="60d", interval="5m", auto_adjust=False)

# Keep regular trading hours (US/Eastern 09:30–16:00)
df = df.tz_convert(ZoneInfo("America/New_York"))
df = df.between_time("09:30", "16:00")

# Rename to Kronos schema
df = df.rename(columns={"Open":"open","High":"high","Low":"low","Close":"close","Volume":"volume"})
df["amount"] = 0.0  # optional, Kronos accepts missing/zeros
df["timestamps"] = df.index.tz_convert("UTC")  # consistent tz
df = df.reset_index(drop=True)

# Save a CSV anywhere you like
out = "data/US_5min_AAPL.csv"
df[["timestamps","open","high","low","close","volume","amount"]].to_csv(out, index=False)
print("Saved:", out, len(df), "rows")
