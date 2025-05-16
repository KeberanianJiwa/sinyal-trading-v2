// File: api/detect-ascending-triangle.js
import axios from 'axios';

// --- Helper Functions (Sama seperti sebelumnya, pastikan sudah benar) ---
function findLocalLows(data, order) {
  const lowsIndices = [];
  if (data.length < (2 * order + 1)) {
    // console.warn(`[findLocalLowsAT] Not enough data (${data.length}) to find lows with order ${order}`);
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
    // console.warn(`[findLocalHighsAT] Not enough data (${data.length}) to find highs with order ${order}`);
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

  // --- Parameter Tuning untuk Ascending Triangle ---
  const ORDER_EXTREMA_AT = 5;
  const CANDLES_LIMIT_AT = 300;
  const RESISTANCE_LEVEL_TOLERANCE = 0.01; 
  const MIN_HIGHS_FOR_RESISTANCE = 2;
  const MIN_LOWS_FOR_SUPPORT = 2;
  const MIN_SUPPORT_SLOPE = 0.00001; // Slope support harus positif (tidak boleh datar atau turun)
  const MIN_PATTERN_DURATION_AT = 20;
  const CANDLES_TO_CHECK_BREAKOUT_AT = 15;
  const BREAKOUT_BUFFER_PERCENT_AT = 0.001;
  const VOLUME_LOOKBACK_AT = 30;
  const VOLUME_MULTIPLIER_AT = 1.5;
  // --- BARU: Parameter Kesegaran Breakout ---
  const MAX_CANDLES_AGO_FOR_FRESH_BREAKOUT = 3; // Breakout harus dalam 3 candle terakhir
  // --- End of Parameter Tuning ---

  try {
    console.log(`[detect-at] Fetching ${CANDLES_LIMIT_AT} candles for ${symbol}...`);
    const protocol = request.headers['x-forwarded-proto'] || 'http';
    const host = request.headers.host;
    const candleApiUrl = `${protocol}://${host}/api/get-candles`;

    const candlesResponse = await axios.get(candleApiUrl, {
      params: { symbol: symbol.toUpperCase(), granularity: '1h', limit: CANDLES_LIMIT_AT },
      headers: { 'Accept': 'application/json' }
    });

    if (!candlesResponse.data || !candlesResponse.data.data || candlesResponse.data.data.length < MIN_PATTERN_DURATION_AT + ORDER_EXTREMA_AT) {
      console.error(`[detect-at] Gagal mengambil data candlestick atau data tidak cukup untuk ${symbol}. Length: ${candlesResponse.data?.data?.length}`);
      return response.status(500).json({ message: `Gagal mengambil data candlestick atau data tidak cukup (${candlesResponse.data?.data?.length || 0} candles) untuk ${symbol}.` });
    }

    const candles = candlesResponse.data.data;
    console.log(`[detect-at] Berhasil mengambil ${candles.length} candles.`);

    const lowPrices = candles.map(c => c.low);
    const highPrices = candles.map(c => c.high);

    const localLowsIdx = findLocalLows(lowPrices, ORDER_EXTREMA_AT);
    const localHighsIdx = findLocalHighs(highPrices, ORDER_EXTREMA_AT);
    // console.log(`[detect-at] Ditemukan ${localLowsIdx.length} lows & ${localHighsIdx.length} highs.`);

    const potentialPatterns = [];
    for (let i = 0; i < localHighsIdx.length - (MIN_HIGHS_FOR_RESISTANCE - 1); i++) {
      const resistanceCandidateIndices = [localHighsIdx[i]];
      const resistanceCandidateValues = [highPrices[localHighsIdx[i]]];
      
      for (let j = i + 1; j < localHighsIdx.length; j++) {
        const currentHighIdx = localHighsIdx[j];
        const currentHighVal = highPrices[currentHighIdx];
        const firstHighVal = resistanceCandidateValues[0];
        if (firstHighVal === 0) continue;
        if (Math.abs(currentHighVal - firstHighVal) / firstHighVal <= RESISTANCE_LEVEL_TOLERANCE) {
          resistanceCandidateIndices.push(currentHighIdx);
          resistanceCandidateValues.push(currentHighVal);
        }
      }

      if (resistanceCandidateIndices.length >= MIN_HIGHS_FOR_RESISTANCE) {
        const avgResistanceLevel = resistanceCandidateValues.reduce((s, v) => s + v, 0) / resistanceCandidateValues.length;
        const firstResistanceIdx = Math.min(...resistanceCandidateIndices);
        const lastResistanceIdx = Math.max(...resistanceCandidateIndices);

        const relevantLowsIndices = localLowsIdx.filter(lIdx => 
            lIdx >= firstResistanceIdx && 
            lIdx <= lastResistanceIdx && 
            lowPrices[lIdx] < avgResistanceLevel - (avgResistanceLevel * 0.005) // Lows harus di bawah resistance
        ).sort((a, b) => a - b);
        
        if (relevantLowsIndices.length >= MIN_LOWS_FOR_SUPPORT) {
          let isAscending = true;
          for (let l = 0; l < relevantLowsIndices.length - 1; l++) {
            if (lowPrices[relevantLowsIndices[l+1]] <= lowPrices[relevantLowsIndices[l]] + (lowPrices[relevantLowsIndices[l]] * 0.005) ) { // Toleransi kecil
              isAscending = false;
              break;
            }
          }

          if (isAscending) {
            const supportX = relevantLowsIndices;
            const supportY = relevantLowsIndices.map(idx => lowPrices[idx]);
            const supportLine = simpleLinearRegression(supportX, supportY);

            if (supportLine && supportLine.slope > MIN_SUPPORT_SLOPE) {
              const supportAtStart = supportLine.slope * firstResistanceIdx + supportLine.intercept;
              const resistanceAtStart = avgResistanceLevel; 
              const supportAtEnd = supportLine.slope * lastResistanceIdx + supportLine.intercept;
              const resistanceAtEnd = avgResistanceLevel;

              if (supportAtStart < resistanceAtStart && supportAtEnd < resistanceAtEnd && (resistanceAtStart - supportAtStart) > (resistanceAtEnd - supportAtEnd)) { 
                const patternEndIdx = Math.max(lastResistanceIdx, relevantLowsIndices[relevantLowsIndices.length-1]);
                 // Hindari duplikasi pola yang sama persis berdasarkan titik akhir
                const existing = potentialPatterns.find(p => p.patternEndIndex === patternEndIdx && Math.abs(p.resistanceLevel - avgResistanceLevel) < 0.001 * avgResistanceLevel);
                if(!existing) {
                    potentialPatterns.push({
                        symbol: symbol.toUpperCase(),
                        resistanceLevel: avgResistanceLevel,
                        resistancePoints: resistanceCandidateIndices.map(idx => ({index: idx, value: highPrices[idx], timestamp: candles[idx].timestamp})),
                        supportLine: supportLine,
                        supportPoints: relevantLowsIndices.map(idx => ({index: idx, value: lowPrices[idx], timestamp: candles[idx].timestamp})),
                        patternStartIndex: Math.min(firstResistanceIdx, relevantLowsIndices[0]),
                        patternEndIndex: patternEndIdx,
                        patternEndTimestamp: candles[patternEndIdx]?.timestamp || Date.now()
                    });
                    // console.log(`[detect-at] Potential AT found. Resistance ~${avgResistanceLevel.toFixed(2)}`);
                }
              }
            }
          }
        }
      }
    }

    const confirmedPatterns = [];
    const currentCandleIndex = candles.length - 1;
    potentialPatterns.sort((a,b) => a.patternEndIndex - b.patternEndIndex);


    for (const pattern of potentialPatterns) {
      const resistanceLevel = pattern.resistanceLevel;
      const lastPatternIndex = pattern.patternEndIndex;

      let breakoutCandle = null;
      for (let k = lastPatternIndex + 1; k < candles.length && k <= lastPatternIndex + CANDLES_TO_CHECK_BREAKOUT_AT; k++) {
        const currentCandle = candles[k];
        if (currentCandle.close > resistanceLevel) {
            const buffer = resistanceLevel * BREAKOUT_BUFFER_PERCENT_AT;
            if (currentCandle.close > resistanceLevel + buffer) {
              breakoutCandle = {
                timestamp: currentCandle.timestamp,
                closePrice: currentCandle.close,
                resistanceLevelBroken: resistanceLevel,
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
            console.log(`[detect-at] AT for ${symbol} - Breakout at index ${breakoutCandle.index} is NOT FRESH (${candlesAgo} candles ago). Max allowed: ${MAX_CANDLES_AGO_FOR_FRESH_BREAKOUT-1}. Skipping.`);
            continue; 
        }
        console.log(`[detect-at] AT for ${symbol} - Breakout at index ${breakoutCandle.index} IS FRESH (${candlesAgo} candles ago).`);
        // --- AKHIR PENGECEKAN KESEGARAN ---

        const startVolumeIdx = Math.max(0, breakoutCandle.index - VOLUME_LOOKBACK_AT);
        const volumesBeforeBreakout = candles.slice(startVolumeIdx, breakoutCandle.index).map(c => c.volume);
        const avgVolume = volumesBeforeBreakout.length > 0 ? volumesBeforeBreakout.reduce((sum, vol) => sum + vol, 0) / volumesBeforeBreakout.length : 0;
        const isVolumeConfirmed = avgVolume > 0 && breakoutCandle.volume > avgVolume * VOLUME_MULTIPLIER_AT;

        const firstSupportLowIndex = pattern.supportPoints[0].index; // Ambil dari supportPoints
        const patternHeight = resistanceLevel - lowPrices[firstSupportLowIndex];
        let targetPrice = null;
        if (patternHeight > 0) {
            targetPrice = resistanceLevel + patternHeight;
        }
        
        confirmedPatterns.push({
          ...pattern,
          breakoutConfirmation: { ...breakoutCandle, volumeConfirmed, avgVolumeBefore: avgVolume },
          projection: { patternHeight: patternHeight > 0 ? patternHeight : null, targetPrice },
          status: `Ascending Triangle Confirmed FRESH Breakout (Vol: ${isVolumeConfirmed ? 'Yes' : 'No'})`
        });
      }
    }

    const parametersUsed = {
        order_extrema: ORDER_EXTREMA_AT, candles_limit: CANDLES_LIMIT_AT, resistance_level_tolerance: RESISTANCE_LEVEL_TOLERANCE,
        min_highs_for_resistance: MIN_HIGHS_FOR_RESISTANCE, min_lows_for_support: MIN_LOWS_FOR_SUPPORT, min_support_slope: MIN_SUPPORT_SLOPE,
        min_pattern_duration: MIN_PATTERN_DURATION_AT, candles_to_check_breakout: CANDLES_TO_CHECK_BREAKOUT_AT,
        breakout_buffer_percent: BREAKOUT_BUFFER_PERCENT_AT, volume_lookback: VOLUME_LOOKBACK_AT, volume_multiplier: VOLUME_MULTIPLIER_AT,
        // touch_tolerance_percent: TOUCH_TOLERANCE_PERCENT_AT, // Belum diimplementasikan secara eksplisit
        max_candles_ago_for_fresh_breakout: MAX_CANDLES_AGO_FOR_FRESH_BREAKOUT // BARU
    };

    if (confirmedPatterns.length > 0) {
      response.status(200).json({
        message: `Ditemukan ${confirmedPatterns.length} Pola Ascending Triangle TERKONFIRMASI (SEGAR) untuk ${symbol.toUpperCase()}.`,
        patterns: confirmedPatterns,
        parameters_used: parametersUsed,
      });
    } else {
      response.status(200).json({
        message: `Tidak ada Pola Ascending Triangle TERKONFIRMASI (SEGAR) yang terdeteksi untuk ${symbol.toUpperCase()} dari ${potentialPatterns.length} potensi formasi.`, // Menggunakan potentialPatterns.length
        potentialFormationsCount: potentialPatterns.length, // Menggunakan potentialPatterns.length
        parameters_used: parametersUsed,
      });
    }

  } catch (error) {
    console.error(`[detect-at] Critical Error for ${symbol}:`, error.message, error.stack);
    response.status(500).json({ message: `Kesalahan internal saat mendeteksi pola Ascending Triangle untuk ${symbol}.`, error: error.message });
  }
}