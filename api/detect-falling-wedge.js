// File: api/detect-falling-wedge.js
import axios from 'axios';

// --- Helper Functions (Sama seperti sebelumnya) ---
function findLocalLows(data, order) {
  const lowsIndices = []; if (data.length < (2*order+1)) return lowsIndices;
  for (let i=order; i<data.length-order; i++) { let isLow=true; for(let j=1; j<=order; j++) { if(data[i]>data[i-j]||data[i]>data[i+j]){isLow=false; break;}} if(isLow){const l=lowsIndices.length>0?lowsIndices[lowsIndices.length-1]:-1; if(!lowsIndices.includes(i)&&!(l===i-1&&data[i]===data[l])){lowsIndices.push(i);}}} return lowsIndices;}
function findLocalHighs(data, order) {
  const highsIndices = []; if (data.length < (2*order+1)) return highsIndices;
  for (let i=order; i<data.length-order; i++) { let isHigh=true; for(let j=1; j<=order; j++) { if(data[i]<data[i-j]||data[i]<data[i+j]){isHigh=false; break;}} if(isHigh){const l=highsIndices.length>0?highsIndices[highsIndices.length-1]:-1; if(!highsIndices.includes(i)&&!(l===i-1&&data[i]===data[l])){highsIndices.push(i);}}} return highsIndices;}
function simpleLinearRegression(x, y) { const n=x.length; if(n===0||n!==y.length) return null; let sx=0,sy=0,sxy=0,sxx=0; for(let i=0;i<n;i++){sx+=x[i];sy+=y[i];sxy+=x[i]*y[i];sxx+=x[i]*x[i];} const d=n*sxx-sx*sx; if(d===0) return null; const m=(n*sxy-sx*sy)/d; const c=(sy-m*sx)/n; return {slope:m, intercept:c};}
// --- End Helper Functions ---

