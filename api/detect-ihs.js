// File: api/detect-ihs.js
import axios from 'axios';

// Helper function to find local minima (troughs)
// data: array of numbers (e.g., low prices)
// order: number of points on each side to compare
function findLocalLows(data, order) {
  const lowsIndices = [];
  if (data.length < (2 * order + 1)) {
    console.warn(`[findLocalLows] Not enough data (${data.length}) to find lows with order ${order}`);
    return lowsIndices; // Not enough data
  }
  for (let i = order; i < data.length - order; i++) {
    let isLow = true;
    for (let j = 1; j <= order; j++) {
      // Point 'i' must be less than or equal to all points within 'order' distance
      if (data[i] > data[i - j] || data[i] > data[i + j]) {
        isLow = false;
        break;
      }
    }
    // Basic check to avoid adding same index if logic somehow allows it
    // Handles plateaus by including all points if the plateau is an extremum
    // Refinement: Avoid adding consecutive points if they have the exact same low value
    // to potentially select just the start of a flat bottom.
    if (isLow) {
       const lastAddedLowIdx = lowsIndices.length > 0 ? lowsIndices[lowsIndices.length-1] : -1;
       // Only add if it's not the same index and not directly adjacent with the same value as the last added low
       if (!lowsIndices.includes(i) && !(lastAddedLowIdx === i-1 && data[i] === data[lastAddedLowIdx]) ) {
           lowsIndices.push(i);
       }
    }
  }
  return lowsIndices;
}

