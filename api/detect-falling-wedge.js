// File: api/detect-falling-wedge.js
import axios from 'axios';

// --- Helper Functions (Sama seperti sebelumnya, pastikan sudah benar) ---
function findLocalLows(data, order) {
  const lowsIndices = [];
  if (data.length < (2 * order + 1)) {
    // console.warn(`[findLocalLowsFW] Not enough data (${data.length}) to find lows with order ${order}`);
    return lowsIndices;
  }
  for (let i = order; i < data.length - order; i++) {
    let isLow = true;
    for (let j = 1; j <= order; j++) {
      if (data[i] > data[i - j] || data[i] > data[i + j]) { isLow = false; break; }
    }
    if (isLow) {
        const lastAddedLowIdx = lowsIndices.length > 0 ? lowsIndices[lowsIndices.length-1] : -1;
        if (!lowsIndices.includes(i) && !(lastAddedLowIdx === i-1 && data[i] === data[lastAddedLowIdx]) ) {
            lowsIndices.push(i);
        }
    }
  }
  return lowsIndices;
}

function findLocalHighs(data, order) {
  const highsIndices = [];
  if (data.length < (2 * order + 1)) {
    // console.warn(`[findLocalHighsFW] Not enough data (${data.length}) to find highs with order ${order}`);
    return highsIndices;
  }
  for (let i = order; i < data.length - order; i++) {
    let isHigh = true;
    for (let j = 1; j <= order; j++) {
      if (data[i] < data[i - j] || data[i] < data[i + j]) { isHigh = false; break; }
    }
    if (isHigh) {
        const lastAddedHighIdx = highsIndices.length > 0 ? highsIndices[highsIndices.length-1] : -1;
        if (!highsIndices.includes(i) && !(lastAddedHighIdx === i-1 && data[i] === data[lastAddedHighIdx]) ) {
            highsIndices.push(i);
        }
    }
  }
  return highsIndices;
}

function simpleLinearRegression(x, y) {
  const n = x.length;
  if (n < 2 || n !== y.length) return null; // Membutuhkan minimal 2 poin

  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (let i = 0; i < n; i++) {
    sumX += x[i];
    sumY += y[i];
    sumXY += x[i] * y[i];
    sumXX += x[i] * x[i];
  }
  const denominator = n * sumXX - sumX * sumX;
  if (Math.abs(denominator) < 1e-9) return null; // Hindari pembagian dengan nol atau denominator sangat kecil

  const slope = (n * sumXY - sumX * sumY) / denominator;
  const intercept = (sumY - slope * sumX) / n;
  return { slope, intercept };
}
// --- End Helper Functions ---

