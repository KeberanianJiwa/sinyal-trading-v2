// File: api/detect-ascending-triangle.js
import axios from 'axios';

// --- Helper Functions (Sama seperti sebelumnya) ---
function findLocalLows(data, order) {
  const lowsIndices = []; if (data.length < (2*order+1)) return lowsIndices;
  for (let i=order; i<data.length-order; i++) { let isLow=true; for(let j=1; j<=order; j++) { if(data[i]>data[i-j]||data[i]>data[i+j]){isLow=false; break;}} if(isLow){const l=lowsIndices.length>0?lowsIndices[lowsIndices.length-1]:-1; if(!lowsIndices.includes(i)&&!(l===i-1&&data[i]===data[l])){lowsIndices.push(i);}}} return lowsIndices;}
function findLocalHighs(data, order) {
  const highsIndices = []; if (data.length < (2*order+1)) return highsIndices;
  for (let i=order; i<data.length-order; i++) { let isHigh=true; for(let j=1; j<=order; j++) { if(data[i]<data[i-j]||data[i]<data[i+j]){isHigh=false; break;}} if(isHigh){const l=highsIndices.length>0?highsIndices[highsIndices.length-1]:-1; if(!highsIndices.includes(i)&&!(l===i-1&&data[i]===data[l])){highsIndices.push(i);}}} return highsIndices;}
function simpleLinearRegression(x, y) { const n=x.length; if(n<2||n!==y.length) return null; let sx=0,sy=0,sxy=0,sxx=0; for(let i=0;i<n;i++){sx+=x[i];sy+=y[i];sxy+=x[i]*y[i];sxx+=x[i]*x[i];} const d=n*sxx-sx*sx; if(Math.abs(d)<1e-10) return null; const m=(n*sxy-sx*sy)/d; const c=(sy-m*sx)/n; return {slope:m, intercept:c};}
// --- End Helper Functions ---

