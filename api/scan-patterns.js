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

// Helper function untuk mendapatkan timestamp dari candle berdasarkan index
// (Kita asumsikan 'candles' array akan tersedia saat fungsi ini dipanggil jika diperlukan)
function getCandleTimestamp(candles, index) {
    if (candles && index >= 0 && index < candles.length && candles[index] && candles[index].timestamp) {
        return candles[index].timestamp;
    }
    return null;
}

// Fungsi untuk membuat ID unik untuk sebuah pola
function generatePatternId(pattern, candles) {
  // Prioritaskan timestamp breakout jika ada
  const breakoutTs = pattern.breakoutConfirmation?.timestamp;
  // Timestamp lain sebagai fallback, tergantung jenis pola
  const s2Ts = pattern.S2?.timestamp; // Untuk IH&S, Double Bottom
  const e2Ts = pattern.E2?.timestamp; // Untuk Double Bottom
  const hTs = pattern.H?.timestamp;   // Untuk IH&S (kepala)

  // Untuk pola Triangle/Wedge, patternEndIndex bisa jadi relevan,
  // tapi kita butuh array 'candles' untuk mendapatkan timestamp sebenarnya.
  // Jika tidak ada 'candles' di sini, kita tidak bisa menggunakan patternEndIndex untuk timestamp yang akurat.
  let patternSpecificTimestamp = null;
  if (pattern.patternEndIndex !== undefined && pattern.patternEndIndex !== null && candles) {
      patternSpecificTimestamp = getCandleTimestamp(candles, pattern.patternEndIndex);
  }
  
  const ts = breakoutTs || s2Ts || e2Ts || patternSpecificTimestamp || hTs || Date.now(); // Fallback ke waktu sekarang jika tidak ada ts lain
  // Ganti spasi dan '&' agar aman sebagai ID dokumen Firestore
  return `${pattern.symbol}_${pattern.patternType}_${ts}`.replace(/\s+/g, '_').replace(/&/g, 'And');
}

