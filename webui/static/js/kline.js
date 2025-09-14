// webui/static/js/kline.js
(function () {
  let chart, candleSeries, predLineSeries, volumeSeries, resizeObs;
  let predVisible = true; // persists across re-renders

  // --- time helpers ----------------------------------------------------------
  function toUnixSecondsUTC(s) {
    if (s == null) return undefined;
    if (typeof s === 'number') return Math.floor(String(s).length > 10 ? s / 1000 : s);
    let t = String(s).trim();
    // Treat naive "YYYY-MM-DD HH:MM[:SS]" as UTC
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(t) && !/[zZ]|[+\-]\d{2}:\d{2}$/.test(t)) {
      t = t.replace(' ', 'T') + 'Z';
    }
    const ms = Date.parse(t);
    return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000);
  }

  function mapOHLC(arr) {
    return (arr || []).map(r => ({
      time: toUnixSecondsUTC(r.time ?? r.timestamp ?? r.timestamps),
      open: +r.open, high: +r.high, low: +r.low, close: +r.close,
      volume: r.volume != null ? +r.volume : undefined
    })).filter(p => Number.isFinite(p.time));
  }

  function mapCloseLine(arr) {
    return (arr || []).map(r => ({
      time: toUnixSecondsUTC(r.time ?? r.timestamp ?? r.timestamps),
      value: +r.close
    })).filter(p => Number.isFinite(p.time));
  }

  // Infer the most common bar interval (seconds) from a sorted time array
  function inferIntervalSec(sortedTimes) {
    if (!sortedTimes || sortedTimes.length < 3) return 300;
    const counts = new Map();
    for (let i = 1; i < sortedTimes.length; i++) {
      const d = sortedTimes[i] - sortedTimes[i - 1];
      if (d <= 0 || d > 24 * 3600) continue; // ignore gaps > 1 day
      counts.set(d, (counts.get(d) || 0) + 1);
    }
    let best = 300, bestN = -1;
    for (const [d, n] of counts) if (n > bestN) { best = d; bestN = n; }
    return best || 300;
  }

    // Snap each line point to nearest candle time when close; otherwise keep original time.
    // This guarantees we never drop prediction points (e.g., after-hours).
    function snapLineToTimes(line, sortedTimes, intervalSec) {
    if (!line || !line.length) return [];
    if (!sortedTimes || !sortedTimes.length) return line.slice(); // nothing to snap to

    const half = intervalSec / 2;
    const snapped = [];

    for (const p of line) {
        const t = p.time;

        // binary search for nearest index >= t
        let lo = 0, hi = sortedTimes.length - 1, idx = 0;
        while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (sortedTimes[mid] < t) { lo = mid + 1; idx = lo; }
        else { hi = mid - 1; idx = mid; }
        }

        // choose nearest neighbor among idx and idx-1
        let bestT = sortedTimes[Math.max(0, Math.min(idx, sortedTimes.length - 1))];
        if (idx > 0) {
        const leftT = sortedTimes[idx - 1];
        if (Math.abs(leftT - t) < Math.abs(bestT - t)) bestT = leftT;
        }

        if (Math.abs(bestT - t) <= half) {
        // close enough to a candle → snap to it
        snapped.push({ time: bestT, value: p.value });
        } else {
        // too far from any candle → keep original time (DON'T DROP)
        snapped.push({ time: t, value: p.value });
        }
    }

    // dedupe by time (keep last), then sort
    const byTime = new Map();
    for (const r of snapped) byTime.set(r.time, r);
    return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
    }

  // Merge two OHLC arrays by time, preferring the latter on collisions
  function mergeCandles(a, b) {
    const m = new Map();
    for (const r of (a || [])) m.set(r.time, r);
    for (const r of (b || [])) m.set(r.time, r); // overwrite with b (actual)
    return Array.from(m.values()).sort((x, y) => x.time - y.time);
  }

  // ----------------------------------------------------------------------------
  function ensureChart(container) {
    if (chart) {
      if (resizeObs) resizeObs.disconnect();
      chart.remove();
    }
    chart = LightweightCharts.createChart(container, {
      width: container.clientWidth,
      height: container.clientHeight,
      layout: { background: { type: 'solid', color: '#0b1020' }, textColor: '#d1d5db' },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
      grid: {
        vertLines: { color: 'rgba(255,255,255,0.06)' },
        horzLines: { color: 'rgba(255,255,255,0.06)' }
      },
      crosshair: { mode: 1 }
    });

    candleSeries = chart.addCandlestickSeries({
      upColor: '#10b981', downColor: '#ef4444',
      wickUpColor: '#10b981', wickDownColor: '#ef4444', borderVisible: false
    });

    predLineSeries = chart.addLineSeries({
      color: '#f59e0b', lineWidth: 2,
      priceLineVisible: false, lastValueVisible: true, visible: predVisible
    });

    volumeSeries = chart.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: '' });
    volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.72, bottom: 0 } });
    candleSeries.priceScale().applyOptions({ scaleMargins: { top: 0.10, bottom: 0.28 } });

    resizeObs = new ResizeObserver(() => {
      chart.applyOptions({ width: container.clientWidth, height: container.clientHeight });
    });
    resizeObs.observe(container);
  }

