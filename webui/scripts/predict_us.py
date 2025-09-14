# save as scripts/predict_us.py  (run from repo root)
from pathlib import Path
import sys
sys.path.append(str(Path(__file__).resolve().parents[2]))  # repo root

import pandas as pd
from model import Kronos, KronosTokenizer, KronosPredictor
import torch

# 1) Load model+tokenizer from HF Hub (names from the README “Model Zoo”)
device = "mps" if torch.backends.mps.is_available() else "cpu"
tok = KronosTokenizer.from_pretrained("NeoQuasar/Kronos-Tokenizer-base")
mdl = Kronos.from_pretrained("NeoQuasar/Kronos-small").to(device)
pred = KronosPredictor(mdl, tok, device=device, max_context=512)

# 2) Load your U.S. data
df = pd.read_csv("data/US_5min_AAPL.csv", parse_dates=["timestamps"])

lookback = 400         # last 400 bars as context
pred_len = 60          # predict next 60 bars (~5 hours of 5m bars)

x_df        = df.loc[:lookback-1, ["open","high","low","close","volume","amount"]]
x_timestamp = df.loc[:lookback-1, "timestamps"]
y_timestamp = df.loc[lookback:lookback+pred_len-1, "timestamps"]

# 3) Forecast
pred_df = pred.predict(
    df=x_df,
    x_timestamp=x_timestamp,
    y_timestamp=y_timestamp,
    pred_len=pred_len,
    T=1.0, top_p=0.9, sample_count=1
)
print(pred_df.head())
