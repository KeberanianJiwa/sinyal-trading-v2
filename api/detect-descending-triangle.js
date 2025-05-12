// File: api/detect-descending-triangle.js
import axios from 'axios';

// --- Helper Functions ---

// Fungsi findLocalLows (sama seperti sebelumnya)
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

// Fungsi findLocalHighs (sama seperti sebelumnya)
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

// Fungsi Simple Linear Regression (untuk garis resistance)
function simpleLinearRegression(x, y) {
  const n = x.length;
  if (n === 0 || n !== y.length) return null; // Data tidak valid

  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (let i = 0; i < n; i++) {
    sumX += x[i];
    sumY += y[i];
    sumXY += x[i] * y[i];
    sumXX += x[i] * x[i];
  }

  const denominator = n * sumXX - sumX * sumX;
  if (denominator === 0) return null; // Hindari pembagian dengan nol

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
  const SUPPORT_LEVEL_TOLERANCE = 0.01; // Maks persentase perbedaan antar low di support (1%)
  const MIN_LOWS_FOR_SUPPORT = 2; // Minimal lembah untuk membentuk support
  const MIN_HIGHS_FOR_RESISTANCE = 2; // Minimal puncak untuk membentuk resistance
  const MAX_RESISTANCE_SLOPE = -0.00001; // Slope resistance harus negatif (tidak boleh datar atau naik)
  const MIN_PATTERN_DURATION = 20; // Minimal jumlah candle dari awal pola hingga akhir
  const CANDLES_TO_CHECK_BREAKDOWN_DT = 15;
  const BREAKDOWN_BUFFER_PERCENT_DT = 0.001; // Buffer breakdown (0.1%) di bawah support
  const VOLUME_LOOKBACK_DT = 30;
  const VOLUME_MULTIPLIER_DT = 1.3; // Volume breakdown harus > N kali rata-rata
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

    if (!candlesResponse.data || !candlesResponse.data.data || candlesResponse.data.data.length < MIN_PATTERN_DURATION) {
      console.error(`[detect-dt] Gagal mengambil data candlestick atau data tidak cukup untuk ${symbol}.`);
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
    // Iterasi untuk menemukan potensi pola Descending Triangle
    // Logika ini lebih kompleks: kita perlu mencari kombinasi lows & highs yang cocok
    // Pendekatan: Cari kandidat support horizontal dulu, lalu cari resistance menurun di atasnya.

    for (let i = 0; i < localLowsIdx.length - (MIN_LOWS_FOR_SUPPORT - 1); i++) {
        const supportLowsIndices = [localLowsIdx[i]];
        const supportLowsValues = [lowPrices[localLowsIdx[i]]];
        
        // Cari lembah berikutnya yang levelnya dekat
        for (let j = i + 1; j < localLowsIdx.length; j++) {
            const currentLowIdx = localLowsIdx[j];
            const currentLowVal = lowPrices[currentLowIdx];
            const firstLowVal = supportLowsValues[0];

            if (Math.abs(currentLowVal - firstLowVal) / firstLowVal <= SUPPORT_LEVEL_TOLERANCE) {
                supportLowsIndices.push(currentLowIdx);
                supportLowsValues.push(currentLowVal);
            }
        }

        // Jika cukup lembah untuk membentuk support
        if (supportLowsIndices.length >= MIN_LOWS_FOR_SUPPORT) {
            const avgSupportLevel = supportLowsValues.reduce((s, v) => s + v, 0) / supportLowsValues.length;
            const firstSupportIdx = supportLowsIndices[0];
            const lastSupportIdx = supportLowsIndices[supportLowsIndices.length - 1];

            // Cari puncak menurun di atas level support ini
            const relevantHighsIndices = localHighsIdx.filter(hIdx => hIdx >= firstSupportIdx && hIdx <= lastSupportIdx && highPrices[hIdx] > avgSupportLevel);
            
            if (relevantHighsIndices.length >= MIN_HIGHS_FOR_RESISTANCE) {
                // Cek apakah puncak-puncak ini menurun (lower highs)
                let isDescending = true;
                for (let h = 0; h < relevantHighsIndices.length - 1; h++) {
                    if (highPrices[relevantHighsIndices[h+1]] >= highPrices[relevantHighsIndices[h]]) {
                        isDescending = false;
                        break;
                    }
                }

                if (isDescending) {
                    // Fit garis regresi pada puncak-puncak ini
                    const peakX = relevantHighsIndices; // Gunakan indeks sebagai X
                    const peakY = relevantHighsIndices.map(idx => highPrices[idx]);
                    const resistanceLine = simpleLinearRegression(peakX, peakY);

                    // Cek slope negatif & konvergensi (resistance di atas support di awal)
                    if (resistanceLine && resistanceLine.slope < MAX_RESISTANCE_SLOPE) {
                         const resistanceAtStart = resistanceLine.slope * firstSupportIdx + resistanceLine.intercept;
                         if (resistanceAtStart > avgSupportLevel) { // Memastikan garis converge
                            console.log(`[detect-dt] Potential DT found: Support ~${avgSupportLevel.toFixed(2)} [${supportLowsIndices.join(',')}] Resistance slope ${resistanceLine.slope.toFixed(4)} [${relevantHighsIndices.join(',')}]`);
                            potentialPatterns.push({
                                symbol: symbol.toUpperCase(),
                                message: 'Potensi Pola Descending Triangle Teridentifikasi (Formasi)',
                                supportLevel: avgSupportLevel,
                                supportIndices: supportLowsIndices,
                                resistanceLine: resistanceLine,
                                resistanceIndices: relevantHighsIndices,
                                patternStartIndex: firstSupportIdx,
                                patternEndIndex: Math.max(lastSupportIdx, relevantHighsIndices[relevantHighsIndices.length-1]) // Indeks terakhir dari pola
                            });
                         }
                    }
                }
            }
        }
    } // End of loop searching for patterns


    // Cek Breakdown untuk setiap potensi pola
    const confirmedPatterns = [];
    for (const pattern of potentialPatterns) {
      const supportLevel = pattern.supportLevel;
      const lastPatternIndex = pattern.patternEndIndex;

      let breakdownCandle = null;
      for (let k = lastPatternIndex + 1; k < candles.length && k <= lastPatternIndex + CANDLES_TO_CHECK_BREAKDOWN_DT; k++) {
        const currentCandle = candles[k];
        console.log(`[detect-dt] Checking Breakdown DT: Index ${k}, Close: ${currentCandle.close}, Support Level: ${supportLevel.toFixed(2)}`);

        // Kondisi Breakdown: Harga penutupan di bawah level support
        if (currentCandle.close < supportLevel) {
           const buffer = supportLevel * BREAKDOWN_BUFFER_PERCENT_DT;
           if (currentCandle.close < supportLevel - buffer) { // Close di bawah support MINUS buffer
              console.log(`[detect-dt] DT BREAKDOWN DETECTED at index ${k}`);
              breakdownCandle = {
                timestamp: currentCandle.timestamp,
                closePrice: currentCandle.close,
                supportLevelBroken: supportLevel,
                index: k,
                volume: currentCandle.volume
              };
              break;
           } else {
              console.log(`[detect-dt] DT Close price below support but within buffer at index ${k}`);
           }
        }
      } // End loop checking for breakdown

      if (breakdownCandle) {
        const startVolumeIdx = Math.max(0, breakdownCandle.index - VOLUME_LOOKBACK_DT);
        const volumesBeforeBreakout = candles.slice(startVolumeIdx, breakdownCandle.index).map(c => c.volume);
        const avgVolume = volumesBeforeBreakout.length > 0
                           ? volumesBeforeBreakout.reduce((sum, vol) => sum + vol, 0) / volumesBeforeBreakout.length
                           : 0;
        const isVolumeConfirmed = avgVolume > 0 && breakdownCandle.volume > avgVolume * VOLUME_MULTIPLIER_DT;
        console.log(`[detect-dt] DT Breakdown Volume Check: BreakdownVol=${breakdownCandle.volume.toFixed(2)}, AvgVol(${VOLUME_LOOKBACK_DT} candles)=${avgVolume.toFixed(2)}, Confirmed=${isVolumeConfirmed} (Threshold ${VOLUME_MULTIPLIER_DT}x)`);

        // Hitung Target Harga
        // Tinggi pola = Puncak tertinggi pertama dalam pola - Level Support
        const firstResistancePeakIndex = pattern.resistanceIndices[0];
        const patternHeight = highPrices[firstResistancePeakIndex] - supportLevel;
        let targetPrice = null;
        if (patternHeight > 0) {
            targetPrice = supportLevel - patternHeight; // Target = Support - Tinggi Pola
        }
        console.log(`[detect-dt] DT Pattern Ends(${lastPatternIndex}) - Height=${patternHeight.toFixed(2)}, TargetPrice=${targetPrice ? targetPrice.toFixed(2) : 'N/A'}`);


        confirmedPatterns.push({
          ...pattern,
          breakdownConfirmation: {
             ...breakdownCandle,
             volumeConfirmed: isVolumeConfirmed,
             avgVolumeBefore: avgVolume
          },
          projection: {
              patternHeight: patternHeight,
              targetPrice: targetPrice
          },
          status: "Descending Triangle Confirmed with Breakdown"
        });
      } else {
          console.log(`[detect-dt] DT Pattern Ends(${lastPatternIndex}) - No breakdown found within ${CANDLES_TO_CHECK_BREAKDOWN_DT} candles.`);
      }
    } // End loop through potential patterns


    // Kirim Respons Akhir
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
        volume_multiplier: VOLUME_MULTIPLIER_DT
    };

    if (confirmedPatterns.length > 0) {
        console.log(`[detect-dt] Sending response: ${confirmedPatterns.length} confirmed Descending Triangle patterns.`);
        response.status(200).json({
            message: `Ditemukan ${confirmedPatterns.length} Pola Descending Triangle TERKONFIRMASI untuk ${symbol.toUpperCase()}.`,
            patterns: confirmedPatterns,
            parameters_used: parametersUsed,
            totalCandlesAnalyzed: candles.length,
            localLowsFound: localLowsIdx.length,
            localHighsFound: localHighsIdx.length // Tambahkan info highs
        });
    } else {
        console.log(`[detect-dt] Sending response: No confirmed Descending Triangle patterns found.`);
        response.status(200).json({
            message: `Tidak ada Pola Descending Triangle TERKONFIRMASI (dengan breakdown) yang terdeteksi untuk ${symbol.toUpperCase()} dari ${potentialPatterns.length} potensi formasi.`,
            potentialFormationsCount: potentialPatterns.length,
            parameters_used: parametersUsed,
            totalCandlesAnalyzed: candles.length,
            localLowsFound: localLowsIdx.length,
            localHighsFound: localHighsIdx.length
        });
    }

  } catch (error) {
    console.error(`[detect-dt] Critical Error for ${symbol}:`, error.message, error.stack);
    // ... (Error handling sama seperti sebelumnya) ...
    let errorDetails = {
        message: `Terjadi kesalahan internal saat mencoba mendeteksi pola Descending Triangle untuk ${symbol}.`,
        errorMessage: error.message,
    };
     if (error.response) {
        console.error(`[detect-dt] Upstream error from /api/get-candles: Status=${error.response.status}`, error.response.data);
        errorDetails.upstreamStatus = error.response.status;
        errorDetails.upstreamData = error.response.data;
    } else {
        console.error(`[detect-dt] Non-axios error:`, error);
    }
    response.status(500).json(errorDetails);
  }
}