// Align predicted close line to the actual candle times by index.
// Guarantees 1:1 overlay on the forecast window.
function alignPredToActualTimes(predLine, actualCandles) {
  if (!predLine || !predLine.length || !actualCandles || !actualCandles.length) return [];
  const actTimes = actualCandles.map(r => r.time).sort((a, b) => a - b);
  const n = Math.min(predLine.length, actTimes.length);
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = { time: actTimes[i], value: predLine[i].value };
  }
  return out;
}


  // Public render API: draw full candles (history+actual) + orange prediction line
  window.renderKlineChart = function ({ history, actual, pred, markForecastStart = true } = {}, mountId = 'kline-container') {
    const container = document.getElementById(mountId);
    if (!container) return console.warn('[kline] container not found:', mountId);

    const histC = mapOHLC(history);
    const actC  = mapOHLC(actual);
    const fullC = mergeCandles(histC, actC);
    const predL = mapCloseLine(pred);

  // Prefer strict alignment to actual candles (perfect overlay). If actual is missing,
  // fall back to snap-to-nearest behavior so we still draw something sensible.
    let predAligned = [];
    if (actC.length) {
        predAligned = alignPredToActualTimes(predL, actC);
    } else {
        const times = fullC.map(r => r.time).sort((a, b) => a - b);
        const intervalSec = inferIntervalSec(times);
        predAligned = snapLineToTimes(predL, times, intervalSec);
    }

    console.debug('[kline] sizes:', { history: histC.length, actual: actC.length, merged: fullC.length, pred: predL.length, aligned: predAligned.length });

    ensureChart(container);

    if (fullC.length) candleSeries.setData(fullC);
    if (fullC.length && fullC[0].volume !== undefined) {
      // colorized volume bars using candle polarity
      const vols = fullC.map(r => ({
        time: r.time,
        value: Math.max(0, r.volume || 0),
        color: r.close >= r.open ? 'rgba(16,185,129,0.45)' : 'rgba(239,68,68,0.45)'
      }));
      volumeSeries.setData(vols);
    } else {
      volumeSeries.setData([]);
    }

    predLineSeries.setData(predAligned);
    predLineSeries.applyOptions({ visible: predVisible });

    if (markForecastStart && predAligned.length) {
        candleSeries.setMarkers([{ time: predAligned[0].time, position: 'aboveBar', color: '#a78bfa', shape: 'arrowDown', text: 'Forecast start' }]);
    }
    chart.timeScale().fitContent();
  };

  // Toggle API (only the orange line)
  window.klineAPI = {
    togglePred() {
      predVisible = !predVisible;
      if (predLineSeries) predLineSeries.applyOptions({ visible: predVisible });
      return predVisible;
    },
    setPredVisible(v) {
      predVisible = !!v;
      if (predLineSeries) predLineSeries.applyOptions({ visible: predVisible });
      return predVisible;
    },
    isPredVisible() { return predVisible; }
  };
})();