// Helper function to find local maxima (peaks)
function findLocalHighs(data, order) {
  const highsIndices = [];
   if (data.length < (2 * order + 1)) {
    console.warn(`[findLocalHighs] Not enough data (${data.length}) to find highs with order ${order}`);
    return highsIndices;
  }
  for (let i = order; i < data.length - order; i++) {
    let isHigh = true;
    for (let j = 1; j <= order; j++) {
      // Point 'i' must be greater than or equal to all points within 'order' distance
      if (data[i] < data[i - j] || data[i] < data[i + j]) {
        isHigh = false;
        break;
      }
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


export default async function handler(request, response) {
  const { symbol } = request.query;

  if (!symbol) {
    return response.status(400).json({ message: 'Parameter "symbol" diperlukan.' });
  }

  // --- Parameter Tuning (Mudah diubah di sini) ---
  const ORDER_EXTREMA = 5; // Order untuk deteksi puncak/lembah (misal: 3, 5, 7)
  const CANDLES_LIMIT = 300; // Jumlah candle yang diambil
  const PEAK_SYMMETRY_THRESHOLD = 0.05; // Toleransi simetri puncak P1-P2 (5%)
  const SHOULDER_SYMMETRY_THRESHOLD = 0.10; // Toleransi simetri bahu S1-S2 (10%)
  const CANDLES_TO_CHECK_BREAKOUT = 15; // Jumlah candle setelah S2 untuk cek breakout
  const BREAKOUT_BUFFER_PERCENT = 0.001; // Buffer breakout (0.1%) di atas neckline
  const VOLUME_LOOKBACK = 30; // Periode rata-rata volume (sebelumnya 20)
  const VOLUME_MULTIPLIER = 1.3; // Pengali volume breakout (sebelumnya 1.5)
  // --- End of Parameter Tuning ---

  let localLowsIdx = [];
  let potentialPatterns = [];

  try {
    // 1. Ambil data candlestick
    console.log(`[detect-ihs] Fetching ${CANDLES_LIMIT} candles for ${symbol}...`);
    const protocol = request.headers['x-forwarded-proto'] || 'http';
    const host = request.headers.host;
    const candleApiUrl = `${protocol}://${host}/api/get-candles`;

    const candlesResponse = await axios.get(candleApiUrl, {
      params: { symbol: symbol.toUpperCase(), granularity: '1h', limit: CANDLES_LIMIT },
      headers: { 'Accept': 'application/json' }
    });

    if (!candlesResponse.data || !candlesResponse.data.data || candlesResponse.data.data.length === 0) {
      console.error(`[detect-ihs] Gagal mengambil data candlestick atau data kosong untuk ${symbol}. Response:`, candlesResponse.data);
      return response.status(500).json({ message: `Gagal mengambil data candlestick atau data kosong untuk ${symbol}.` });
    }

    const candles = candlesResponse.data.data;
    console.log(`[detect-ihs] Berhasil mengambil ${candles.length} candles.`);

    if (candles.length < 50) {
        return response.status(400).json({ message: `Data candlestick tidak cukup untuk analisa IH&S, hanya ada ${candles.length} bar.`});
    }

    const lowPrices = candles.map(c => c.low);
    const highPrices = candles.map(c => c.high);
    const closePrices = candles.map(c => c.close); // Perlu untuk cek breakout

    // 2. Deteksi ekstrem lokal (lembah)
    localLowsIdx = findLocalLows(lowPrices, ORDER_EXTREMA);
    console.log(`[detect-ihs] Ditemukan ${localLowsIdx.length} lembah lokal dengan order ${ORDER_EXTREMA}.`);

    // 3. Iterasi untuk menemukan kandidat pola IH&S
    potentialPatterns = [];
    if (localLowsIdx.length >= 3) {
      for (let i = 0; i < localLowsIdx.length - 2; i++) {
        const s1_idx = localLowsIdx[i];
        const h_idx = localLowsIdx[i+1];
        const s2_idx = localLowsIdx[i+2];

        if (h_idx <= s1_idx + ORDER_EXTREMA || s2_idx <= h_idx + ORDER_EXTREMA) {
           console.log(`[detect-ihs] Skipping S1(${s1_idx}), H(${h_idx}), S2(${s2_idx}) due to insufficient separation.`);
           continue;
        }

        const S1 = candles[s1_idx];
        const H  = candles[h_idx];
        const S2 = candles[s2_idx];

        // Cari Puncak P1 (tertinggi antara S1 dan H) dan Puncak P2 (tertinggi antara H dan S2)
        let P1_val = -Infinity, P1_idx = -1;
        for (let j = s1_idx + 1; j < h_idx; j++) {
          if (highPrices[j] > P1_val) {
            P1_val = highPrices[j];
            P1_idx = j;
          }
        }

        let P2_val = -Infinity, P2_idx = -1;
        for (let j = h_idx + 1; j < s2_idx; j++) {
          if (highPrices[j] > P2_val) {
            P2_val = highPrices[j];
            P2_idx = j;
          }
        }

        if (P1_idx === -1 || P2_idx === -1) {
           console.log(`[detect-ihs] Skipping S1(${s1_idx}), H(${h_idx}), S2(${s2_idx}) - Failed to find P1 or P2 between troughs.`);
           continue;
        }

        const P1 = candles[P1_idx];
        const P2 = candles[P2_idx];

        // 4. Terapkan Aturan Pola IH&S
        const headLowest = H.low < S1.low && H.low < S2.low;

        const peakMean = (P1.high + P2.high) / 2;
        if (peakMean === 0) continue;
        const peakSymmetry = Math.abs(P1.high - P2.high) < PEAK_SYMMETRY_THRESHOLD * peakMean;

        const shoulderMean = (S1.low + S2.low) / 2;
        let shoulderSymmetry = true;
        if (shoulderMean !== 0) {
             shoulderSymmetry = Math.abs(S1.low - S2.low) < SHOULDER_SYMMETRY_THRESHOLD * shoulderMean;
        }

        console.log(`[detect-ihs] Checking Candidate: S1(${s1_idx}, ${S1.low.toFixed(2)}), H(${h_idx}, ${H.low.toFixed(2)}), S2(${s2_idx}, ${S2.low.toFixed(2)}), P1(${P1_idx}, ${P1.high.toFixed(2)}), P2(${P2_idx}, ${P2.high.toFixed(2)})`);
        console.log(`[detect-ihs] Rules -> headLowest: ${headLowest}, peakSymmetry: ${peakSymmetry}, shoulderSymmetry: ${shoulderSymmetry}`);

        if (headLowest && peakSymmetry && shoulderSymmetry) {
          potentialPatterns.push({
            symbol: symbol.toUpperCase(),
            message: 'Potensi Pola Inverse Head & Shoulders Teridentifikasi (Formasi)',
            S1: { timestamp: S1.timestamp, low: S1.low, index: s1_idx },
            P1: { timestamp: P1.timestamp, high: P1.high, index: P1_idx },
            H:  { timestamp: H.timestamp,  low: H.low, index: h_idx  },
            P2: { timestamp: P2.timestamp, high: P2.high, index: P2_idx },
            S2: { timestamp: S2.timestamp, low: S2.low, index: s2_idx },
            debug_rules: { headLowest, peakSymmetry, shoulderSymmetry }
          });
           console.log(`[detect-ihs] Potential IH&S Formation FOUND at Head index ${h_idx} (incl. shoulder symmetry)`);
        }
      }
    } // End of loop through local lows


    // 5. Hitung Neckline dan Cek Breakout untuk setiap potensi pola
    const confirmedPatterns = [];
    for (const pattern of potentialPatterns) {
      const p1_idx = pattern.P1.index;
      const p1_high = pattern.P1.high;
      const p2_idx = pattern.P2.index;
      const p2_high = pattern.P2.high;

      if (p1_idx === p2_idx) {
        console.log(`[detect-ihs] Skipping pattern at H(${pattern.H.index}) - P1 and P2 index are identical.`);
        continue;
      }

      const slope = (p2_high - p1_high) / (p2_idx - p1_idx);
      const intercept = p1_high - slope * p1_idx;
      console.log(`[detect-ihs] Pattern H(${pattern.H.index}) - Neckline: slope=${slope}, intercept=${intercept}`);

      let breakoutCandle = null;
      for (let j = pattern.S2.index + 1; j < candles.length && j <= pattern.S2.index + CANDLES_TO_CHECK_BREAKOUT; j++) {
        const currentCandle = candles[j];
        const necklineValueAtJ = slope * j + intercept;

        console.log(`[detect-ihs] Checking Breakout: Index ${j}, Close: ${currentCandle.close}, Neckline: ${necklineValueAtJ.toFixed(2)}`);

        if (currentCandle.close > necklineValueAtJ) {
           const buffer = necklineValueAtJ * BREAKOUT_BUFFER_PERCENT;
           if (currentCandle.close > necklineValueAtJ + buffer) {
              console.log(`[detect-ihs] BREAKOUT DETECTED at index ${j}`);
              breakoutCandle = {
                timestamp: currentCandle.timestamp,
                closePrice: currentCandle.close,
                necklineValue: necklineValueAtJ,
                index: j,
                volume: currentCandle.volume
              };
              break;
           } else {
              console.log(`[detect-ihs] Close price above neckline but within buffer at index ${j}`);
           }
        }
      } // End loop checking for breakout

      if (breakoutCandle) {
        // Cek Volume saat breakout
        const startVolumeIdx = Math.max(0, breakoutCandle.index - VOLUME_LOOKBACK);
        const volumesBeforeBreakout = candles.slice(startVolumeIdx, breakoutCandle.index).map(c => c.volume);
        const avgVolume = volumesBeforeBreakout.length > 0
                           ? volumesBeforeBreakout.reduce((sum, vol) => sum + vol, 0) / volumesBeforeBreakout.length
                           : 0;
        const isVolumeConfirmed = avgVolume > 0 && breakoutCandle.volume > avgVolume * VOLUME_MULTIPLIER;
        console.log(`[detect-ihs] Breakout Volume Check: BreakoutVol=${breakoutCandle.volume.toFixed(2)}, AvgVol(${VOLUME_LOOKBACK} candles)=${avgVolume.toFixed(2)}, Confirmed=${isVolumeConfirmed} (Threshold ${VOLUME_MULTIPLIER}x)`);

        // Hitung Target Harga
        const necklineValueAtHead = slope * pattern.H.index + intercept;
        const patternHeight = necklineValueAtHead - pattern.H.low;
        let targetPrice = null;
        if (patternHeight > 0) {
            targetPrice = breakoutCandle.necklineValue + patternHeight; // Target = Neckline di breakout + Tinggi
        }
        console.log(`[detect-ihs] Pattern H(${pattern.H.index}) - Neckline@Head=${necklineValueAtHead.toFixed(2)}, Height=${patternHeight.toFixed(2)}, TargetPrice=${targetPrice ? targetPrice.toFixed(2) : 'N/A'}`);

        confirmedPatterns.push({
          ...pattern,
          neckline: {
            slope: slope,
            intercept: intercept,
            p1_coords: { index: p1_idx, high: p1_high, timestamp: pattern.P1.timestamp },
            p2_coords: { index: p2_idx, high: p2_high, timestamp: pattern.P2.timestamp },
          },
          breakoutConfirmation: {
             ...breakoutCandle,
             volumeConfirmed: isVolumeConfirmed,
             avgVolumeBefore: avgVolume
          },
          projection: {
              patternHeight: patternHeight,
              targetPrice: targetPrice
          },
          status: "IH&S Confirmed with Breakout"
        });
      } else {
          console.log(`[detect-ihs] Pattern H(${pattern.H.index}) - No breakout found within ${CANDLES_TO_CHECK_BREAKOUT} candles after S2.`);
      }
    } // End loop through potential patterns


    // 6. Kirim Respons Akhir
    if (confirmedPatterns.length > 0) {
        console.log(`[detect-ihs] Sending response: ${confirmedPatterns.length} confirmed patterns.`);
        response.status(200).json({
            message: `Ditemukan ${confirmedPatterns.length} Pola IH&S TERKONFIRMASI untuk ${symbol.toUpperCase()}.`,
            patterns: confirmedPatterns,
            parameters_used: { // Sertakan parameter yang digunakan untuk info
                order_extrema: ORDER_EXTREMA,
                candles_limit: CANDLES_LIMIT,
                peak_symmetry_threshold: PEAK_SYMMETRY_THRESHOLD,
                shoulder_symmetry_threshold: SHOULDER_SYMMETRY_THRESHOLD,
                candles_to_check_breakout: CANDLES_TO_CHECK_BREAKOUT,
                breakout_buffer_percent: BREAKOUT_BUFFER_PERCENT,
                volume_lookback: VOLUME_LOOKBACK,
                volume_multiplier: VOLUME_MULTIPLIER
            },
            totalCandlesAnalyzed: candles.length,
            localLowsFound: localLowsIdx.length
        });
    } else {
        console.log(`[detect-ihs] Sending response: No confirmed patterns found.`);
        response.status(200).json({
            message: `Tidak ada Pola IH&S TERKONFIRMASI (dengan breakout) yang terdeteksi untuk ${symbol.toUpperCase()} dari ${potentialPatterns.length} potensi formasi.`,
            potentialFormationsCount: potentialPatterns.length,
            parameters_used: {
                 order_extrema: ORDER_EXTREMA,
                 candles_limit: CANDLES_LIMIT,
                 peak_symmetry_threshold: PEAK_SYMMETRY_THRESHOLD,
                 shoulder_symmetry_threshold: SHOULDER_SYMMETRY_THRESHOLD,
                 candles_to_check_breakout: CANDLES_TO_CHECK_BREAKOUT,
                 breakout_buffer_percent: BREAKOUT_BUFFER_PERCENT,
                 volume_lookback: VOLUME_LOOKBACK,
                 volume_multiplier: VOLUME_MULTIPLIER
            },
            totalCandlesAnalyzed: candles.length,
            localLowsFound: localLowsIdx.length
        });
    }

  } catch (error) {
    console.error(`[detect-ihs] Critical Error for ${symbol}:`, error.message, error.stack);
    let errorDetails = {
        message: `Terjadi kesalahan internal saat mencoba mendeteksi pola IH&S untuk ${symbol}.`,
        errorMessage: error.message,
    };
    if (error.response) { // Error dari panggilan axios ke /api/get-candles
        console.error(`[detect-ihs] Upstream error from /api/get-candles: Status=${error.response.status}`, error.response.data);
        errorDetails.upstreamStatus = error.response.status;
        errorDetails.upstreamData = error.response.data;
    } else {
        console.error(`[detect-ihs] Non-axios error:`, error);
    }
    response.status(500).json(errorDetails);
  }
}