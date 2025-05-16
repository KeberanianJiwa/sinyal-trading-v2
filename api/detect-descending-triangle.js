// File: api/detect-descending-triangle.js
import axios from 'axios';

// --- Helper Functions ---

function findLocalLows(data, order) {
  const lowsIndices = [];
  if (data.length < (2 * order + 1)) return lowsIndices;
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
    if (data.length < (2 * order + 1)) return highsIndices;
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
  if (n < 2 || n !== y.length) return null; // Perlu minimal 2 poin untuk regresi

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

// --- Main Handler ---
export default async function handler(request, response) {
  const { symbol } = request.query;

  if (!symbol) {
    return response.status(400).json({ message: 'Parameter "symbol" diperlukan.' });
  }

  // --- Parameter Tuning untuk Descending Triangle ---
  const ORDER_EXTREMA_DT = 5;
  const CANDLES_LIMIT_DT = 300;
  const SUPPORT_LEVEL_TOLERANCE = 0.01;
  const MIN_LOWS_FOR_SUPPORT = 2;
  const MIN_HIGHS_FOR_RESISTANCE = 2;
  const MAX_RESISTANCE_SLOPE = -0.00001; // Pastikan slope benar-benar menurun
  const MIN_PATTERN_DURATION = 20;
  const CANDLES_TO_CHECK_BREAKDOWN_DT = 15;
  const BREAKDOWN_BUFFER_PERCENT_DT = 0.001;
  const VOLUME_LOOKBACK_DT = 30;
  const VOLUME_MULTIPLIER_DT = 1.3;
  // --- BARU: Parameter Kesegaran Breakdown ---
  const MAX_CANDLES_AGO_FOR_FRESH_BREAKDOWN = 3; // Breakdown harus dalam 3 candle terakhir
  // --- End of Parameter Tuning ---

  let localLowsIdx = [];
  let localHighsIdx = [];
  let potentialPatterns = [];

  try {
    console.log(`[detect-dt] Fetching ${CANDLES_LIMIT_DT} candles for ${symbol}...`);
    const protocol = request.headers['x-forwarded-proto'] || 'http';
    const host = request.headers.host;
    const candleApiUrl = `${protocol}://${host}/api/get-candles`;

    const candlesResponse = await axios.get(candleApiUrl, {
      params: { symbol: symbol.toUpperCase(), granularity: '1h', limit: CANDLES_LIMIT_DT },
      headers: { 'Accept': 'application/json' }
    });

    if (!candlesResponse.data || !candlesResponse.data.data || candlesResponse.data.data.length < MIN_PATTERN_DURATION + ORDER_EXTREMA_DT) {
      console.error(`[detect-dt] Gagal mengambil data candlestick atau data tidak cukup untuk ${symbol}. Length: ${candlesResponse.data?.data?.length}`);
      return response.status(500).json({ message: `Gagal mengambil data candlestick atau data tidak cukup (${candlesResponse.data?.data?.length || 0} candles) untuk ${symbol}.` });
    }

    const candles = candlesResponse.data.data;
    console.log(`[detect-dt] Berhasil mengambil ${candles.length} candles.`);

    const lowPrices = candles.map(c => c.low);
    const highPrices = candles.map(c => c.high);

    localLowsIdx = findLocalLows(lowPrices, ORDER_EXTREMA_DT);
    localHighsIdx = findLocalHighs(highPrices, ORDER_EXTREMA_DT);
    console.log(`[detect-dt] Ditemukan ${localLowsIdx.length} lows & ${localHighsIdx.length} highs dengan order ${ORDER_EXTREMA_DT}.`);

    potentialPatterns = [];
    for (let i = 0; i < localLowsIdx.length - (MIN_LOWS_FOR_SUPPORT - 1); i++) {
      const supportCandidateIndices = [localLowsIdx[i]];
      const supportCandidateValues = [lowPrices[localLowsIdx[i]]];
      
      for (let j = i + 1; j < localLowsIdx.length; j++) {
        const currentLowIdx = localLowsIdx[j];
        const currentLowVal = lowPrices[currentLowIdx];
        const firstLowVal = supportCandidateValues[0];

        if (firstLowVal === 0) continue; // Hindari pembagian dengan nol
        if (Math.abs(currentLowVal - firstLowVal) / firstLowVal <= SUPPORT_LEVEL_TOLERANCE) {
          supportCandidateIndices.push(currentLowIdx);
          supportCandidateValues.push(currentLowVal);
        }
      }

      if (supportCandidateIndices.length >= MIN_LOWS_FOR_SUPPORT) {
        const avgSupportLevel = supportCandidateValues.reduce((s, v) => s + v, 0) / supportCandidateValues.length;
        const firstSupportIdx = Math.min(...supportCandidateIndices); // Indeks paling awal dari support
        const lastSupportIdx = Math.max(...supportCandidateIndices);  // Indeks paling akhir dari support

        const relevantHighsIndices = localHighsIdx.filter(hIdx => 
            hIdx >= firstSupportIdx && 
            hIdx <= lastSupportIdx && 
            highPrices[hIdx] > avgSupportLevel
        ).sort((a, b) => a - b); // Pastikan urut
        
        if (relevantHighsIndices.length >= MIN_HIGHS_FOR_RESISTANCE) {
          let isDescending = true;
          for (let h = 0; h < relevantHighsIndices.length - 1; h++) {
            if (highPrices[relevantHighsIndices[h+1]] >= highPrices[relevantHighsIndices[h]] - (highPrices[relevantHighsIndices[h]] * 0.005)) { // Toleransi kecil agar tidak terlalu ketat
              isDescending = false;
              break;
            }
          }

          if (isDescending) {
            const peakX = relevantHighsIndices;
            const peakY = relevantHighsIndices.map(idx => highPrices[idx]);
            const resistanceLine = simpleLinearRegression(peakX, peakY);

            if (resistanceLine && resistanceLine.slope < MAX_RESISTANCE_SLOPE) {
              const resistanceAtStart = resistanceLine.slope * firstSupportIdx + resistanceLine.intercept;
              if (resistanceAtStart > avgSupportLevel) {
                const patternEndIdx = Math.max(lastSupportIdx, relevantHighsIndices[relevantHighsIndices.length-1]);
                potentialPatterns.push({
                  symbol: symbol.toUpperCase(),
                  supportLevel: avgSupportLevel,
                  supportIndices: supportCandidateIndices.map(idx => ({index: idx, value: lowPrices[idx], timestamp: candles[idx].timestamp})),
                  resistanceLine: resistanceLine,
                  resistanceIndices: relevantHighsIndices.map(idx => ({index: idx, value: highPrices[idx], timestamp: candles[idx].timestamp})),
                  patternStartIndex: firstSupportIdx,
                  patternEndIndex: patternEndIdx,
                  patternEndTimestamp: candles[patternEndIdx].timestamp // Timestamp akhir formasi
                });
              }
            }
          }
        }
      }
    }

    const confirmedPatterns = [];
    const currentCandleIndex = candles.length - 1;

    for (const pattern of potentialPatterns) {
      const supportLevel = pattern.supportLevel;
      const lastPatternIndex = pattern.patternEndIndex;

      let breakdownCandle = null;
      for (let k = lastPatternIndex + 1; k < candles.length && k <= lastPatternIndex + CANDLES_TO_CHECK_BREAKDOWN_DT; k++) {
        const currentCandle = candles[k];
        if (currentCandle.close < supportLevel) {
            const buffer = supportLevel * BREAKDOWN_BUFFER_PERCENT_DT;
            if (currentCandle.close < supportLevel - buffer) {
              breakdownCandle = {
                timestamp: currentCandle.timestamp,
                closePrice: currentCandle.close,
                supportLevelBroken: supportLevel,
                index: k,
                volume: currentCandle.volume
              };
              break;
            }
        }
      }

      if (breakdownCandle) {
        // --- BARU: Cek Kesegaran Breakdown ---
        const candlesAgo = currentCandleIndex - breakdownCandle.index;
        if (candlesAgo < 0 || candlesAgo >= MAX_CANDLES_AGO_FOR_FRESH_BREAKDOWN) {
            console.log(`[detect-dt] DT for ${symbol} - Breakdown at index ${breakdownCandle.index} is NOT FRESH (${candlesAgo} candles ago). Max allowed: ${MAX_CANDLES_AGO_FOR_FRESH_BREAKDOWN-1}. Skipping.`);
            continue; 
        }
        console.log(`[detect-dt] DT for ${symbol} - Breakdown at index ${breakdownCandle.index} IS FRESH (${candlesAgo} candles ago).`);
        // --- AKHIR PENGECEKAN KESEGARAN ---

        const startVolumeIdx = Math.max(0, breakdownCandle.index - VOLUME_LOOKBACK_DT);
        const volumesBeforeBreakout = candles.slice(startVolumeIdx, breakdownCandle.index).map(c => c.volume);
        const avgVolume = volumesBeforeBreakout.length > 0
                          ? volumesBeforeBreakout.reduce((sum, vol) => sum + vol, 0) / volumesBeforeBreakout.length
                          : 0;
        const isVolumeConfirmed = avgVolume > 0 && breakdownCandle.volume > avgVolume * VOLUME_MULTIPLIER_DT;

        const firstResistancePeakIndex = pattern.resistanceIndices[0].index; // Ambil index dari objek
        const patternHeight = highPrices[firstResistancePeakIndex] - supportLevel;
        let targetPrice = null;
        if (patternHeight > 0) {
            targetPrice = supportLevel - patternHeight;
        }

        confirmedPatterns.push({
          ...pattern,
          breakdownConfirmation: { ...breakdownCandle, volumeConfirmed, avgVolumeBefore: avgVolume },
          projection: { patternHeight: patternHeight > 0 ? patternHeight : null, targetPrice },
          status: `Descending Triangle Confirmed FRESH Breakdown (Vol: ${isVolumeConfirmed ? 'Yes' : 'No'})`
        });
      }
    }

    const parametersUsed = {
        order_extrema: ORDER_EXTREMA_DT,
        candles_limit: CANDLES_LIMIT_DT,
        support_level_tolerance: SUPPORT_LEVEL_TOLERANCE,
        min_lows_for_support: MIN_LOWS_FOR_SUPPORT,
        min_highs_for_resistance: MIN_HIGHS_FOR_RESISTANCE,
        max_resistance_slope: MAX_RESISTANCE_SLOPE,
        min_pattern_duration: MIN_PATTERN_DURATION,
        candles_to_check_breakdown: CANDLES_TO_CHECK_BREAKDOWN_DT,
        breakdown_buffer_percent: BREAKDOWN_BUFFER_PERCENT_DT,
        volume_lookback: VOLUME_LOOKBACK_DT,
        volume_multiplier: VOLUME_MULTIPLIER_DT,
        max_candles_ago_for_fresh_breakdown: MAX_CANDLES_AGO_FOR_FRESH_BREAKDOWN // BARU
    };

    if (confirmedPatterns.length > 0) {
      response.status(200).json({
        message: `Ditemukan ${confirmedPatterns.length} Pola Descending Triangle TERKONFIRMASI (SEGAR) untuk ${symbol.toUpperCase()}.`,
        patterns: confirmedPatterns,
        parameters_used: parametersUsed,
      });
    } else {
      response.status(200).json({
        message: `Tidak ada Pola Descending Triangle TERKONFIRMASI (SEGAR) yang terdeteksi untuk ${symbol.toUpperCase()} dari ${potentialPatterns.length} potensi formasi.`,
        potentialFormationsCount: potentialPatterns.length,
        parameters_used: parametersUsed,
      });
    }

  } catch (error) {
    console.error(`[detect-dt] Critical Error for ${symbol}:`, error.message, error.stack);
    response.status(500).json({ message: `Kesalahan internal saat mendeteksi pola Descending Triangle untuk ${symbol}.`, error: error.message });
  }
}