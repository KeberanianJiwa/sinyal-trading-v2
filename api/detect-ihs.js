// File: api/detect-ihs.js
import axios from 'axios';

// Helper function to find local minima (troughs)
// data: array of numbers (e.g., low prices)
// order: number of points on each side to compare
function findLocalLows(data, order) {
  const lowsIndices = [];
  if (data.length < (2 * order + 1)) {
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
    // More robust check for plateaus could be added later if needed.
    if (isLow && !lowsIndices.includes(i)) {
       // Simple filter for flat bottoms: only add if it's lower than the immediate previous point,
       // or if the immediate previous point has the same value but wasn't the last added low.
       // This tries to select the start of a flat bottom.
       if (i > 0 && data[i] < data[i-1]) {
           lowsIndices.push(i);
       } else if (i > 0 && data[i] === data[i-1]) {
           const lastAddedLow = lowsIndices.length > 0 ? lowsIndices[lowsIndices.length-1] : -1;
           if (lastAddedLow !== i-1) { // Only add if the previous equal point wasn't the last one added
               lowsIndices.push(i);
           }
       } else if (i===order) { // First possible point
           lowsIndices.push(i);
       }
       // Note: This plateau handling is basic. May need refinement based on testing.
    }
  }
  return lowsIndices;
}

// Helper function to find local maxima (peaks) - needed if calculating P1/P2 differently
// For now, P1/P2 are calculated as max highs between troughs, so this function isn't strictly needed by the main loop below
function findLocalHighs(data, order) {
  const highsIndices = [];
   if (data.length < (2 * order + 1)) {
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
     if (isHigh && !highsIndices.includes(i)) {
       if (i > 0 && data[i] > data[i-1]) {
           highsIndices.push(i);
       } else if (i > 0 && data[i] === data[i-1]) {
           const lastAddedHigh = highsIndices.length > 0 ? highsIndices[highsIndices.length-1] : -1;
           if (lastAddedHigh !== i-1) {
               highsIndices.push(i);
           }
       } else if (i === order) {
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

  const granularity = '1h';
  const limit = 300; // Ambil lebih banyak data
  let localLowsIdx = []; // Make it accessible for the final response
  let potentialPatterns = []; // Make it accessible for the final response

  try {
    // 1. Ambil data candlestick
    console.log(`[detect-ihs] Fetching candles for ${symbol}...`);
    // Construct the absolute URL for the API call within Vercel
    const protocol = request.headers['x-forwarded-proto'] || 'http';
    const host = request.headers.host;
    const candleApiUrl = `${protocol}://${host}/api/get-candles`;

    const candlesResponse = await axios.get(candleApiUrl, {
      params: { symbol, granularity, limit },
      headers: {
         // Forward necessary headers if needed, e.g., for auth in the future
         'Accept': 'application/json'
      }
    });

    if (!candlesResponse.data || !candlesResponse.data.data || candlesResponse.data.data.length === 0) {
      console.error(`[detect-ihs] Gagal mengambil data candlestick atau data kosong untuk ${symbol}. Response:`, candlesResponse.data);
      return response.status(500).json({ message: `Gagal mengambil data candlestick atau data kosong untuk ${symbol}.` });
    }

    const candles = candlesResponse.data.data; // Array of {timestamp, open, high, low, close, volume}
    console.log(`[detect-ihs] Berhasil mengambil ${candles.length} candles.`);

    // Pastikan data cukup untuk analisa
    if (candles.length < 50) { // Arbitrary minimum, adjust as needed
        return response.status(400).json({ message: `Data candlestick tidak cukup untuk analisa IH&S, hanya ada ${candles.length} bar.`});
    }

    const lowPrices = candles.map(c => c.low);
    const highPrices = candles.map(c => c.high);
    const closePrices = candles.map(c => c.close);
    const timestamps = candles.map(c => c.timestamp);

    // 2. Deteksi ekstrem lokal (lembah)
    const order = 5; // Order untuk deteksi ekstrem lokal (bisa disesuaikan)
    localLowsIdx = findLocalLows(lowPrices, order);
    console.log(`[detect-ihs] Ditemukan ${localLowsIdx.length} lembah lokal dengan order ${order}.`);


    // 3. Iterasi untuk menemukan kandidat pola IH&S (S1, H, S2 adalah lembah)
    potentialPatterns = []; // Reset potential patterns array
    if (localLowsIdx.length >= 3) {
      for (let i = 0; i < localLowsIdx.length - 2; i++) {
        const s1_idx = localLowsIdx[i];
        const h_idx = localLowsIdx[i+1];
        const s2_idx = localLowsIdx[i+2];

        // Pastikan indeks valid dan ada cukup ruang di antara lembah untuk puncak
        if (h_idx <= s1_idx + order || s2_idx <= h_idx + order) { // Ensure some separation based on order
           console.log(`[detect-ihs] Skipping S1(${s1_idx}), H(${h_idx}), S2(${s2_idx}) due to insufficient separation.`);
           continue;
        }

        const S1 = candles[s1_idx];
        const H  = candles[h_idx];
        const S2 = candles[s2_idx];

        // Cari Puncak P1 (antara S1 dan H) dan Puncak P2 (antara H dan S2)
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
           continue; // Tidak ada puncak valid di antara lembah
        }

        const P1 = candles[P1_idx];
        const P2 = candles[P2_idx];

        // 4. Terapkan Aturan Pola IH&S
        const headLowest = H.low < S1.low && H.low < S2.low;
        // Toleransi kecil jika bahu hampir sama dengan kepala (misal, 0.1%) - opsional
        // const tolerance = H.low * 0.001;
        // const headLowest = (H.low <= S1.low + tolerance) && (H.low <= S2.low + tolerance) && (H.low < S1.low || H.low < S2.low);


        // Simetri Puncak (P1 dan P2) - titik-titik neckline
        const peakMean = (P1.high + P2.high) / 2;
        if (peakMean === 0) continue; // Avoid division by zero if peaks are at 0
        const peakSymmetryThreshold = 0.05; // 5% tolerance
        const peakSymmetry = Math.abs(P1.high - P2.high) < peakSymmetryThreshold * peakMean;

        // (Opsional) Simetri Bahu (S1 dan S2)
        // const shoulderMean = (S1.low + S2.low) / 2;
        // if (shoulderMean === 0) continue;
        // const shoulderSymmetryThreshold = 0.10; // 10% tolerance
        // const shoulderSymmetry = Math.abs(S1.low - S2.low) < shoulderSymmetryThreshold * shoulderMean;

        console.log(`[detect-ihs] Checking Candidate: S1(${s1_idx}, ${S1.low}), H(${h_idx}, ${H.low}), S2(${s2_idx}, ${S2.low}), P1(${P1_idx}, ${P1.high}), P2(${P2_idx}, ${P2.high})`);
        console.log(`[detect-ihs] Rules -> headLowest: ${headLowest}, peakSymmetry: ${peakSymmetry}`);


        if (headLowest && peakSymmetry /* && shoulderSymmetry (opsional) */) {
          potentialPatterns.push({
            symbol: symbol.toUpperCase(),
            message: 'Potensi Pola Inverse Head & Shoulders Teridentifikasi (Formasi)',
            S1: { timestamp: S1.timestamp, low: S1.low, index: s1_idx },
            P1: { timestamp: P1.timestamp, high: P1.high, index: P1_idx },
            H:  { timestamp: H.timestamp,  low: H.low, index: h_idx  },
            P2: { timestamp: P2.timestamp, high: P2.high, index: P2_idx },
            S2: { timestamp: S2.timestamp, low: S2.low, index: s2_idx },
          });
           console.log(`[detect-ihs] Potential IH&S Formation FOUND at Head index ${h_idx}`);
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
        continue; // Indeks sama, tidak bisa membentuk garis
      }

      // Hitung slope (m) dan intercept (c) dari neckline
      const slope = (p2_high - p1_high) / (p2_idx - p1_idx);
      const intercept = p1_high - slope * p1_idx;
      console.log(`[detect-ihs] Pattern H(${pattern.H.index}) - Neckline: slope=${slope}, intercept=${intercept}`);

      // Deteksi Breakout setelah S2
      const candlesToCheckForBreakout = 15; // Periksa N candle setelah S2 (bisa disesuaikan)
      let breakoutCandle = null;

      // Mulai cek dari candle setelah S2
      for (let j = pattern.S2.index + 1; j < candles.length && j <= pattern.S2.index + candlesToCheckForBreakout; j++) {
        const currentCandle = candles[j];
        const necklineValueAtJ = slope * j + intercept; // Nilai neckline pada indeks candle j

        console.log(`[detect-ihs] Checking Breakout: Index ${j}, Close: ${currentCandle.close}, Neckline: ${necklineValueAtJ.toFixed(2)}`);

        // Kondisi Breakout: Harga penutupan di atas nilai neckline
        if (currentCandle.close > necklineValueAtJ) {
          // Opsional: Tambahkan buffer untuk "decisive" breakout (misal, 0.1%)
           const buffer = necklineValueAtJ * 0.001;
           if (currentCandle.close > necklineValueAtJ + buffer) {
              console.log(`[detect-ihs] BREAKOUT DETECTED at index ${j}`);
              breakoutCandle = {
                timestamp: currentCandle.timestamp,
                closePrice: currentCandle.close,
                necklineValue: necklineValueAtJ,
                index: j,
                volume: currentCandle.volume // Simpan volume breakout
              };
              break; // Breakout pertama ditemukan
           } else {
              console.log(`[detect-ihs] Close price above neckline but within buffer at index ${j}`);
           }
        }
      } // End loop checking for breakout

      if (breakoutCandle) {
        // (Opsional) Cek Volume saat breakout
        // Hitung rata-rata volume N candle sebelum S2 atau sebelum breakout
        const lookbackVolume = 20;
        const startVolumeIdx = Math.max(0, breakoutCandle.index - lookbackVolume);
        const volumesBeforeBreakout = candles.slice(startVolumeIdx, breakoutCandle.index).map(c => c.volume);
        const avgVolume = volumesBeforeBreakout.reduce((sum, vol) => sum + vol, 0) / volumesBeforeBreakout.length;
        const volumeMultiplier = 1.5; // Harus N kali lebih besar dari rata-rata (misal 1.5x)
        const isVolumeConfirmed = breakoutCandle.volume > avgVolume * volumeMultiplier;
        console.log(`[detect-ihs] Breakout Volume Check: BreakoutVol=${breakoutCandle.volume.toFixed(2)}, AvgVol=${avgVolume.toFixed(2)}, Confirmed=${isVolumeConfirmed} (Threshold ${volumeMultiplier}x)`);


        confirmedPatterns.push({
          ...pattern, // Data formasi S1, P1, H, P2, S2
          neckline: {
            slope: slope,
            intercept: intercept,
            p1_coords: { index: p1_idx, high: p1_high, timestamp: pattern.P1.timestamp },
            p2_coords: { index: p2_idx, high: p2_high, timestamp: pattern.P2.timestamp },
          },
          breakoutConfirmation: {
             ...breakoutCandle,
             volumeConfirmed: isVolumeConfirmed // Tambahkan status konfirmasi volume
          },
          status: "IH&S Confirmed with Breakout"
        });
      } else {
          console.log(`[detect-ihs] Pattern H(${pattern.H.index}) - No breakout found within ${candlesToCheckForBreakout} candles after S2.`);
      }
    } // End loop through potential patterns


    // 6. Kirim Respons Akhir
    if (confirmedPatterns.length > 0) {
        console.log(`[detect-ihs] Sending response: ${confirmedPatterns.length} confirmed patterns.`);
        response.status(200).json({
            message: `Ditemukan ${confirmedPatterns.length} Pola IH&S TERKONFIRMASI untuk ${symbol.toUpperCase()}.`,
            patterns: confirmedPatterns,
            totalCandlesAnalyzed: candles.length,
            localLowsFound: localLowsIdx.length
        });
    } else {
        console.log(`[detect-ihs] Sending response: No confirmed patterns found.`);
        response.status(200).json({
            message: `Tidak ada Pola IH&S TERKONFIRMASI (dengan breakout) yang terdeteksi untuk ${symbol.toUpperCase()} dari ${potentialPatterns.length} potensi formasi.`,
            potentialFormationsCount: potentialPatterns.length,
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
    }
    response.status(500).json(errorDetails);
  }
}