export default async function handler(request, response) {
  const { symbol } = request.query;
  if (!symbol) return response.status(400).json({ message: 'Parameter "symbol" diperlukan.' });

  // --- Parameter Tuning untuk Ascending Triangle ---
  const ORDER_EXTREMA_AT = 5;
  const CANDLES_LIMIT_AT = 300;
  const RESISTANCE_LEVEL_TOLERANCE = 0.01; // Maks persentase perbedaan antar high di resistance (1%)
  const MIN_HIGHS_FOR_RESISTANCE = 2;
  const MIN_LOWS_FOR_SUPPORT = 2;
  const MIN_SUPPORT_SLOPE = 0.00001; // Slope support harus positif
  const MIN_PATTERN_DURATION_AT = 20;
  const CANDLES_TO_CHECK_BREAKOUT_AT = 15;
  const BREAKOUT_BUFFER_PERCENT_AT = 0.001; // Buffer breakout (0.1%) di atas resistance
  const VOLUME_LOOKBACK_AT = 30;
  const VOLUME_MULTIPLIER_AT = 1.5; // Volume breakout harus > N kali rata-rata
  const TOUCH_TOLERANCE_PERCENT_AT = 0.005; // Toleransi sentuhan
  // --- End of Parameter Tuning ---

  let localLowsIdx = [];
  let localHighsIdx = [];
  let potentialPatterns = [];

  try {
    console.log(`[detect-at] Fetching ${CANDLES_LIMIT_AT} candles for ${symbol}...`);
    const protocol = request.headers['x-forwarded-proto'] || 'http';
    const host = request.headers.host;
    const candleApiUrl = `${protocol}://${host}/api/get-candles`;
    const candlesResponse = await axios.get(candleApiUrl, { params: { symbol: symbol.toUpperCase(), granularity: '1h', limit: CANDLES_LIMIT_AT }, headers: { 'Accept': 'application/json' }});

    if (!candlesResponse.data || !candlesResponse.data.data || candlesResponse.data.data.length < MIN_PATTERN_DURATION_AT) {
        return response.status(500).json({ message: `Gagal mengambil data candlestick atau data tidak cukup (${candlesResponse.data?.data?.length || 0} candles) untuk ${symbol}.` });
    }
    const candles = candlesResponse.data.data;
    console.log(`[detect-at] Berhasil mengambil ${candles.length} candles.`);
    const lowPrices = candles.map(c => c.low);
    const highPrices = candles.map(c => c.high);

    localLowsIdx = findLocalLows(lowPrices, ORDER_EXTREMA_AT);
    localHighsIdx = findLocalHighs(highPrices, ORDER_EXTREMA_AT);
    console.log(`[detect-at] Ditemukan ${localLowsIdx.length} lows & ${localHighsIdx.length} highs dengan order ${ORDER_EXTREMA_AT}.`);

    potentialPatterns = [];
    // Pendekatan: Cari kandidat resistance horizontal dulu, lalu cari support menanjak di bawahnya.
    for (let i = 0; i < localHighsIdx.length - (MIN_HIGHS_FOR_RESISTANCE - 1); i++) {
        const resistanceHighsIndices = [localHighsIdx[i]];
        const resistanceHighsValues = [highPrices[localHighsIdx[i]]];

        // Cari puncak berikutnya yang levelnya dekat
        for (let j = i + 1; j < localHighsIdx.length; j++) {
            const currentHighIdx = localHighsIdx[j];
            const currentHighVal = highPrices[currentHighIdx];
            const firstHighVal = resistanceHighsValues[0];
            if (firstHighVal === 0) continue;

            if (Math.abs(currentHighVal - firstHighVal) / firstHighVal <= RESISTANCE_LEVEL_TOLERANCE) {
                resistanceHighsIndices.push(currentHighIdx);
                resistanceHighsValues.push(currentHighVal);
            }
        }

        // Jika cukup puncak untuk membentuk resistance horizontal
        if (resistanceHighsIndices.length >= MIN_HIGHS_FOR_RESISTANCE) {
            const avgResistanceLevel = resistanceHighsValues.reduce((s, v) => s + v, 0) / resistanceHighsValues.length;
            const firstResistanceIdx = resistanceHighsIndices[0];
            const lastResistanceIdx = resistanceHighsIndices[resistanceHighsIndices.length - 1];

            // Cari lembah menanjak di bawah level resistance ini
            // Ambil lembah yang relevan secara kronologis
            const relevantLowsIndices = localLowsIdx.filter(lIdx => lIdx >= firstResistanceIdx && lIdx <= lastResistanceIdx && lowPrices[lIdx] < avgResistanceLevel);

            if (relevantLowsIndices.length >= MIN_LOWS_FOR_SUPPORT) {
                // Cek apakah lembah-lembah ini menanjak (higher lows)
                let isAscending = true;
                for (let l = 0; l < relevantLowsIndices.length - 1; l++) {
                    if (lowPrices[relevantLowsIndices[l+1]] <= lowPrices[relevantLowsIndices[l]]) {
                        isAscending = false;
                        break;
                    }
                }

                if (isAscending) {
                    // Fit garis regresi pada lembah-lembah ini
                    const supportX = relevantLowsIndices;
                    const supportY = relevantLowsIndices.map(idx => lowPrices[idx]);
                    const supportLine = simpleLinearRegression(supportX, supportY);

                    // Cek slope positif & konvergensi (support di bawah resistance di awal)
                    if (supportLine && supportLine.slope > MIN_SUPPORT_SLOPE) {
                         const supportAtStart = supportLine.slope * firstResistanceIdx + supportLine.intercept;
                         if (supportAtStart < avgResistanceLevel) { // Memastikan garis converge dan support di bawah
                            console.log(`[detect-at] Potential AT found: Resistance ~${avgResistanceLevel.toFixed(2)} [${resistanceHighsIndices.join(',')}] Support slope ${supportLine.slope.toFixed(4)} [${relevantLowsIndices.join(',')}]`);
                            potentialPatterns.push({
                                symbol: symbol.toUpperCase(),
                                message: 'Potensi Pola Ascending Triangle Teridentifikasi (Formasi)',
                                resistanceLevel: avgResistanceLevel,
                                resistanceIndices: resistanceHighsIndices,
                                supportLine: supportLine,
                                supportIndices: relevantLowsIndices,
                                patternStartIndex: Math.min(firstResistanceIdx, relevantLowsIndices[0]),
                                patternEndIndex: Math.max(lastResistanceIdx, relevantLowsIndices[relevantLowsIndices.length-1])
                            });
                         }
                    }
                }
            }
        }
    } // End of loop searching for patterns


    // Cek Breakout untuk setiap potensi pola
    const confirmedPatterns = [];
     // Hapus duplikat potensial berdasarkan end index (jika ada overlap window/pencarian)
    const uniquePotentialPatterns = potentialPatterns.filter((p, index, self) =>
        index === self.findIndex((t) => t.patternEndIndex === p.patternEndIndex)
    );
    uniquePotentialPatterns.sort((a, b) => a.patternEndIndex - b.patternEndIndex);


    for (const pattern of uniquePotentialPatterns) {
      const resistanceLevel = pattern.resistanceLevel;
      const lastPatternIndex = pattern.patternEndIndex;

      let breakoutCandle = null;
      for (let k = lastPatternIndex + 1; k < candles.length && k <= lastPatternIndex + CANDLES_TO_CHECK_BREAKOUT_AT; k++) {
        const currentCandle = candles[k];
        console.log(`[detect-at] Checking Breakout AT: Index ${k}, Close: ${currentCandle.close}, Resistance Level: ${resistanceLevel.toFixed(2)}`);

        // Kondisi Breakout: Harga penutupan di atas level resistance
        if (currentCandle.close > resistanceLevel) {
           const buffer = resistanceLevel * BREAKOUT_BUFFER_PERCENT_AT;
           if (currentCandle.close > resistanceLevel + buffer) {
              console.log(`[detect-at] AT BREAKOUT DETECTED at index ${k}`);
              breakoutCandle = {
                timestamp: currentCandle.timestamp,
                closePrice: currentCandle.close,
                resistanceLevelBroken: resistanceLevel,
                index: k,
                volume: currentCandle.volume
              };
              break;
           } else {
              console.log(`[detect-at] AT Close price above resistance but within buffer at index ${k}`);
           }
        }
      } // End loop checking for breakout

      if (breakoutCandle) {
        const startVolumeIdx = Math.max(0, breakoutCandle.index - VOLUME_LOOKBACK_AT);
        const volumesBeforeBreakout = candles.slice(startVolumeIdx, breakoutCandle.index).map(c => c.volume);
        const avgVolume = volumesBeforeBreakout.length > 0 ? volumesBeforeBreakout.reduce((sum, vol) => sum + vol, 0) / volumesBeforeBreakout.length : 0;
        const isVolumeConfirmed = avgVolume > 0 && breakoutCandle.volume > avgVolume * VOLUME_MULTIPLIER_AT;
        console.log(`[detect-at] AT Breakout Volume Check: BreakoutVol=${breakoutCandle.volume.toFixed(2)}, AvgVol(${VOLUME_LOOKBACK_AT} candles)=${avgVolume.toFixed(2)}, Confirmed=${isVolumeConfirmed} (Threshold ${VOLUME_MULTIPLIER_AT}x)`);

        // Hitung Target Harga
        // Tinggi pola = Level Resistance - Lembah terendah pertama dalam pola
        const firstSupportLowIndex = pattern.supportIndices[0];
        const patternHeight = resistanceLevel - lowPrices[firstSupportLowIndex];
        let targetPrice = null;
        if (patternHeight > 0) {
            targetPrice = resistanceLevel + patternHeight; // Target = Resistance + Tinggi Pola
        }
        console.log(`[detect-at] AT Pattern Ends(${lastPatternIndex}) - Height=${patternHeight.toFixed(2)}, TargetPrice=${targetPrice ? targetPrice.toFixed(2) : 'N/A'}`);

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
          status: "Ascending Triangle Confirmed with Breakout"
        });
      } else {
          console.log(`[detect-at] AT Pattern Ends(${lastPatternIndex}) - No breakout found within ${CANDLES_TO_CHECK_BREAKOUT_AT} candles.`);
      }
    } // End loop through potential patterns


    // Kirim Respons Akhir
    const parametersUsed = {
        order_extrema: ORDER_EXTREMA_AT, candles_limit: CANDLES_LIMIT_AT, resistance_level_tolerance: RESISTANCE_LEVEL_TOLERANCE,
        min_highs_for_resistance: MIN_HIGHS_FOR_RESISTANCE, min_lows_for_support: MIN_LOWS_FOR_SUPPORT, min_support_slope: MIN_SUPPORT_SLOPE,
        min_pattern_duration: MIN_PATTERN_DURATION_AT, candles_to_check_breakout: CANDLES_TO_CHECK_BREAKOUT_AT,
        breakout_buffer_percent: BREAKOUT_BUFFER_PERCENT_AT, volume_lookback: VOLUME_LOOKBACK_AT, volume_multiplier: VOLUME_MULTIPLIER_AT,
        touch_tolerance_percent: TOUCH_TOLERANCE_PERCENT_AT // Belum diimplementasikan eksplisit di kode ini tapi ada parameternya
    };

    if (confirmedPatterns.length > 0) {
        console.log(`[detect-at] Sending response: ${confirmedPatterns.length} confirmed Ascending Triangle patterns.`);
        response.status(200).json({
            message: `Ditemukan ${confirmedPatterns.length} Pola Ascending Triangle TERKONFIRMASI untuk ${symbol.toUpperCase()}.`,
            patterns: confirmedPatterns,
            parameters_used: parametersUsed,
            totalCandlesAnalyzed: candles.length,
            localLowsFound: localLowsIdx.length,
            localHighsFound: localHighsIdx.length
        });
    } else {
        console.log(`[detect-at] Sending response: No confirmed Ascending Triangle patterns found.`);
        response.status(200).json({
            message: `Tidak ada Pola Ascending Triangle TERKONFIRMASI (dengan breakout) yang terdeteksi untuk ${symbol.toUpperCase()} dari ${uniquePotentialPatterns.length} potensi formasi.`, // Gunakan uniquePotentialPatterns
            potentialFormationsCount: uniquePotentialPatterns.length,
            parameters_used: parametersUsed,
            totalCandlesAnalyzed: candles.length,
            localLowsFound: localLowsIdx.length,
            localHighsFound: localHighsIdx.length
        });
    }

  } catch (error) {
    console.error(`[detect-at] Critical Error for ${symbol}:`, error.message, error.stack);
    // ... (Error handling sama seperti sebelumnya) ...
    let errorDetails = { message: `Terjadi kesalahan internal saat mencoba mendeteksi pola Ascending Triangle untuk ${symbol}.`, errorMessage: error.message };
    if (error.response) { errorDetails.upstreamStatus = error.response.status; errorDetails.upstreamData = error.response.data; }
    response.status(500).json(errorDetails);
  }
}