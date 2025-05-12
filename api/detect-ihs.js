// File: api/detect-ihs.js
import axios from 'axios';

// Helper function to find local minima (troughs)
// data: array of numbers (e.g., low prices)
// order: number of points on each side to compare
function findLocalLows(data, order) {
  const lows = [];
  if (data.length < (2 * order + 1)) {
    return lows; // Not enough data to find extrema with given order
  }
  for (let i = order; i < data.length - order; i++) {
    let isLow = true;
    for (let j = 1; j <= order; j++) {
      if (data[i] > data[i - j] || data[i] > data[i + j]) {
        isLow = false;
        break;
      }
    }
    // Ensure it's strictly the lowest point in the window if multiple same values
    if (isLow) {
        let strictlyLowest = true;
        // Check if it's truly the center of a valley, not a flat bottom part
        if (order > 0 && (data[i] === data[i-1] || data[i] === data[i+1])) {
             // More sophisticated check might be needed for plateaus
             // For simplicity, we ensure it's lower than immediate non-equal neighbors if possible
             if (data[i-1] === data[i] && data[i+1] === data[i] && order === 1) {} // Allow if flat for order 1
             else if (data[i-1] === data[i] && data[i] > data[i+order]) {} // Part of descending slope
             else if (data[i+1] === data[i] && data[i] > data[i-order]) {} // Part of ascending slope
             // This simple version might identify multiple points on a flat bottom.
             // A more robust version would pick the middle of a flat plateau or just one point.
        }
        if (strictlyLowest) lows.push(i);
    }
  }
  return lows;
}

// Helper function to find local maxima (peaks)
// data: array of numbers (e.g., high prices)
// order: number of points on each side to compare
function findLocalHighs(data, order) {
  const highs = [];
   if (data.length < (2 * order + 1)) {
    return highs;
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
        highs.push(i);
    }
  }
  return highs;
}


