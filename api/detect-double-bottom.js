// File: api/detect-double-bottom.js
import axios from 'axios';

// Helper function to find local minima (troughs) - sama seperti di detect-ihs.js
function findLocalLows(data, order) {
  const lowsIndices = [];
  if (data.length < (2 * order + 1)) {
    console.warn(`[findLocalLowsDB] Not enough data (${data.length}) to find lows with order ${order}`);
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

export default async function handler(request, response) {
  const { symbol } = request.query;

  if (!symbol) {
    return response.status(400).json({ message: 'Parameter "symbol" diperlukan.' });
  }

  // --- Parameter Tuning untuk Double Bottom ---
  const ORDER_EXTREMA_DB = 5; // Order untuk deteksi lembah
  const CANDLES_LIMIT_DB = 300; // Jumlah candle yang diambil
  const TROUGH_EQUALITY_THRESHOLD = 0.03; // Maks selisih kedalaman dua bottom (3%) [cite: 5, 6]
  const MIN_PEAK_RISE_FROM_BOTTOM1_PERCENT = 0.05; // Min kenaikan dari Bottom1 ke Puncak (5%) - PDF menyarankan 10-20%[cite: 10], kita bisa naikkan ini
  const MIN_TROUGH_DISTANCE = 10; // Jarak minimal antar bottom (jumlah candle)
  const MAX_TROUGH_DISTANCE = 100; // Jarak maksimal antar bottom (jumlah candle)
  const CANDLES_TO_CHECK_BREAKOUT_DB = 15; // Jumlah candle setelah E2 untuk cek breakout
  const BREAKOUT_BUFFER_PERCENT_DB = 0.001; // Buffer breakout (0.1%) di atas neckline
  const VOLUME_LOOKBACK_DB = 30; // Periode rata-rata volume
  const VOLUME_MULTIPLIER_DB = 1.3; // Pengali volume breakout
  // --- End of Parameter Tuning ---

  let localLowsIdx = [];
  let potentialPatterns = [];

  try {
    console.log(`[detect-db] Fetching ${CANDLES_LIMIT_DB} candles for ${symbol}...`);
    const protocol = request.headers['x-forwarded-proto'] || 'http';
    const host = request.headers.host;
    const candleApiUrl = `${protocol}://${host}/api/get-candles`;

    const candlesResponse = await axios.get(candleApiUrl, {
      params: { symbol: symbol.toUpperCase(), granularity: '1h', limit: CANDLES_LIMIT_DB },
      headers: { 'Accept': 'application/json' }
    });

    if (!candlesResponse.data || !candlesResponse.data.data || candlesResponse.data.data.length === 0) {
      console.error(`[detect-db] Gagal mengambil data candlestick atau data kosong untuk ${symbol}.`);
      return response.status(500).json({ message: `Gagal mengambil data candlestick atau data kosong untuk ${symbol}.` });
    }

    const candles = candlesResponse.data.data;
    console.log(`[detect-db] Berhasil mengambil ${candles.length} candles.`);

    if (candles.length < MIN_TROUGH_DISTANCE + ORDER_EXTREMA_DB * 2) { // Perlu data cukup
        return response.status(400).json({ message: `Data candlestick tidak cukup untuk analisa Double Bottom, hanya ada ${candles.length} bar.`});
    }

    const lowPrices = candles.map(c => c.low);
    const highPrices = candles.map(c => c.high);

    localLowsIdx = findLocalLows(lowPrices, ORDER_EXTREMA_DB);
    console.log(`[detect-db] Ditemukan ${localLowsIdx.length} lembah lokal dengan order ${ORDER_EXTREMA_DB}.`);

    potentialPatterns = [];
    if (localLowsIdx.length >= 2) {
      for (let i = 0; i < localLowsIdx.length - 1; i++) {
        for (let j = i + 1; j < localLowsIdx.length; j++) {
          const E1_idx = localLowsIdx[i];
          const E2_idx = localLowsIdx[j];

          const E1 = candles[E1_idx];
          const E2 = candles[E2_idx];

          // 1. Cek Jarak Waktu Antar Lembah
          const troughDistance = E2_idx - E1_idx;
          if (troughDistance < MIN_TROUGH_DISTANCE || troughDistance > MAX_TROUGH_DISTANCE) {
            continue;
          }

          // 2. Cek Kesetaraan Kedalaman Lembah (Bottom Equality)
          if (E1.low === 0) continue; // Hindari pembagian dengan nol
          const depthDifference = Math.abs(E1.low - E2.low) / E1.low;
          if (depthDifference > TROUGH_EQUALITY_THRESHOLD) {
            continue;
          }

          // 3. Temukan Puncak (P) di Antara E1 dan E2
          let P_val = -Infinity, P_idx = -1;
          for (let k = E1_idx + 1; k < E2_idx; k++) {
            if (highPrices[k] > P_val) {
              P_val = highPrices[k];
              P_idx = k;
            }
          }

          if (P_idx === -1) { // Tidak ada puncak di antara E1 dan E2
            continue;
          }
          const P = candles[P_idx];

          // 4. Cek Kenaikan Signifikan dari E1 ke Puncak P
          const peakRiseFromE1 = (P.high - E1.low) / E1.low;
          if (peakRiseFromE1 < MIN_PEAK_RISE_FROM_BOTTOM1_PERCENT) {
            continue;
          }
          
          console.log(`[detect-db] Potential DB: E1(${E1_idx}, ${E1.low.toFixed(2)}), P(${P_idx}, ${P.high.toFixed(2)}), E2(${E2_idx}, ${E2.low.toFixed(2)})`);
          console.log(`[detect-db] Rules -> troughDist: ${troughDistance}, depthDiff: ${depthDifference.toFixed(3)}, peakRise: ${peakRiseFromE1.toFixed(3)}`);

          potentialPatterns.push({
            symbol: symbol.toUpperCase(),
            message: 'Potensi Pola Double Bottom Teridentifikasi (Formasi)',
            E1: { timestamp: E1.timestamp, low: E1.low, index: E1_idx },
            P_Neckline: { timestamp: P.timestamp, high: P.high, index: P_idx },
            E2: { timestamp: E2.timestamp, low: E2.low, index: E2_idx },
            debug_rules: { troughDistance, depthDifference, peakRiseFromE1 }
          });
        }
      }
    } // End of loops for potential patterns

    // 5. Cek Breakout untuk setiap potensi pola
    const confirmedPatterns = [];
    for (const pattern of potentialPatterns) {
      const necklineLevel = pattern.P_Neckline.high;
      const necklineIndex = pattern.P_Neckline.index;

      let breakoutCandle = null;
      // Mulai cek dari candle setelah E2
      for (let k = pattern.E2.index + 1; k < candles.length && k <= pattern.E2.index + CANDLES_TO_CHECK_BREAKOUT_DB; k++) {
        const currentCandle = candles[k];
        console.log(`[detect-db] Checking Breakout DB: Index ${k}, Close: ${currentCandle.close}, Neckline Level: ${necklineLevel.toFixed(2)}`);

        if (currentCandle.close > necklineLevel) {
           const buffer = necklineLevel * BREAKOUT_BUFFER_PERCENT_DB;
           if (currentCandle.close > necklineLevel + buffer) {
              console.log(`[detect-db] DB BREAKOUT DETECTED at index ${k}`);
              breakoutCandle = {
                timestamp: currentCandle.timestamp,
                closePrice: currentCandle.close,
                necklineValue: necklineLevel, // Neckline horizontal
                index: k,
                volume: currentCandle.volume
              };
              break;
           } else {
              console.log(`[detect-db] DB Close price above neckline but within buffer at index ${k}`);
           }
        }
      } // End loop checking for breakout

      if (breakoutCandle) {
        const startVolumeIdx = Math.max(0, breakoutCandle.index - VOLUME_LOOKBACK_DB);
        const volumesBeforeBreakout = candles.slice(startVolumeIdx, breakoutCandle.index).map(c => c.volume);
        const avgVolume = volumesBeforeBreakout.length > 0
                           ? volumesBeforeBreakout.reduce((sum, vol) => sum + vol, 0) / volumesBeforeBreakout.length
                           : 0;
        const isVolumeConfirmed = avgVolume > 0 && breakoutCandle.volume > avgVolume * VOLUME_MULTIPLIER_DB;
        console.log(`[detect-db] DB Breakout Volume Check: BreakoutVol=${breakoutCandle.volume.toFixed(2)}, AvgVol(${VOLUME_LOOKBACK_DB} candles)=${avgVolume.toFixed(2)}, Confirmed=${isVolumeConfirmed} (Threshold ${VOLUME_MULTIPLIER_DB}x)`);

        // Hitung Target Harga
        const patternHeight = necklineLevel - Math.min(pattern.E1.low, pattern.E2.low); // Tinggi dari bottom terendah ke neckline
        let targetPrice = null;
        if (patternHeight > 0) {
            targetPrice = necklineLevel + patternHeight; // Target = Neckline + Tinggi Pola
        }
        console.log(`[detect-db] DB Pattern E2(${pattern.E2.index}) - Height=${patternHeight.toFixed(2)}, TargetPrice=${targetPrice ? targetPrice.toFixed(2) : 'N/A'}`);

        confirmedPatterns.push({
          ...pattern,
          breakoutConfirmation: {
             ...breakoutCandle,
             volumeConfirmed: isVolumeConfirmed,
             avgVolumeBefore: avgVolume
          },
          projection: {
              patternHeight: patternHeight,
              targetPrice: targetPrice
          },
          status: "Double Bottom Confirmed with Breakout"
        });
      } else {
          console.log(`[detect-db] DB Pattern E2(${pattern.E2.index}) - No breakout found within ${CANDLES_TO_CHECK_BREAKOUT_DB} candles after E2.`);
      }
    } // End loop through potential patterns

    // 6. Kirim Respons Akhir
    const parametersUsed = {
        order_extrema: ORDER_EXTREMA_DB,
        candles_limit: CANDLES_LIMIT_DB,
        trough_equality_threshold: TROUGH_EQUALITY_THRESHOLD,
        min_peak_rise_from_bottom1_percent: MIN_PEAK_RISE_FROM_BOTTOM1_PERCENT,
        min_trough_distance: MIN_TROUGH_DISTANCE,
        max_trough_distance: MAX_TROUGH_DISTANCE,
        candles_to_check_breakout: CANDLES_TO_CHECK_BREAKOUT_DB,
        breakout_buffer_percent: BREAKOUT_BUFFER_PERCENT_DB,
        volume_lookback: VOLUME_LOOKBACK_DB,
        volume_multiplier: VOLUME_MULTIPLIER_DB
    };

    if (confirmedPatterns.length > 0) {
        console.log(`[detect-db] Sending response: ${confirmedPatterns.length} confirmed Double Bottom patterns.`);
        response.status(200).json({
            message: `Ditemukan ${confirmedPatterns.length} Pola Double Bottom TERKONFIRMASI untuk ${symbol.toUpperCase()}.`,
            patterns: confirmedPatterns,
            parameters_used: parametersUsed,
            totalCandlesAnalyzed: candles.length,
            localLowsFound: localLowsIdx.length
        });
    } else {
        console.log(`[detect-db] Sending response: No confirmed Double Bottom patterns found.`);
        response.status(200).json({
            message: `Tidak ada Pola Double Bottom TERKONFIRMASI (dengan breakout) yang terdeteksi untuk ${symbol.toUpperCase()} dari ${potentialPatterns.length} potensi formasi.`,
            potentialFormationsCount: potentialPatterns.length,
            parameters_used: parametersUsed,
            totalCandlesAnalyzed: candles.length,
            localLowsFound: localLowsIdx.length
        });
    }

  } catch (error) {
    console.error(`[detect-db] Critical Error for ${symbol}:`, error.message, error.stack);
    let errorDetails = {
        message: `Terjadi kesalahan internal saat mencoba mendeteksi pola Double Bottom untuk ${symbol}.`,
        errorMessage: error.message,
    };
    if (error.response) {
        console.error(`[detect-db] Upstream error from /api/get-candles: Status=${error.response.status}`, error.response.data);
        errorDetails.upstreamStatus = error.response.status;
        errorDetails.upstreamData = error.response.data;
    } else {
        console.error(`[detect-db] Non-axios error:`, error);
    }
    response.status(500).json(errorDetails);
  }
}