// Fungsi untuk cek apakah sinyal sudah dinotifikasi & untuk mencatatnya dengan detail
async function hasBeenNotifiedAndRecord(patternId, fullPatternData, candles) { // Tambahkan 'candles'
  if (!db) {
    console.warn('[Firestore] Firestore not available, cannot check/record. Assuming not notified (will lead to duplicates if error persists).');
    return false;
  }
  const notificationLogRef = db.collection('notified_signals').doc(patternId);
  try {
    const doc = await notificationLogRef.get();
    if (doc.exists) {
      console.log(`[Firestore] Pattern ID ${patternId} already notified on ${doc.data().notifiedAt?.toDate ? doc.data().notifiedAt.toDate().toISOString() : doc.data().notifiedAt}`);
      return true;
    } else {
      // Tentukan effectiveTimestamp untuk disimpan dan diurutkan
      const breakoutTs = fullPatternData.breakoutConfirmation?.timestamp;
      const s2Ts = fullPatternData.S2?.timestamp;
      const e2Ts = fullPatternData.E2?.timestamp;
      const hTs = fullPatternData.H?.timestamp;
      let patternSpecificTimestamp = null;
      if (fullPatternData.patternEndIndex !== undefined && fullPatternData.patternEndIndex !== null && candles) {
          patternSpecificTimestamp = getCandleTimestamp(candles, fullPatternData.patternEndIndex);
      }
      const effectiveTs = breakoutTs || s2Ts || e2Ts || patternSpecificTimestamp || hTs || Date.now();

      const dataToStore = {
        notifiedAt: admin.firestore.FieldValue.serverTimestamp(), // Timestamp Firebase saat ini
        patternId: patternId,
        symbol: fullPatternData.symbol,
        patternType: fullPatternData.patternType,
        status: fullPatternData.status,
        effectiveTimestamp: effectiveTs, // Timestamp utama pola untuk sorting riwayat
        breakoutPrice: fullPatternData.breakoutConfirmation?.closePrice ? parseFloat(fullPatternData.breakoutConfirmation.closePrice.toFixed(2)) : null,
        targetPrice: fullPatternData.projection?.targetPrice ? parseFloat(fullPatternData.projection.targetPrice.toFixed(2)) : null,
        volumeConfirmed: fullPatternData.breakoutConfirmation?.volumeConfirmed || false,
        // Anda bisa tambahkan detail titik-titik pola di sini jika ingin ditampilkan di riwayat
        // Contoh:
        // S1_timestamp: fullPatternData.S1?.timestamp || null,
        // H_timestamp: fullPatternData.H?.timestamp || null,
        // S2_timestamp: fullPatternData.S2?.timestamp || null,
        // P1_timestamp: fullPatternData.P1?.timestamp || null,
        // P2_timestamp: fullPatternData.P2?.timestamp || null,
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

// Fungsi untuk mengirim notifikasi FCM
async function sendFcmNotification(topic, title, body, patternData) {
  if (!admin.apps.length || !process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    console.warn('[FCM] Firebase Admin not initialized or FIREBASE_SERVICE_ACCOUNT_JSON missing. Skipping FCM notification.');
    return;
  }

  // Ambil effectiveTimestamp yang sama dengan yang disimpan di Firestore untuk konsistensi
  const breakoutTs = patternData.breakoutConfirmation?.timestamp;
  const s2Ts = patternData.S2?.timestamp;
  const e2Ts = patternData.E2?.timestamp;
  const hTs = patternData.H?.timestamp;
  let patternSpecificTimestamp = null;
  // Untuk mengirim 'candles' ke sini, patternData harus sudah mengandungnya, atau kita ambil dari sumber lain
  // Jika tidak, timestamp berdasarkan patternEndIndex tidak bisa akurat.
  // if (patternData.patternEndIndex !== undefined && patternData.patternEndIndex !== null && patternData.candles) {
  //     patternSpecificTimestamp = getCandleTimestamp(patternData.candles, patternData.patternEndIndex);
  // }
  const effectiveTsForFcm = String(breakoutTs || s2Ts || e2Ts || patternSpecificTimestamp || hTs || Date.now());

  const message = {
    notification: {
      title: title,
      body: body,
    },
    data: {
      click_action: 'FLUTTER_NOTIFICATION_CLICK', // Atau nama aksi standar Android Anda
      symbol: String(patternData.symbol || ''),
      patternType: String(patternData.patternType || ''),
      timestamp: effectiveTsForFcm, // Gunakan timestamp yang konsisten
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
  
  // Variabel untuk menyimpan data candle yang mungkin akan digunakan oleh beberapa fungsi
  // Ini perlu diisi dari respons /api/get-candles jika ingin digunakan di generatePatternId/hasBeenNotifiedAndRecord
  // Untuk sekarang, kita belum mengambilnya secara terpusat di sini.
  let candlesForSymbol = null; 

  const detectionPromises = patternDetectors.map(async (detectorName) => {
    const apiUrl = `${protocol}://${host}/api/${detectorName}`;
    console.log(`[scan-patterns] Calling: ${apiUrl}?symbol=${upperSymbol}`);
    const timeoutMs = 45000;
    try {
      const res = await axios.get(apiUrl, {
        params: { symbol: upperSymbol },
        headers: { 'Accept': 'application/json' },
        timeout: timeoutMs
      });
      // Jika fungsi detektor mengembalikan array 'candles' (misalnya, dari respons /api/get-candles internalnya),
      // kita bisa coba ambil di sini. Tapi ini bergantung pada desain respons detektor.
      // if (res.data && res.data.candles && !candlesForSymbol) {
      //     candlesForSymbol = res.data.candles;
      // }
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
    if (result.status === 'fulfilled' && result.value.status === 'fulfilled') {
        const outcome = result.value;
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
    } else if (result.status === 'fulfilled' && result.value.status === 'rejected') {
        console.error(`[scan-patterns] Detector ${result.value.detector} call failed:`, result.value.reason);
        errorsEncountered.push({ detector: result.value.detector, reason: result.value.reason });
    } else {
      console.error(`[scan-patterns] Promise for a detector itself failed:`, result.reason);
      errorsEncountered.push({ detector: 'unknown_promise_failure', reason: result.reason?.message || 'Unknown promise rejection' });
    }
  });

  // --- Kirim Notifikasi untuk Pola BARU yang Ditemukan ---
  if (allDetectedPatterns.length > 0 && db) {
    console.log(`[scan-patterns] Attempting to process ${allDetectedPatterns.length} detected patterns for notification...`);
    for (const pattern of allDetectedPatterns) {
      // Untuk 'candlesForSymbol', idealnya ini didapat dari respons detektor atau diambil sekali di awal.
      // Jika tidak ada, generatePatternId dan hasBeenNotifiedAndRecord akan fallback.
      const patternId = generatePatternId(pattern, candlesForSymbol); 
      console.log(`[scan-patterns] Processing pattern with ID: ${patternId}`);

      const alreadyNotified = await hasBeenNotifiedAndRecord(patternId, pattern, candlesForSymbol);

      if (!alreadyNotified) {
        // Implementasi filter kesegaran di sini
        let isFreshEnoughForNotification = false;
        const effectiveTimestamp = pattern.breakoutConfirmation?.timestamp || 
                                   pattern.S2?.timestamp || 
                                   pattern.E2?.timestamp || 
                                   (candlesForSymbol && pattern.patternEndIndex !== undefined ? getCandleTimestamp(candlesForSymbol, pattern.patternEndIndex) : null) || 
                                   pattern.H?.timestamp;

        if (effectiveTimestamp) {
            const currentTime = Date.now();
            const ageInMilliseconds = currentTime - effectiveTimestamp;
            // Hanya kirim notifikasi jika pola terbentuk/breakout dalam 1 jam terakhir (3600000 ms)
            const MAX_AGE_MILLISECONDS_FOR_NOTIFICATION = 1 * 60 * 60 * 1000; 

            if (ageInMilliseconds <= MAX_AGE_MILLISECONDS_FOR_NOTIFICATION) {
                isFreshEnoughForNotification = true;
            } else {
                console.log(`[scan-patterns] Pattern ID ${patternId} is too old for FCM notification (age: ${(ageInMilliseconds / (1000 * 60)).toFixed(1)} mins). Breakout: ${new Date(effectiveTimestamp).toISOString()}`);
            }
        } else {
            // Jika tidak ada timestamp yang jelas, mungkin kita tetap kirim jika ini pertama kali terdeteksi
            // Atau Anda bisa memilih untuk tidak mengirim sama sekali.
            console.log(`[scan-patterns] No clear effectiveTimestamp for pattern ID ${patternId}. Defaulting to fresh if new.`);
            isFreshEnoughForNotification = true; // Atau false jika Anda ingin lebih ketat
        }

        if (isFreshEnoughForNotification) {
            const topic = `signals_${pattern.symbol.toUpperCase()}`;
            const title = `Sinyal ${pattern.patternType} BARU!`; // Judul lebih menarik
            const bodyText = `${pattern.symbol}: ${pattern.status || 'Pola terdeteksi'}. Breakout @ ${pattern.breakoutConfirmation?.closePrice?.toFixed(2) || 'N/A'}. Target ${pattern.projection?.targetPrice ? pattern.projection.targetPrice.toFixed(2) : 'N/A'}.`;
            
            console.log(`[scan-patterns] Preparing to send FRESH FCM for: ${title} - ${bodyText} to topic ${topic}`);
            await sendFcmNotification(topic, title, bodyText, pattern);
        } else {
             console.log(`[scan-patterns] Pattern ID ${patternId} (already recorded or too old for FCM) will not trigger FCM.`);
        }
      } else {
        console.log(`[scan-patterns] Pattern ID ${patternId} was already notified (from Firestore). Skipping FCM.`);
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