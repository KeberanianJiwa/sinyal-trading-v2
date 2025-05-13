// File: api/scan-patterns.js
import axios from 'axios';
import admin from 'firebase-admin'; // Impor firebase-admin

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

// --- Inisialisasi Firebase Admin SDK ---
// Pastikan hanya diinisialisasi sekali
if (!admin.apps.length) {
  try {
    const serviceAccountString = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!serviceAccountString) {
      console.error('[Firebase Admin] FIREBASE_SERVICE_ACCOUNT_JSON environment variable not set. Notifications will be skipped.');
    } else {
      const serviceAccount = JSON.parse(serviceAccountString);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
      console.log('[Firebase Admin] Firebase Admin SDK Initialized successfully.');
    }
  } catch (e) {
    console.error('[Firebase Admin] Error initializing Firebase Admin SDK:', e.message);
  }
}
// --- Akhir Inisialisasi Firebase Admin SDK ---

// Fungsi untuk mengirim notifikasi FCM ke sebuah topik
async function sendFcmNotification(topic, title, body, patternData) {
  // Cek apakah Firebase Admin SDK berhasil diinisialisasi
  if (!admin.apps.length || !process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    console.warn('[FCM] Firebase Admin not initialized or FIREBASE_SERVICE_ACCOUNT_JSON missing. Skipping FCM notification.');
    return;
  }

  const message = {
    notification: {
      title: title,
      body: body,
    },
    data: {
      click_action: 'FLUTTER_NOTIFICATION_CLICK', // Atau sesuaikan dengan aksi di aplikasi Anda
      symbol: patternData.symbol || '',
      patternType: patternData.patternType || '',
      timestamp: patternData.breakoutConfirmation ? String(patternData.breakoutConfirmation.timestamp) : String(Date.now()),
      // Anda bisa tambahkan data lain yang relevan
      status: patternData.status || 'Pattern Detected', // Untuk informasi tambahan di notifikasi
      targetPrice: patternData.projection?.targetPrice ? String(patternData.projection.targetPrice) : 'N/A',
    },
    topic: topic
  };

  try {
    const response = await admin.messaging().send(message);
    console.log(`[FCM] Successfully sent message to topic ${topic}:`, response);
  } catch (error) {
    console.error(`[FCM] Error sending message to topic ${topic}:`, error.message, error.code);
    if (error.errorInfo) {
        console.error('[FCM] Firebase Error Info:', JSON.stringify(error.errorInfo));
    }
  }
}


export default async function handler(request, response) {
  const { symbol, secret } = request.query;

  // --- Otorisasi untuk Cron Job ---
  const vercelManagedCronSecret = request.headers['x-vercel-cron-secret'];
  const userDefinedCronSecret = process.env.CRON_JOB_SECRET; // Nilai: cronRahasiaSuperAman123!

  let authorized = false;

  if (vercelManagedCronSecret && process.env.CRON_JOB_SECRET_VERCEL_PROTECTED) {
    // Prioritaskan secret yang dikelola Vercel jika ada dan env varnya diset
    if (vercelManagedCronSecret === process.env.CRON_JOB_SECRET_VERCEL_PROTECTED) {
      authorized = true;
      console.log('[scan-patterns] Authorized via Vercel-managed cron secret header.');
    } else {
      console.warn('[scan-patterns] Invalid Vercel-managed cron secret header received.');
    }
  } else if (secret && userDefinedCronSecret) {
    // Fallback ke query parameter 'secret' jika header Vercel tidak digunakan/tidak ada
    if (secret === userDefinedCronSecret) {
      authorized = true;
      console.log('[scan-patterns] Authorized via user-defined query parameter secret.');
    } else {
      console.warn('[scan-patterns] Invalid user-defined query parameter secret received.');
    }
  } else if (process.env.NODE_ENV !== 'production' && !request.headers['user-agent']?.includes('vercel-cron')) {
    // Izinkan jika bukan di production DAN bukan dari User-Agent Vercel Cron (untuk tes lokal/browser)
    authorized = true;
    console.log('[scan-patterns] Call allowed in non-production environment or non-cron user-agent without secret (for testing).');
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
    const timeoutMs = 45000; // Timeout per endpoint detektor
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
  let errorsEncountered = [];
  let parametersUsedByDetectors = {}; // Mengumpulkan parameter dari semua detektor

  results.forEach(result => {
    if (result.status === 'fulfilled') {
        const outcome = result.value;
        if (outcome.status === 'fulfilled') {
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
            if (responseData.parameters_used) { // Ambil parameter dari setiap hasil
                parametersUsedByDetectors[detectorName] = responseData.parameters_used;
            }
        } else {
            console.error(`[scan-patterns] Detector ${outcome.detector} call failed:`, outcome.reason);
            errorsEncountered.push({ detector: outcome.detector, reason: outcome.reason });
        }
    } else {
      console.error(`[scan-patterns] Promise for a detector itself failed:`, result.reason);
      errorsEncountered.push({ detector: 'unknown_promise_failure', reason: result.reason?.message || 'Unknown promise rejection' });
    }
  });

  // --- Kirim Notifikasi untuk Pola Baru yang Ditemukan ---
  if (allDetectedPatterns.length > 0) {
    console.log(`[scan-patterns] Attempting to send notifications for ${allDetectedPatterns.length} patterns...`);
    for (const pattern of allDetectedPatterns) {
      // TODO: Implementasi logika untuk cek apakah pola ini BARU dan belum pernah dinotifikasi
      // (misalnya menggunakan Firestore untuk menyimpan ID pola yang sudah dinotifikasi)
      // Untuk sekarang, akan selalu coba kirim notifikasi untuk setiap pola terkonfirmasi.

      const topic = `signals_${pattern.symbol.toUpperCase()}`; // e.g., signals_BTCUSDT
      // Anda juga bisa punya topik umum seperti "all_new_signals"
      // const generalTopic = "all_new_signals";

      const title = `Sinyal Pola Baru: ${pattern.patternType}`;
      const body = `${pattern.symbol}: ${pattern.status || 'Pola terdeteksi'}. Breakout di ${pattern.breakoutConfirmation?.closePrice?.toFixed(2) || 'N/A'}. Target ${pattern.projection?.targetPrice ? pattern.projection.targetPrice.toFixed(2) : 'N/A'}.`;

      console.log(`[scan-patterns] Preparing to send FCM for: ${title} - ${body} to topic ${topic}`);
      await sendFcmNotification(topic, title, body, pattern);
      // await sendFcmNotification(generalTopic, title, body, pattern); // Jika ingin kirim ke topik umum juga
    }
  }
  // --- Akhir Kirim Notifikasi ---

  console.log(`[scan-patterns] Total confirmed patterns found across all types: ${allDetectedPatterns.length}`);

  response.status(200).json({
    symbol: upperSymbol,
    scanTime: new Date().toISOString(),
    detectedPatterns: allDetectedPatterns,
    parametersUsedByDetectors: parametersUsedByDetectors,
    errors: errorsEncountered
  });
}