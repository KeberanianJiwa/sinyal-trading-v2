// File: api/scan-patterns.js
import axios from 'axios';

// Daftar fungsi deteksi pola yang akan dipanggil
const patternDetectors = [
  'detect-ihs',
  'detect-double-bottom',
  'detect-descending-triangle',
  'detect-falling-wedge',
  'detect-ascending-triangle',
];

// Mapping nama file ke nama pola yang lebih mudah dibaca
const patternTypeMapping = {
  'detect-ihs': 'Inverse Head & Shoulders',
  'detect-double-bottom': 'Double Bottom',
  'detect-descending-triangle': 'Descending Triangle',
  'detect-falling-wedge': 'Falling Wedge',
  'detect-ascending-triangle': 'Ascending Triangle',
};

export default async function handler(request, response) {
  const { symbol, secret } = request.query; // Ambil 'secret' dari query parameter

  // --- Otorisasi untuk Cron Job ---
  const vercelCronSecret = request.headers['x-vercel-cron-secret'];
  const userDefinedSecret = process.env.CRON_JOB_SECRET; // Ini yang Anda set: cronRahasiaSuperAman123!

  let authorized = false;

  if (vercelCronSecret) { // Jika Vercel mengirim header secretnya sendiri (fitur Cron Job Protection)
    if (vercelCronSecret === process.env.CRON_JOB_SECRET_VERCEL_PROTECTED) { // Nama env var ini diisi Vercel
      authorized = true;
      console.log('[scan-patterns] Authorized via Vercel-managed cron secret header.');
    } else {
      console.warn('[scan-patterns] Invalid Vercel-managed cron secret header received.');
    }
  } else if (secret && userDefinedSecret) { // Jika header Vercel tidak ada, cek query parameter 'secret'
    if (secret === userDefinedSecret) {
      authorized = true;
      console.log('[scan-patterns] Authorized via user-defined query parameter secret.');
    } else {
      console.warn('[scan-patterns] Invalid user-defined query parameter secret received.');
    }
  } else if (process.env.NODE_ENV !== 'production' && !request.headers['user-agent']?.includes('vercel-cron')) {
    // Izinkan jika bukan di production DAN bukan dari User-Agent Vercel Cron (misalnya, tes lokal atau dari browser di dev)
    // Anda mungkin ingin menghapus atau memperketat ini untuk production jika tidak ada secret sama sekali
    authorized = true;
    console.log('[scan-patterns] Call allowed in non-production environment or non-cron user-agent without secret.');
  }


  if (!authorized) {
    console.warn('[scan-patterns] Unauthorized attempt to access scan-patterns.');
    return response.status(401).json({ message: 'Unauthorized.' });
  }
  // --- Akhir Otorisasi Cron Job ---


  if (!symbol) {
    return response.status(400).json({ message: 'Parameter "symbol" diperlukan.' });
  }

  const upperSymbol = symbol.toUpperCase();
  console.log(`[scan-patterns] Starting scan for symbol: ${upperSymbol}`);

  const protocol = request.headers['x-forwarded-proto'] || 'http';
  const host = request.headers.host;

  const detectionPromises = patternDetectors.map(detectorName => {
    const apiUrl = `${protocol}://${host}/api/${detectorName}`;
    console.log(`[scan-patterns] Calling: ${apiUrl}?symbol=${upperSymbol}`);
    const timeoutMs = 45000; // Naikkan timeout menjadi 45 detik per endpoint karena ada 5 panggilan
    return axios.get(apiUrl, {
      params: { symbol: upperSymbol },
      headers: { 'Accept': 'application/json' },
      timeout: timeoutMs
    })
    .then(res => ({
        status: 'fulfilled',
        detector: detectorName,
        data: res.data
    }))
    .catch(error => {
        console.error(`[scan-patterns] Error calling ${detectorName} for ${upperSymbol}:`, error.message);
        const errorData = error.response ? error.response.data : { message: error.message, code: error.code };
         return {
            status: 'rejected',
            detector: detectorName,
            reason: errorData
        };
    });
  });

  const results = await Promise.allSettled(detectionPromises);
  console.log('[scan-patterns] All detection calls completed.');

  let allDetectedPatterns = [];
  let errorsEncountered = []; // Diubah nama variabelnya agar lebih jelas
  let parametersUsedFromDetectors = {};

  results.forEach(result => {
    if (result.status === 'fulfilled') { // Promise utama axios.get().then() atau .catch() terpenuhi
        const outcome = result.value; // Ini adalah objek yang kita return dari .then() atau .catch()

        if (outcome.status === 'fulfilled') { // Pemanggilan API spesifik berhasil
            const detectorName = outcome.detector;
            const responseData = outcome.data;
            console.log(`[scan-patterns] Result from ${detectorName}: ${responseData.message}`);
            if (responseData.patterns && Array.isArray(responseData.patterns) && responseData.patterns.length > 0) {
                const patternsWithType = responseData.patterns.map(p => ({
                ...p,
                patternType: patternTypeMapping[detectorName] || detectorName
                }));
                allDetectedPatterns = allDetectedPatterns.concat(patternsWithType);
            }
            // Ambil parameters_used dari hasil pertama yang sukses dan punya parameters_used
            if (Object.keys(parametersUsedFromDetectors).length === 0 && responseData.parameters_used) {
                parametersUsedFromDetectors[detectorName] = responseData.parameters_used;
            }
        } else { // Pemanggilan API spesifik gagal (masuk ke .catch() di atas)
            console.error(`[scan-patterns] Detector ${outcome.detector} call failed:`, outcome.reason);
            errorsEncountered.push({ detector: outcome.detector, reason: outcome.reason });
        }
    } else { // Promise utama untuk axios.get() itu sendiri gagal (jarang terjadi dengan .catch() yang sudah ada)
      console.error(`[scan-patterns] Promise for a detector itself failed:`, result.reason);
      // Sulit mendapatkan detectorName di sini jika promise-nya sendiri gagal sebelum axios dipanggil
      errorsEncountered.push({ detector: 'unknown_promise_failure', reason: result.reason?.message || 'Unknown promise rejection' });
    }
  });

  console.log(`[scan-patterns] Total confirmed patterns found across all types: ${allDetectedPatterns.length}`);

  response.status(200).json({
    symbol: upperSymbol,
    scanTime: new Date().toISOString(),
    detectedPatterns: allDetectedPatterns,
    parametersUsedByDetectors: parametersUsedFromDetectors, // Menampilkan parameter dari detektor
    errors: errorsEncountered
  });
}