export default async function handler(request, response) {
  const { symbol } = request.query;

  if (!symbol) {
    return response.status(400).json({ message: 'Parameter "symbol" diperlukan.' });
  }

  const granularity = '1h';
  const limit = 300; // Ambil lebih banyak data seperti yang diminta

  try {
    // 1. Ambil data candlestick
    const candlesResponse = await axios.get(`https://${request.headers.host}/api/get-candles`, {
      params: { symbol, granularity, limit },
    });

    if (!candlesResponse.data || !candlesResponse.data.data || candlesResponse.data.data.length === 0) {
      return response.status(500).json({ message: 'Gagal mengambil data candlestick atau data kosong.' });
    }

    const candles = candlesResponse.data.data; // Array of {timestamp, open, high, low, close, volume}
    
    // Pastikan data cukup untuk analisa
    if (candles.length < 50) { // Minimal data untuk membentuk pola kompleks
        return response.status(400).json({ message: `Data candlestick tidak cukup untuk analisa IH&S, hanya ada ${candles.length} bar.`});
    }

    const lowPrices = candles.map(c => c.low);
    const highPrices = candles.map(c => c.high);
    const closePrices = candles.map(c => c.close); // Untuk konfirmasi breakout nanti

    // 2. Deteksi ekstrem lokal (puncak dan lembah)
    // Order bisa disesuaikan. PDF menggunakan order=3 untuk contoh Python.
    // Order yang lebih kecil lebih sensitif, order lebih besar lebih signifikan.
    const order = 5; // Mari kita coba order yang sedikit lebih besar untuk 1H chart
    const localLowsIdx = findLocalLows(lowPrices, order);
    // const localHighsIdx = findLocalHighs(highPrices, order); // Untuk neckline points nanti

    const potentialPatterns = [];

    // 3. Iterasi untuk menemukan kandidat pola IH&S (S1, H, S2 adalah lembah)
    // Ini adalah implementasi sederhana berdasarkan contoh PDF (mengambil 3 lembah berurutan)
    if (localLowsIdx.length < 3) {
      return response.status(200).json({ message: 'Tidak cukup lembah lokal terdeteksi untuk membentuk IH&S.', data: [] });
    }

    for (let i = 0; i < localLowsIdx.length - 2; i++) {
      const s1_idx = localLowsIdx[i];
      const h_idx = localLowsIdx[i+1];
      const s2_idx = localLowsIdx[i+2];

      // Pastikan indeks valid dan ada cukup ruang di antara lembah untuk puncak
      if (h_idx <= s1_idx || s2_idx <= h_idx) continue;

      const S1 = candles[s1_idx]; // {timestamp, open, high, low, ...}
      const H  = candles[h_idx];
      const S2 = candles[s2_idx];

      // Cari Puncak P1 (antara S1 dan H) dan Puncak P2 (antara H dan S2)
      // P1 adalah harga tertinggi antara S1 dan H
      // P2 adalah harga tertinggi antara H dan S2
      let P1_val = -1, P1_idx = -1;
      for (let j = s1_idx + 1; j < h_idx; j++) {
        if (highPrices[j] > P1_val) {
          P1_val = highPrices[j];
          P1_idx = j;
        }
      }

      let P2_val = -1, P2_idx = -1;
      for (let j = h_idx + 1; j < s2_idx; j++) {
        if (highPrices[j] > P2_val) {
          P2_val = highPrices[j];
          P2_idx = j;
        }
      }
      
      // Jika tidak ditemukan puncak yang valid di antara lembah, lanjutkan
      if (P1_idx === -1 || P2_idx === -1) continue;
      
      const P1 = candles[P1_idx]; // Ini akan error jika P1_idx -1, sudah dihandle
      const P2 = candles[P2_idx];


      // 4. Terapkan Aturan Pola IH&S
      // Aturan 1: Kepala (H) adalah yang terendah
      const headLowest = H.low < S1.low && H.low < S2.low;

      // Aturan 2: Bahu (S1, S2) lebih rendah dari puncak di antaranya (P1, P2)
      // (S1.low < P1.high sudah pasti karena P1 adalah max antara S1 dan H, dan S1 adalah min)
      // (S2.low < P2.high sudah pasti karena P2 adalah max antara H dan S2, dan S2 adalah min)
      // PDF example: A<B and E<D where A,E are S1.low, S2.low and B,D are P1.high, P2.high. This is generally true by definition of how we found P1 and P2.
      // We can add a condition that shoulders should not be too deep relative to the peaks, or that the peaks must be significantly higher.
      // For now, this condition is implicitly met if P1 and P2 are valid peaks between the troughs.

      // Aturan 3: Simetri Puncak (P1 dan P2) - titik-titik neckline
      // Perbedaan tinggi P1 dan P2 < 5% dari rata-rata ketinggian mereka
      const peakSymmetry = Math.abs(P1.high - P2.high) < 0.05 * ((P1.high + P2.high) / 2);
      
      // (Opsional) Aturan 4: Simetri Bahu (S1 dan S2) - kedalaman bahu
      // Perbedaan kedalaman S1 dan S2 < X% (misal 10%) dari rata-rata kedalaman mereka
      // const shoulderSymmetry = Math.abs(S1.low - S2.low) < 0.10 * ((S1.low + S2.low) / 2);


      if (headLowest && peakSymmetry /* && shoulderSymmetry (opsional) */) {
        // Calon pola IH&S ditemukan (belum ada konfirmasi breakout neckline)
        potentialPatterns.push({
          symbol: symbol.toUpperCase(),
          message: 'Potensi Pola Inverse Head & Shoulders Teridentifikasi (Formasi)',
          S1: { timestamp: S1.timestamp, low: S1.low, index: s1_idx },
          P1: { timestamp: P1.timestamp, high: P1.high, index: P1_idx },
          H:  { timestamp: H.timestamp,  low: H.low, index: h_idx  },
          P2: { timestamp: P2.timestamp, high: P2.high, index: P2_idx },
          S2: { timestamp: S2.timestamp, low: S2.low, index: s2_idx },
          necklineApprox: `Connect (${P1.timestamp}, ${P1.high}) and (${P2.timestamp}, ${P2.high})`,
        });
      }
    }

    if (potentialPatterns.length > 0) {
        response.status(200).json({
            message: `Ditemukan ${potentialPatterns.length} potensi formasi IH&S untuk ${symbol.toUpperCase()}.`,
            patterns: potentialPatterns,
            totalCandlesAnalyzed: candles.length,
            localLowsFound: localLowsIdx.length
        });
    } else {
        response.status(200).json({
            message: `Tidak ada potensi formasi IH&S yang terdeteksi untuk ${symbol.toUpperCase()} dengan kriteria saat ini.`,
            totalCandlesAnalyzed: candles.length,
            localLowsFound: localLowsIdx.length
        });
    }

  } catch (error) {
    console.error(`Error in detect-ihs for ${symbol}:`, error.message);
    let errorDetails = {
        message: `Terjadi kesalahan internal saat mencoba mendeteksi pola IH&S untuk ${symbol}.`,
        errorMessage: error.message,
    };
    if (error.response) { // Error dari panggilan axios (misal ke get-candles)
        errorDetails.upstreamStatus = error.response.status;
        errorDetails.upstreamData = error.response.data;
    }
    response.status(500).json(errorDetails);
  }
}