export default async function handler(request, response) {
  const { symbol } = request.query;
  if (!symbol) return response.status(400).json({ message: 'Parameter "symbol" diperlukan.' });

  // --- Parameter Tuning untuk Falling Wedge ---
  const ORDER_EXTREMA_FW = 5;
  const CANDLES_LIMIT_FW = 300;
  const MIN_TOUCHES = 2; // Minimal sentuhan pada setiap garis (PDF menyarankan 3 idealnya)
  const MAX_SLOPE = -0.00001; // Kedua slope harus negatif
  const MIN_PATTERN_DURATION_FW = 30; // Minimal panjang pola dalam candle
  const MAX_PATTERN_DURATION_FW = 150; // Maksimal panjang pola
  const CANDLES_TO_CHECK_BREAKOUT_FW = 15;
  const BREAKOUT_BUFFER_PERCENT_FW = 0.001; // Buffer breakout (0.1%) di atas resistance
  const VOLUME_LOOKBACK_FW = 30;
  const VOLUME_MULTIPLIER_FW = 1.5; // Volume breakout harus > N kali rata-rata (dinaikkan sedikit dari sebelumnya)
  const TOUCH_TOLERANCE_PERCENT = 0.005; // Toleransi seberapa dekat harga ke garis tren (0.5%)
  // --- End of Parameter Tuning ---

  let localLowsIdx = [];
  let localHighsIdx = [];
  let potentialPatterns = [];

  try {
    console.log(`[detect-fw] Fetching ${CANDLES_LIMIT_FW} candles for ${symbol}...`);
    const protocol = request.headers['x-forwarded-proto'] || 'http';
    const host = request.headers.host;
    const candleApiUrl = `${protocol}://${host}/api/get-candles`;
    const candlesResponse = await axios.get(candleApiUrl, { params: { symbol: symbol.toUpperCase(), granularity: '1h', limit: CANDLES_LIMIT_FW }, headers: { 'Accept': 'application/json' }});

    if (!candlesResponse.data || !candlesResponse.data.data || candlesResponse.data.data.length < MIN_PATTERN_DURATION_FW) {
      return response.status(500).json({ message: `Gagal mengambil data candlestick atau data tidak cukup (${candlesResponse.data?.data?.length || 0} candles) untuk ${symbol}.` });
    }
    const candles = candlesResponse.data.data;
    console.log(`[detect-fw] Berhasil mengambil ${candles.length} candles.`);
    const lowPrices = candles.map(c => c.low);
    const highPrices = candles.map(c => c.high);

    localLowsIdx = findLocalLows(lowPrices, ORDER_EXTREMA_FW);
    localHighsIdx = findLocalHighs(highPrices, ORDER_EXTREMA_FW);
    console.log(`[detect-fw] Ditemukan ${localLowsIdx.length} lows & ${localHighsIdx.length} highs dengan order ${ORDER_EXTREMA_FW}.`);

    potentialPatterns = [];
    // Iterasi mencari pola: coba kombinasi dari 2 high terakhir dan 2 low terakhir
    // Pendekatan sederhana: periksa N candle terakhir
    const checkWindow = Math.max(MIN_PATTERN_DURATION_FW, 60); // Periksa misal 60 candle terakhir

    for (let endIdx = candles.length - 1; endIdx >= checkWindow -1 ; endIdx--) {
        const startIdx = endIdx - checkWindow + 1;
        const windowCandles = candles.slice(startIdx, endIdx + 1);
        const windowLows = lowPrices.slice(startIdx, endIdx + 1);
        const windowHighs = highPrices.slice(startIdx, endIdx + 1);
        const windowIndices = Array.from({ length: windowCandles.length }, (_, k) => startIdx + k); // Indeks absolut

        const windowLocalLows = findLocalLows(windowLows, ORDER_EXTREMA_FW).map(i => startIdx + i); // Map ke indeks absolut
        const windowLocalHighs = findLocalHighs(windowHighs, ORDER_EXTREMA_FW).map(i => startIdx + i);

        if (windowLocalLows.length >= MIN_TOUCHES && windowLocalHighs.length >= MIN_TOUCHES) {
            // Coba fit garis resistance dan support
            const resX = windowLocalHighs;
            const resY = windowLocalHighs.map(idx => highPrices[idx]);
            const supX = windowLocalLows;
            const supY = windowLocalLows.map(idx => lowPrices[idx]);

            const resLine = simpleLinearRegression(resX, resY);
            const supLine = simpleLinearRegression(supX, supY);

            if (resLine && supLine &&
                resLine.slope < MAX_SLOPE && // Resistance menurun
                supLine.slope < MAX_SLOPE && // Support menurun
                Math.abs(resLine.slope) > Math.abs(supLine.slope)) // Resistance lebih curam
            {
                // Cek konvergensi: resistance di atas support di awal, jarak menyempit
                const resStartVal = resLine.slope * startIdx + resLine.intercept;
                const supStartVal = supLine.slope * startIdx + supLine.intercept;
                const resEndVal = resLine.slope * endIdx + resLine.intercept;
                const supEndVal = supLine.slope * endIdx + supLine.intercept;

                const startDiff = resStartVal - supStartVal;
                const endDiff = resEndVal - supEndVal;

                if (startDiff > 0 && endDiff > 0 && startDiff > endDiff) {
                     // Cek jumlah sentuhan (minimal N titik dekat dengan garis)
                     let resistanceTouches = 0;
                     windowLocalHighs.forEach(idx => {
                         const lineVal = resLine.slope * idx + resLine.intercept;
                         if (Math.abs(highPrices[idx] - lineVal) / lineVal <= TOUCH_TOLERANCE_PERCENT) {
                             resistanceTouches++;
                         }
                     });
                     let supportTouches = 0;
                     windowLocalLows.forEach(idx => {
                         const lineVal = supLine.slope * idx + supLine.intercept;
                          if (Math.abs(lowPrices[idx] - lineVal) / lineVal <= TOUCH_TOLERANCE_PERCENT) {
                             supportTouches++;
                         }
                     });

                     if (resistanceTouches >= MIN_TOUCHES && supportTouches >= MIN_TOUCHES) {
                         console.log(`[detect-fw] Potential FW found: Start(${startIdx}), End(${endIdx}). ResTouches=${resistanceTouches}, SupTouches=${supportTouches}. ResSlope=${resLine.slope.toFixed(4)}, SupSlope=${supLine.slope.toFixed(4)}`);
                         // Hindari duplikasi jika window overlap mendeteksi pola yang sama
                         const existing = potentialPatterns.find(p => p.patternEndIndex === endIdx);
                         if (!existing) {
                             potentialPatterns.push({
                                symbol: symbol.toUpperCase(),
                                message: 'Potensi Pola Falling Wedge Teridentifikasi (Formasi)',
                                resistanceLine: resLine,
                                supportLine: supLine,
                                resistanceIndices: windowLocalHighs,
                                supportIndices: windowLocalLows,
                                patternStartIndex: startIdx,
                                patternEndIndex: endIdx,
                             });
                         }
                     }
                }
            }
        }
    } // End of sliding window loop


    // Cek Breakout untuk setiap potensi pola
    const confirmedPatterns = [];
    potentialPatterns.sort((a,b) => a.patternEndIndex - b.patternEndIndex); // Urutkan berdasarkan waktu

    for (const pattern of potentialPatterns) {
      const resLine = pattern.resistanceLine;
      const lastPatternIndex = pattern.patternEndIndex;

      let breakoutCandle = null;
      for (let k = lastPatternIndex + 1; k < candles.length && k <= lastPatternIndex + CANDLES_TO_CHECK_BREAKOUT_FW; k++) {
        const currentCandle = candles[k];
        const resistanceLineValueAtK = resLine.slope * k + resLine.intercept; // Nilai resistance line pada indeks k

        console.log(`[detect-fw] Checking Breakout FW: Index ${k}, Close: ${currentCandle.close}, Resistance Line: ${resistanceLineValueAtK.toFixed(2)}`);

        // Kondisi Breakout: Harga penutupan di atas garis resistance
        if (currentCandle.close > resistanceLineValueAtK) {
           const buffer = resistanceLineValueAtK * BREAKOUT_BUFFER_PERCENT_FW;
           if (currentCandle.close > resistanceLineValueAtK + buffer) {
              console.log(`[detect-fw] FW BREAKOUT DETECTED at index ${k}`);
              breakoutCandle = {
                timestamp: currentCandle.timestamp,
                closePrice: currentCandle.close,
                resistanceLineValue: resistanceLineValueAtK,
                index: k,
                volume: currentCandle.volume
              };
              break;
           } else {
              console.log(`[detect-fw] FW Close price above resistance but within buffer at index ${k}`);
           }
        }
      } // End loop checking for breakout

      if (breakoutCandle) {
        const startVolumeIdx = Math.max(0, breakoutCandle.index - VOLUME_LOOKBACK_FW);
        const volumesBeforeBreakout = candles.slice(startVolumeIdx, breakoutCandle.index).map(c => c.volume);
        const avgVolume = volumesBeforeBreakout.length > 0 ? volumesBeforeBreakout.reduce((sum, vol) => sum + vol, 0) / volumesBeforeBreakout.length : 0;
        const isVolumeConfirmed = avgVolume > 0 && breakoutCandle.volume > avgVolume * VOLUME_MULTIPLIER_FW;
        console.log(`[detect-fw] FW Breakout Volume Check: BreakoutVol=${breakoutCandle.volume.toFixed(2)}, AvgVol(${VOLUME_LOOKBACK_FW} candles)=${avgVolume.toFixed(2)}, Confirmed=${isVolumeConfirmed} (Threshold ${VOLUME_MULTIPLIER_FW}x)`);

        // Hitung Target Harga
        // Tinggi pola = Tinggi resistance di titik awal - Tinggi support di titik awal
        const resStartVal = resLine.slope * pattern.patternStartIndex + resLine.intercept;
        const supStartVal = pattern.supportLine.slope * pattern.patternStartIndex + pattern.supportLine.intercept;
        const patternHeight = resStartVal - supStartVal;
        let targetPrice = null;
        if (patternHeight > 0) {
            targetPrice = breakoutCandle.closePrice + patternHeight; // Target = Harga breakout + Tinggi Pola
        }
        console.log(`[detect-fw] FW Pattern Ends(${lastPatternIndex}) - Height=${patternHeight.toFixed(2)}, TargetPrice=${targetPrice ? targetPrice.toFixed(2) : 'N/A'}`);

        confirmedPatterns.push({
          ...pattern, // Data formasi garis support/resistance dll.
          breakoutConfirmation: {
             ...breakoutCandle,
             volumeConfirmed: isVolumeConfirmed,
             avgVolumeBefore: avgVolume
          },
          projection: {
              patternHeight: patternHeight,
              targetPrice: targetPrice
          },
          status: "Falling Wedge Confirmed with Breakout"
        });
      } else {
          console.log(`[detect-fw] FW Pattern Ends(${lastPatternIndex}) - No breakout found within ${CANDLES_TO_CHECK_BREAKOUT_FW} candles.`);
      }
    } // End loop through potential patterns


    // Kirim Respons Akhir
    const parametersUsed = { /* Definisi parameter sama seperti di atas */ }; // Isi dengan konstanta parameter
    // ... (Logika respons sama seperti Descending Triangle, sesuaikan message) ...
     if (confirmedPatterns.length > 0) {
        console.log(`[detect-fw] Sending response: ${confirmedPatterns.length} confirmed Falling Wedge patterns.`);
        response.status(200).json({
            message: `Ditemukan ${confirmedPatterns.length} Pola Falling Wedge TERKONFIRMASI untuk ${symbol.toUpperCase()}.`,
            patterns: confirmedPatterns,
            parameters_used: { // Isi parameter yang digunakan
                order_extrema: ORDER_EXTREMA_FW, candles_limit: CANDLES_LIMIT_FW, min_touches: MIN_TOUCHES,
                max_slope: MAX_SLOPE, min_pattern_duration: MIN_PATTERN_DURATION_FW, max_pattern_duration: MAX_PATTERN_DURATION_FW,
                candles_to_check_breakout: CANDLES_TO_CHECK_BREAKOUT_FW, breakout_buffer_percent: BREAKOUT_BUFFER_PERCENT_FW,
                volume_lookback: VOLUME_LOOKBACK_FW, volume_multiplier: VOLUME_MULTIPLIER_FW, touch_tolerance_percent: TOUCH_TOLERANCE_PERCENT
            },
            totalCandlesAnalyzed: candles.length,
            localLowsFound: localLowsIdx.length,
            localHighsFound: localHighsIdx.length
        });
    } else {
        console.log(`[detect-fw] Sending response: No confirmed Falling Wedge patterns found.`);
        response.status(200).json({
            message: `Tidak ada Pola Falling Wedge TERKONFIRMASI (dengan breakout) yang terdeteksi untuk ${symbol.toUpperCase()} dari ${potentialPatterns.length} potensi formasi.`,
            potentialFormationsCount: potentialPatterns.length,
            parameters_used: { /* Isi parameter */ },
            totalCandlesAnalyzed: candles.length,
            localLowsFound: localLowsIdx.length,
            localHighsFound: localHighsIdx.length
        });
    }


  } catch (error) {
    console.error(`[detect-fw] Critical Error for ${symbol}:`, error.message, error.stack);
    // ... (Error handling sama seperti sebelumnya) ...
     let errorDetails = { message: `Terjadi kesalahan internal saat mencoba mendeteksi pola Falling Wedge untuk ${symbol}.`, errorMessage: error.message };
     if (error.response) { errorDetails.upstreamStatus = error.response.status; errorDetails.upstreamData = error.response.data; }
     response.status(500).json(errorDetails);
  }
}