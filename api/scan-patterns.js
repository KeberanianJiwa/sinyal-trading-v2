// File: api/scan-patterns.js
import axios from 'axios';
import admin from 'firebase-admin';

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
if (!admin.apps.length) {
  try {
    const serviceAccountString = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!serviceAccountString) {
      console.error('[Firebase Admin] FIREBASE_SERVICE_ACCOUNT_JSON environment variable not set. Firestore & FCM might not work.');
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

let db;
if (admin.apps.length && process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    db = admin.firestore();
    console.log('[Firestore] Firestore instance obtained.');
} else {
    console.warn('[Firestore] Firestore not initialized because Firebase Admin SDK failed or service account is missing.');
}

function getCandleTimestamp(candles, index) {
    if (candles && index >= 0 && index < candles.length && candles[index] && candles[index].timestamp) {
        return candles[index].timestamp;
    }
    return null;
}

function generatePatternId(pattern, candles) { // Tambahkan 'candles' jika diperlukan untuk patternEndIndex
  const breakoutTs = pattern.breakoutConfirmation?.timestamp;
  const s2Ts = pattern.S2?.timestamp;
  const e2Ts = pattern.E2?.timestamp;
  const hTs = pattern.H?.timestamp;
  
  let patternSpecificTimestamp = null;
  if (pattern.patternEndIndex !== undefined && pattern.patternEndIndex !== null && candles) {
      patternSpecificTimestamp = getCandleTimestamp(candles, pattern.patternEndIndex);
  }

  const ts = breakoutTs || s2Ts || e2Ts || patternSpecificTimestamp || hTs || Date.now();
  return `${pattern.symbol}_${pattern.patternType}_${ts}`.replace(/\s+/g, '_').replace(/&/g, 'And');
}

async function hasBeenNotifiedAndRecord(patternId, fullPatternData, candles) { // Tambahkan 'candles'
  if (!db) {
    console.warn('[Firestore] Firestore not available, cannot check/record. Assuming not notified.');
    return false;
  }
  const notificationLogRef = db.collection('notified_signals').doc(patternId);
  try {
    const doc = await notificationLogRef.get();
    if (doc.exists) {
      console.log(`[Firestore] Pattern ID ${patternId} already notified on ${doc.data().notifiedAt?.toDate ? doc.data().notifiedAt.toDate().toISOString() : doc.data().notifiedAt}`);
      return true;
    } else {
      const breakoutTs = fullPatternData.breakoutConfirmation?.timestamp;
      const s2Ts = fullPatternData.S2?.timestamp;
      const e2Ts = fullPatternData.E2?.timestamp;
      const hTs = fullPatternData.H?.timestamp;
      let patternSpecificTimestamp = null;
      if (fullPatternData.patternEndIndex !== undefined && fullPatternData.patternEndIndex !== null && candles) {
          patternSpecificTimestamp = getCandleTimestamp(candles, fullPatternData.patternEndIndex);
      }

      const dataToStore = {
        notifiedAt: admin.firestore.FieldValue.serverTimestamp(),
        patternId: patternId,
        symbol: fullPatternData.symbol,
        patternType: fullPatternData.patternType,
        status: fullPatternData.status,
        // Menggunakan salah satu timestamp yang paling relevan sebagai 'effectiveTimestamp'
        effectiveTimestamp: breakoutTs || s2Ts || e2Ts || patternSpecificTimestamp || hTs || Date.now(),
        breakoutPrice: fullPatternData.breakoutConfirmation?.closePrice ? parseFloat(fullPatternData.breakoutConfirmation.closePrice.toFixed(2)) : null,
        targetPrice: fullPatternData.projection?.targetPrice ? parseFloat(fullPatternData.projection.targetPrice.toFixed(2)) : null,
        volumeConfirmed: fullPatternData.breakoutConfirmation?.volumeConfirmed || false,
        // Anda bisa menambahkan detail titik-titik pola jika diperlukan untuk riwayat
        // S1_low: fullPatternData.S1?.low, H_low: fullPatternData.H?.low, S2_low: fullPatternData.S2?.low, etc.
      };
      await notificationLogRef.set(dataToStore);
      console.log(`[Firestore] Pattern ID ${patternId} recorded as notified with details:`, dataToStore);
      return false;
    }
  } catch (error) {
    console.error(`[Firestore] Error checking/recording notification status for ${patternId}:`, error);
    return false;
  }
}

async function sendFcmNotification(topic, title, body, patternData) {
  if (!admin.apps.length || !process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    console.warn('[FCM] Firebase Admin not initialized or FIREBASE_SERVICE_ACCOUNT_JSON missing. Skipping FCM notification.');
    return;
  }

  const breakoutTs = patternData.breakoutConfirmation?.timestamp;
  const s2Ts = patternData.S2?.timestamp;
  const e2Ts = patternData.E2?.timestamp;
  const hTs = patternData.H?.timestamp;
  let patternSpecificTimestamp = null;
   // Asumsi 'candles' bisa diakses atau sudah jadi bagian dari patternData jika patternEndIndex digunakan untuk timestamp
   // Jika 'candles' tidak tersedia di sini, logika timestamp untuk patternEndIndex perlu penyesuaian
  if (patternData.patternEndIndex !== undefined && patternData.patternEndIndex !== null /* && patternData.candles */) {
      // patternSpecificTimestamp = getCandleTimestamp(patternData.candles, patternData.patternEndIndex); // Jika candles ada di patternData
  }

  const message = {
    notification: {
      title: title,
      body: body,
    },
    data: {
      click_action: 'FLUTTER_NOTIFICATION_CLICK',
      symbol: String(patternData.symbol || ''),
      patternType: String(patternData.patternType || ''),
      timestamp: String(breakoutTs || s2Ts || e2Ts || patternSpecificTimestamp || hTs || Date.now()),
      status: String(patternData.status || 'Pattern Detected'),
      targetPrice: patternData.projection?.targetPrice ? String(patternData.projection.targetPrice.toFixed(2)) : 'N/A',
      breakoutPrice: patternData.breakoutConfirmation?.closePrice ? String(patternData.breakoutConfirmation.closePrice.toFixed(2)) : 'N/A',
      volumeConfirmed: String(patternData.breakoutConfirmation?.volumeConfirmed || false)
    },
    topic: topic
  };

  try {
    const response = await admin.messaging().send(message);
    console.log(`[FCM] Successfully sent message to topic ${topic}: MessageID=${response}`);
  } catch (error) {
    console.error(`[FCM] Error sending message to topic ${topic}:`, error.message, error.code);
    if (error.errorInfo) {
        console.error('[FCM] Firebase Error Info:', JSON.stringify(error.errorInfo));
    }
  }
}

export default async function handler(request, response) {
  const { symbol, secret } = request.query;

  // --- Otorisasi Cron Job (Tetap Sama) ---
  const vercelManagedCronSecret = request.headers['x-vercel-cron-secret'];
  const userDefinedCronSecret = process.env.CRON_JOB_SECRET;
  let authorized = false;
  if (vercelManagedCronSecret && process.env.CRON_JOB_SECRET_VERCEL_PROTECTED) {
    if (vercelManagedCronSecret === process.env.CRON_JOB_SECRET_VERCEL_PROTECTED) { authorized = true; console.log('[scan-patterns] Authorized via Vercel-managed cron secret header.'); }
    else { console.warn('[scan-patterns] Invalid Vercel-managed cron secret header received.'); }
  } else if (secret && userDefinedCronSecret) {
    if (secret === userDefinedCronSecret) { authorized = true; console.log('[scan-patterns] Authorized via user-defined query parameter secret.'); }
    else { console.warn('[scan-patterns] Invalid user-defined query parameter secret received.'); }
  } else if (process.env.NODE_ENV !== 'production' && !request.headers['user-agent']?.includes('vercel-cron')) {
    authorized = true; console.log('[scan-patterns] Call allowed in non-production environment or non-cron user-agent without secret (for testing).');
  }
  if (!authorized) { console.warn('[scan-patterns] Unauthorized attempt to access scan-patterns.'); return response.status(401).json({ message: 'Unauthorized.' });}
  // --- Akhir Otorisasi Cron Job ---

  if (!symbol) {
    return response.status(400).json({ message: 'Parameter "symbol" diperlukan.' });
  }

  const upperSymbol = symbol.toUpperCase();
  console.log(`[scan-patterns] Starting scan for symbol: ${upperSymbol}`);

  const protocol = request.headers['x-forwarded-proto'] || 'http';
  const host = request.headers.host;
  let allCandlesData = null; // Untuk menyimpan data candle yang akan di-pass ke generatePatternId dan hasBeenNotifiedAndRecord

  const detectionPromises = patternDetectors.map(async (detectorName) => { // Ubah jadi async
    const apiUrl = `${protocol}://${host}/api/${detectorName}`;
    console.log(`[scan-patterns] Calling: ${apiUrl}?symbol=${upperSymbol}`);
    const timeoutMs = 45000;
    try {
      const res = await axios.get(apiUrl, {
        params: { symbol: upperSymbol },
        headers: { 'Accept': 'application/json' },
        timeout: timeoutMs
      });
      // Simpan data candle jika ini adalah pemanggilan pertama yang berhasil mengambilnya
      // Asumsi semua detektor menggunakan data candle yang sama dari /api/get-candles
      // Jika masing-masing detektor mengembalikan 'candles' dalam responsnya, itu lebih baik.
      // Untuk sekarang, kita asumsikan respons detektor tidak mengandung 'candles' array.
      // Ini berarti generatePatternId dan hasBeenNotifiedAndRecord mungkin perlu penyesuaian jika mengandalkan 'candles' dari respons detektor.
      // Alternatifnya, /api/scan-patterns bisa panggil /api/get-candles sekali, lalu pass ke semua detektor.
      // Kita akan biarkan logika generatePatternId dan hasBeenNotifiedAndRecord tanpa 'candles' untuk saat ini.
      return {
          status: 'fulfilled',
          detector: detectorName,
          data: res.data
      };
    } catch (error) {
      console.error(`[scan-patterns] Error calling ${detectorName} for ${upperSymbol}:`, error.message);
      const errorData = error.response ? error.response.data : { message: error.message, code: error.code };
      return {
          status: 'rejected',
          detector: detectorName,
          reason: errorData
      };
    }
  });

  const results = await Promise.allSettled(detectionPromises);
  console.log('[scan-patterns] All detection calls completed.');

  let allDetectedPatterns = [];
  let errorsEncountered = [];
  let parametersUsedByDetectors = {};

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
            if (responseData.parameters_used) {
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

  // --- Kirim Notifikasi untuk Pola BARU yang Ditemukan ---
  if (allDetectedPatterns.length > 0 && db) {
    console.log(`[scan-patterns] Attempting to process ${allDetectedPatterns.length} detected patterns for notification...`);
    for (const pattern of allDetectedPatterns) {
      // 'candles' tidak tersedia secara langsung di sini, jadi generatePatternId dan hasBeenNotifiedAndRecord akan menggunakan Date.now() jika patternEndIndex timestamp tidak ada
      const patternId = generatePatternId(pattern, null); // Pass null untuk candles untuk saat ini
      console.log(`[scan-patterns] Processing pattern with ID: ${patternId}`);

      const alreadyNotified = await hasBeenNotifiedAndRecord(patternId, pattern, null); // Pass null untuk candles

      if (!alreadyNotified) {
        const topic = `signals_${pattern.symbol.toUpperCase()}`;
        const title = `Sinyal Pola Baru: ${pattern.patternType}`;
        const bodyText = `${pattern.symbol}: ${pattern.status || 'Pola terdeteksi'}. Breakout @ ${pattern.breakoutConfirmation?.closePrice?.toFixed(2) || 'N/A'}. Target ${pattern.projection?.targetPrice ? pattern.projection.targetPrice.toFixed(2) : 'N/A'}.`;
        
        console.log(`[scan-patterns] Preparing to send NEW FCM for: ${title} - ${bodyText} to topic ${topic}`);
        await sendFcmNotification(topic, title, bodyText, pattern);
      } else {
        console.log(`[scan-patterns] Pattern ID ${patternId} was already notified. Skipping FCM.`);
      }
    }
  } else if (allDetectedPatterns.length > 0 && !db) {
    console.warn('[scan-patterns] Patterns detected, but Firestore is not available. Notifications might be duplicated.');
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