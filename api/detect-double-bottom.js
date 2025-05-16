// File: api/detect-ihs.js
import axios from 'axios';

// Helper function to find local minima (troughs)
function findLocalLows(data, order) {
  const lowsIndices = [];
  if (data.length < (2 * order + 1)) {
    // console.warn(`[findLocalLows] Not enough data (${data.length}) to find lows with order ${order}`);
    return lowsIndices;
  }
  for (let i = order; i < data.length - order; i++) {
    let isLow = true;
    for (let j = 1; j <= order; j++) {
      if (data[i] > data[i - j] || data[i] > data[i + j]) {
        isLow = false;
        break;
      }
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

// Helper function to find local maxima (peaks)
function findLocalHighs(data, order) {
  const highsIndices = [];
    if (data.length < (2 * order + 1)) {
    // console.warn(`[findLocalHighs] Not enough data (${data.length}) to find highs with order ${order}`);
    return highsIndices;
  }
  for (let i = order; i < data.length - order; i++) {
    let isHigh = true;
    for (let j = 1; j <= order; j++) {
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
  const ORDER_EXTREMA = 5;
  const CANDLES_LIMIT = 300;
  const PEAK_SYMMETRY_THRESHOLD = 0.05;
  const SHOULDER_SYMMETRY_THRESHOLD = 0.10;
  const CANDLES_TO_CHECK_BREAKOUT = 15;
  const BREAKOUT_BUFFER_PERCENT = 0.001;
  const VOLUME_LOOKBACK = 30;
  const VOLUME_MULTIPLIER = 1.3;
  // --- BARU: Parameter Kesegaran Breakout ---
  const MAX_CANDLES_AGO_FOR_FRESH_BREAKOUT = 3; // Breakout harus dalam N candle terakhir (termasuk candle saat ini)
  // --- End of Parameter Tuning ---

  let localLowsIdx = [];
  let potentialPatterns = [];

  try {
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

    if (candles.length < 50) { // Perlu setidaknya cukup data untuk 3 lembah dan 2 puncak dengan order
        return response.status(400).json({ message: `Data candlestick tidak cukup untuk analisa IH&S, hanya ada ${candles.length} bar.`});
    }

    const lowPrices = candles.map(c => c.low);
    const highPrices = candles.map(c => c.high);
    // const closePrices = candles.map(c => c.close); // Tidak dipakai langsung di sini, tapi di breakout check

    localLowsIdx = findLocalLows(lowPrices, ORDER_EXTREMA);
    console.log(`[detect-ihs] Ditemukan ${localLowsIdx.length} lembah lokal dengan order ${ORDER_EXTREMA}.`);

    potentialPatterns = [];
    if (localLowsIdx.length >= 3) {
      for (let i = 0; i < localLowsIdx.length - 2; i++) {
        const s1_idx = localLowsIdx[i];
        const h_idx = localLowsIdx[i+1];
        const s2_idx = localLowsIdx[i+2];

        if (h_idx <= s1_idx + ORDER_EXTREMA || s2_idx <= h_idx + ORDER_EXTREMA) {
            // console.log(`[detect-ihs] Skipping S1(${s1_idx}), H(${h_idx}), S2(${s2_idx}) due to insufficient separation.`);
            continue;
        }

        const S1 = candles[s1_idx];
        const H  = candles[h_idx];
        const S2 = candles[s2_idx];

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
            // console.log(`[detect-ihs] Skipping S1(${s1_idx}), H(${h_idx}), S2(${s2_idx}) - Failed to find P1 or P2 between troughs.`);
            continue;
        }

        const P1 = candles[P1_idx];
        const P2 = candles[P2_idx];

        const headLowest = H.low < S1.low && H.low < S2.low;
        const peakMean = (P1.high + P2.high) / 2;
        if (peakMean === 0) continue; // Hindari pembagian dengan nol
        const peakSymmetry = Math.abs(P1.high - P2.high) < PEAK_SYMMETRY_THRESHOLD * peakMean;
        const shoulderMean = (S1.low + S2.low) / 2;
        let shoulderSymmetry = true; 
        if (shoulderMean !== 0) { // Asumsikan simetris jika shoulderMean 0 (misal harga 0, jarang terjadi)
             shoulderSymmetry = Math.abs(S1.low - S2.low) < SHOULDER_SYMMETRY_THRESHOLD * shoulderMean;
        }

        // console.log(`[detect-ihs] Checking Candidate: S1(${s1_idx}, ${S1.low.toFixed(2)}), H(${h_idx}, ${H.low.toFixed(2)}), S2(${s2_idx}, ${S2.low.toFixed(2)}), P1(${P1_idx}, ${P1.high.toFixed(2)}), P2(${P2_idx}, ${P2.high.toFixed(2)})`);
        // console.log(`[detect-ihs] Rules -> headLowest: ${headLowest}, peakSymmetry: ${peakSymmetry}, shoulderSymmetry: ${shoulderSymmetry}`);

        if (headLowest && peakSymmetry && shoulderSymmetry) {
          potentialPatterns.push({
            symbol: symbol.toUpperCase(),
            // message: 'Potensi Pola Inverse Head & Shoulders Teridentifikasi (Formasi)', // Dihapus, status akan diisi setelah breakout
            S1: { timestamp: S1.timestamp, low: S1.low, index: s1_idx },
            P1: { timestamp: P1.timestamp, high: P1.high, index: P1_idx },
            H:  { timestamp: H.timestamp,  low: H.low, index: h_idx  },
            P2: { timestamp: P2.timestamp, high: P2.high, index: P2_idx },
            S2: { timestamp: S2.timestamp, low: S2.low, index: s2_idx },
            patternEndTimestamp: S2.timestamp, // Timestamp dari S2 sebagai akhir formasi
            // debug_rules: { headLowest, peakSymmetry, shoulderSymmetry } // Bisa diaktifkan untuk debug
          });
        //   console.log(`[detect-ihs] Potential IH&S Formation FOUND at Head index ${h_idx}`);
        }
      }
    }


    const confirmedPatterns = [];
    const currentCandleIndex = candles.length - 1; // Indeks candle terbaru yang dianalisis

    for (const pattern of potentialPatterns) {
      const p1_idx = pattern.P1.index;
      const p1_high = pattern.P1.high;
      const p2_idx = pattern.P2.index;
      const p2_high = pattern.P2.high;

      if (p1_idx === p2_idx) { // Puncak tidak boleh di indeks yang sama
        // console.log(`[detect-ihs] Skipping pattern at H(${pattern.H.index}) - P1 and P2 index are identical.`);
        continue;
      }

      // Pastikan p2_idx > p1_idx untuk pembagian yang valid
      if (p2_idx <= p1_idx) {
        // console.log(`[detect-ihs] Skipping pattern at H(${pattern.H.index}) - P2 index not after P1 index.`);
        continue;
      }
      
      const slope = (p2_high - p1_high) / (p2_idx - p1_idx);
      const intercept = p1_high - slope * p1_idx;
      // console.log(`[detect-ihs] Pattern H(${pattern.H.index}) - Neckline: slope=${slope}, intercept=${intercept}`);

      let breakoutCandle = null;
      for (let j = pattern.S2.index + 1; j < candles.length && j <= pattern.S2.index + CANDLES_TO_CHECK_BREAKOUT; j++) {
        const currentCandle = candles[j];
        const necklineValueAtJ = slope * j + intercept;

        // console.log(`[detect-ihs] Checking Breakout: Index ${j}, Close: ${currentCandle.close}, Neckline: ${necklineValueAtJ.toFixed(2)}`);

        if (currentCandle.close > necklineValueAtJ) {
            const buffer = necklineValueAtJ * BREAKOUT_BUFFER_PERCENT;
            if (currentCandle.close > necklineValueAtJ + buffer) {
              // console.log(`[detect-ihs] BREAKOUT DETECTED at index ${j}`);
              breakoutCandle = {
                timestamp: currentCandle.timestamp,
                closePrice: currentCandle.close,
                necklineValue: necklineValueAtJ,
                index: j, 
                volume: currentCandle.volume
              };
              break;
            }
        }
      }

      if (breakoutCandle) {
        // --- BARU: Cek Kesegaran Breakout ---
        const candlesAgo = currentCandleIndex - breakoutCandle.index;
        // Pastikan breakoutCandle.index valid dan tidak di masa depan relatif thd currentCandleIndex
        if (candlesAgo < 0 || candlesAgo >= MAX_CANDLES_AGO_FOR_FRESH_BREAKOUT) { 
            console.log(`[detect-ihs] IH&S for ${symbol} at H(${pattern.H.index}) - Breakout at index ${breakoutCandle.index} is NOT FRESH (${candlesAgo} candles ago). Max allowed: ${MAX_CANDLES_AGO_FOR_FRESH_BREAKOUT -1} candles ago. Skipping.`);
            continue; // Lewati pola ini jika breakout tidak segar
        }
        console.log(`[detect-ihs] IH&S for ${symbol} at H(${pattern.H.index}) - Breakout at index ${breakoutCandle.index} IS FRESH (${candlesAgo} candles ago).`);
        // --- AKHIR PENGECEKAN KESEGARAN ---

        const startVolumeIdx = Math.max(0, breakoutCandle.index - VOLUME_LOOKBACK);
        const volumesBeforeBreakout = candles.slice(startVolumeIdx, breakoutCandle.index).map(c => c.volume);
        const avgVolume = volumesBeforeBreakout.length > 0
                          ? volumesBeforeBreakout.reduce((sum, vol) => sum + vol, 0) / volumesBeforeBreakout.length
                          : 0;
        const isVolumeConfirmed = avgVolume > 0 && breakoutCandle.volume > avgVolume * VOLUME_MULTIPLIER;
        // console.log(`[detect-ihs] Breakout Volume Check: BreakoutVol=${breakoutCandle.volume.toFixed(2)}, AvgVol=${avgVolume.toFixed(2)}, Confirmed=${isVolumeConfirmed}`);

        const necklineValueAtHead = slope * pattern.H.index + intercept;
        const patternHeight = necklineValueAtHead - pattern.H.low;
        let targetPrice = null;
        if (patternHeight > 0) { // Tinggi pola harus positif
            targetPrice = breakoutCandle.necklineValue + patternHeight;
        }
        // console.log(`[detect-ihs] Pattern H(${pattern.H.index}) - Height=${patternHeight.toFixed(2)}, TargetPrice=${targetPrice ? targetPrice.toFixed(2) : 'N/A'}`);
        
        confirmedPatterns.push({
          ...pattern, // Ini sudah berisi S1, P1, H, P2, S2, symbol, patternEndTimestamp
          neckline: { slope, intercept, p1_coords: pattern.P1, p2_coords: pattern.P2 },
          breakoutConfirmation: { ...breakoutCandle, volumeConfirmed, avgVolumeBefore: avgVolume },
          projection: { patternHeight: patternHeight > 0 ? patternHeight : null, targetPrice }, // Hanya simpan tinggi valid
          status: `IH&S Confirmed FRESH Breakout (Vol: ${isVolumeConfirmed ? 'Yes' : 'No'})`
        });
      }
    }


    // Kirim Respons Akhir
    const parametersUsed = {
        order_extrema: ORDER_EXTREMA,
        candles_limit: CANDLES_LIMIT,
        peak_symmetry_threshold: PEAK_SYMMETRY_THRESHOLD,
        shoulder_symmetry_threshold: SHOULDER_SYMMETRY_THRESHOLD,
        candles_to_check_breakout: CANDLES_TO_CHECK_BREAKOUT,
        breakout_buffer_percent: BREAKOUT_BUFFER_PERCENT,
        volume_lookback: VOLUME_LOOKBACK,
        volume_multiplier: VOLUME_MULTIPLIER,
        max_candles_ago_for_fresh_breakout: MAX_CANDLES_AGO_FOR_FRESH_BREAKOUT
    };

    if (confirmedPatterns.length > 0) {
      console.log(`[detect-ihs] Sending response: ${confirmedPatterns.length} FRESH confirmed IH&S patterns for ${symbol.toUpperCase()}.`);
      response.status(200).json({
        message: `Ditemukan ${confirmedPatterns.length} Pola IH&S TERKONFIRMASI (SEGAR) untuk ${symbol.toUpperCase()}.`,
        patterns: confirmedPatterns,
        parameters_used: parametersUsed,
        totalCandlesAnalyzed: candles.length,
        localLowsFound: localLowsIdx.length
      });
    } else {
      console.log(`[detect-ihs] Sending response: No FRESH confirmed IH&S patterns found for ${symbol.toUpperCase()} from ${potentialPatterns.length} potential formations.`);
      response.status(200).json({
        message: `Tidak ada Pola IH&S TERKONFIRMASI (SEGAR) yang terdeteksi untuk ${symbol.toUpperCase()} dari ${potentialPatterns.length} potensi formasi.`,
        potentialFormationsCount: potentialPatterns.length,
        parameters_used: parametersUsed,
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
    if (error.response) {
        errorDetails.upstreamStatus = error.response.status;
        errorDetails.upstreamData = error.response.data;
    }
    response.status(500).json(errorDetails);
  }
}