export default async function handler(request, response) {
  const { symbol } = request.query;
  if (!symbol) return response.status(400).json({ message: 'Parameter "symbol" diperlukan.' });

  // --- Parameter Tuning untuk Falling Wedge ---
  const ORDER_EXTREMA_FW = 5;
  const CANDLES_LIMIT_FW = 300;
  const MIN_TOUCHES = 2; 
  const MAX_SLOPE = -0.00001; // Kedua slope harus negatif (atau sedikit negatif)
  const MIN_PATTERN_DURATION_FW = 30;
  const MAX_PATTERN_DURATION_FW = 150;
  const CANDLES_TO_CHECK_BREAKOUT_FW = 15;
  const BREAKOUT_BUFFER_PERCENT_FW = 0.001; 
  const VOLUME_LOOKBACK_FW = 30;
  const VOLUME_MULTIPLIER_FW = 1.5; 
  const TOUCH_TOLERANCE_PERCENT = 0.005;
  // --- BARU: Parameter Kesegaran Breakout ---
  const MAX_CANDLES_AGO_FOR_FRESH_BREAKOUT = 3; // Breakout harus dalam 3 candle terakhir
  // --- End of Parameter Tuning ---

  try {
    console.log(`[detect-fw] Fetching ${CANDLES_LIMIT_FW} candles for ${symbol}...`);
    const protocol = request.headers['x-forwarded-proto'] || 'http';
    const host = request.headers.host;
    const candleApiUrl = `${protocol}://${host}/api/get-candles`;
    const candlesResponse = await axios.get(candleApiUrl, { params: { symbol: symbol.toUpperCase(), granularity: '1h', limit: CANDLES_LIMIT_FW }, headers: { 'Accept': 'application/json' }});

    if (!candlesResponse.data || !candlesResponse.data.data || candlesResponse.data.data.length < MIN_PATTERN_DURATION_FW + ORDER_EXTREMA_FW) { // Pastikan cukup data
      return response.status(500).json({ message: `Gagal mengambil data candlestick atau data tidak cukup (${candlesResponse.data?.data?.length || 0} candles) untuk ${symbol}.` });
    }
    const candles = candlesResponse.data.data;
    console.log(`[detect-fw] Berhasil mengambil ${candles.length} candles.`);
    const lowPrices = candles.map(c => c.low);
    const highPrices = candles.map(c => c.high);

    const localLowsIdx = findLocalLows(lowPrices, ORDER_EXTREMA_FW);
    const localHighsIdx = findLocalHighs(highPrices, ORDER_EXTREMA_FW);
    // console.log(`[detect-fw] Ditemukan ${localLowsIdx.length} lows & ${localHighsIdx.length} highs.`);

    const potentialPatterns = [];
    // Menggunakan pendekatan sliding window untuk mencari wedge
    const minWindowSize = MIN_PATTERN_DURATION_FW;
    const maxWindowSize = Math.min(MAX_PATTERN_DURATION_FW, candles.length);

    for (let windowSize = minWindowSize; windowSize <= maxWindowSize; windowSize++) {
        for (let i = 0; i <= candles.length - windowSize; i++) {
            const currentWindowCandles = candles.slice(i, i + windowSize);
            const currentWindowLows = currentWindowCandles.map(c => c.low);
            const currentWindowHighs = currentWindowCandles.map(c => c.high);
            const absoluteIndicesInWindow = Array.from({length: windowSize}, (_, k) => i + k);

            const windowPivotalLowsAbs = findLocalLows(currentWindowLows, ORDER_EXTREMA_FW).map(idx => i + idx);
            const windowPivotalHighsAbs = findLocalHighs(currentWindowHighs, ORDER_EXTREMA_FW).map(idx => i + idx);

            if (windowPivotalLowsAbs.length >= MIN_TOUCHES && windowPivotalHighsAbs.length >= MIN_TOUCHES) {
                const supX = windowPivotalLowsAbs;
                const supY = windowPivotalLowsAbs.map(idx => candles[idx].low);
                const resX = windowPivotalHighsAbs;
                const resY = windowPivotalHighsAbs.map(idx => candles[idx].high);

                const supLine = simpleLinearRegression(supX, supY);
                const resLine = simpleLinearRegression(resX, resY);

                if (supLine && resLine && 
                    supLine.slope < MAX_SLOPE && 
                    resLine.slope < MAX_SLOPE && 
                    Math.abs(resLine.slope) > Math.abs(supLine.slope) // Resistance lebih curam
                   ) {
                    
                    // Cek konvergensi
                    const resStartVal = resLine.slope * i + resLine.intercept;
                    const supStartVal = supLine.slope * i + supLine.intercept;
                    const resEndVal = resLine.slope * (i + windowSize -1) + resLine.intercept;
                    const supEndVal = supLine.slope * (i + windowSize -1) + supLine.intercept;

                    const startDiff = resStartVal - supStartVal;
                    const endDiff = resEndVal - supEndVal;

                    if (startDiff > 0 && endDiff > 0 && startDiff > endDiff * 1.1) { // Pastikan benar-benar menyempit
                        let supportTouches = 0;
                        windowPivotalLowsAbs.forEach(idx => {
                            const lineVal = supLine.slope * idx + supLine.intercept;
                            if (Math.abs(candles[idx].low - lineVal) / lineVal <= TOUCH_TOLERANCE_PERCENT) supportTouches++;
                        });
                        let resistanceTouches = 0;
                        windowPivotalHighsAbs.forEach(idx => {
                            const lineVal = resLine.slope * idx + resLine.intercept;
                            if (Math.abs(candles[idx].high - lineVal) / lineVal <= TOUCH_TOLERANCE_PERCENT) resistanceTouches++;
                        });

                        if (supportTouches >= MIN_TOUCHES && resistanceTouches >= MIN_TOUCHES) {
                            const patternEndIdx = i + windowSize - 1;
                            const existing = potentialPatterns.find(p => p.patternEndIndex === patternEndIdx && Math.abs(p.resistanceLine.slope - resLine.slope) < 0.0001);
                            if (!existing) {
                                potentialPatterns.push({
                                    symbol: symbol.toUpperCase(),
                                    supportLine: supLine,
                                    supportPoints: windowPivotalLowsAbs.map(idx => ({index: idx, value: candles[idx].low, timestamp: candles[idx].timestamp})),
                                    resistanceLine: resLine,
                                    resistancePoints: windowPivotalHighsAbs.map(idx => ({index: idx, value: candles[idx].high, timestamp: candles[idx].timestamp})),
                                    patternStartIndex: i,
                                    patternEndIndex: patternEndIdx,
                                    patternEndTimestamp: candles[patternEndIdx]?.timestamp || Date.now()
                                });
                                // console.log(`[detect-fw] Potential FW: start ${i}, end ${patternEndIdx}`);
                            }
                        }
                    }
                }
            }
        }
    }
    
    const confirmedPatterns = [];
    const currentCandleIndex = candles.length - 1;

    for (const pattern of potentialPatterns) {
      const resLine = pattern.resistanceLine;
      const lastPatternIndex = pattern.patternEndIndex;

      let breakoutCandle = null;
      for (let k = lastPatternIndex + 1; k < candles.length && k <= lastPatternIndex + CANDLES_TO_CHECK_BREAKOUT_FW; k++) {
        const currentCandle = candles[k];
        const resistanceLineValueAtK = resLine.slope * k + resLine.intercept;
        if (currentCandle.close > resistanceLineValueAtK) {
            const buffer = resistanceLineValueAtK * BREAKOUT_BUFFER_PERCENT_FW;
            if (currentCandle.close > resistanceLineValueAtK + buffer) {
              breakoutCandle = {
                timestamp: currentCandle.timestamp,
                closePrice: currentCandle.close,
                resistanceLineValue: resistanceLineValueAtK,
                index: k,
                volume: currentCandle.volume
              };
              break;
            }
        }
      }

      if (breakoutCandle) {
        // --- BARU: Cek Kesegaran Breakout ---
        const candlesAgo = currentCandleIndex - breakoutCandle.index;
        if (candlesAgo < 0 || candlesAgo >= MAX_CANDLES_AGO_FOR_FRESH_BREAKOUT) {
            console.log(`[detect-fw] FW for ${symbol} - Breakout at index ${breakoutCandle.index} is NOT FRESH (${candlesAgo} candles ago). Max allowed: ${MAX_CANDLES_AGO_FOR_FRESH_BREAKOUT-1}. Skipping.`);
            continue; 
        }
        console.log(`[detect-fw] FW for ${symbol} - Breakout at index ${breakoutCandle.index} IS FRESH (${candlesAgo} candles ago).`);
        // --- AKHIR PENGECEKAN KESEGARAN ---

        const startVolumeIdx = Math.max(0, breakoutCandle.index - VOLUME_LOOKBACK_FW);
        const volumesBeforeBreakout = candles.slice(startVolumeIdx, breakoutCandle.index).map(c => c.volume);
        const avgVolume = volumesBeforeBreakout.length > 0 ? volumesBeforeBreakout.reduce((sum, vol) => sum + vol, 0) / volumesBeforeBreakout.length : 0;
        const isVolumeConfirmed = avgVolume > 0 && breakoutCandle.volume > avgVolume * VOLUME_MULTIPLIER_FW;

        const resStartVal = resLine.slope * pattern.patternStartIndex + resLine.intercept;
        const supStartVal = pattern.supportLine.slope * pattern.patternStartIndex + pattern.supportLine.intercept;
        const patternHeight = resStartVal - supStartVal;
        let targetPrice = null;
        if (patternHeight > 0) {
            targetPrice = breakoutCandle.closePrice + patternHeight;
        }
        
        confirmedPatterns.push({
          ...pattern,
          breakoutConfirmation: { ...breakoutCandle, volumeConfirmed, avgVolumeBefore: avgVolume },
          projection: { patternHeight: patternHeight > 0 ? patternHeight : null, targetPrice },
          status: `Falling Wedge Confirmed FRESH Breakout (Vol: ${isVolumeConfirmed ? 'Yes' : 'No'})`
        });
      }
    }

    const parametersUsed = {
        order_extrema: ORDER_EXTREMA_FW, candles_limit: CANDLES_LIMIT_FW, min_touches: MIN_TOUCHES,
        max_slope: MAX_SLOPE, min_pattern_duration: MIN_PATTERN_DURATION_FW, max_pattern_duration: MAX_PATTERN_DURATION_FW,
        candles_to_check_breakout: CANDLES_TO_CHECK_BREAKOUT_FW, breakout_buffer_percent: BREAKOUT_BUFFER_PERCENT_FW,
        volume_lookback: VOLUME_LOOKBACK_FW, volume_multiplier: VOLUME_MULTIPLIER_FW, touch_tolerance_percent: TOUCH_TOLERANCE_PERCENT,
        max_candles_ago_for_fresh_breakout: MAX_CANDLES_AGO_FOR_FRESH_BREAKOUT // BARU
    };

    if (confirmedPatterns.length > 0) {
      response.status(200).json({
        message: `Ditemukan ${confirmedPatterns.length} Pola Falling Wedge TERKONFIRMASI (SEGAR) untuk ${symbol.toUpperCase()}.`,
        patterns: confirmedPatterns,
        parameters_used: parametersUsed,
      });
    } else {
      response.status(200).json({
        message: `Tidak ada Pola Falling Wedge TERKONFIRMASI (SEGAR) yang terdeteksi untuk ${symbol.toUpperCase()} dari ${potentialPatterns.length} potensi formasi.`,
        potentialFormationsCount: potentialPatterns.length,
        parameters_used: parametersUsed,
      });
    }

  } catch (error) {
    console.error(`[detect-fw] Critical Error for ${symbol}:`, error.message, error.stack);
    response.status(500).json({ message: `Kesalahan internal saat mendeteksi pola Falling Wedge untuk ${symbol}.`, error: error.message });
  }
}