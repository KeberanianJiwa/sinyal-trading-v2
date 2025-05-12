// File: api/scan-patterns.js
import axios from 'axios';

// Daftar fungsi deteksi pola yang akan dipanggil
// (Nama fungsi sesuai dengan nama file API kita)
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
}

export default async function handler(request, response) {
  const { symbol } = request.query;

  if (!symbol) {
    return response.status(400).json({ message: 'Parameter "symbol" diperlukan.' });
  }

  const upperSymbol = symbol.toUpperCase();
  console.log(`[scan-patterns] Starting scan for symbol: ${upperSymbol}`);

  const protocol = request.headers['x-forwarded-proto'] || 'http';
  const host = request.headers.host;

  // Buat array of Promises untuk memanggil semua API deteksi secara paralel
  const detectionPromises = patternDetectors.map(detectorName => {
    const apiUrl = `${protocol}://${host}/api/${detectorName}`;
    console.log(`[scan-patterns] Calling: ${apiUrl}?symbol=${upperSymbol}`);
    // Set timeout untuk mencegah proses menunggu terlalu lama jika satu endpoint lambat
    const timeoutMs = 30000; // 30 detik timeout per endpoint
    return axios.get(apiUrl, {
      params: { symbol: upperSymbol },
      headers: { 'Accept': 'application/json' },
      timeout: timeoutMs
    })
    .then(res => ({
        status: 'fulfilled',
        detector: detectorName,
        data: res.data // Berisi { message, patterns?, ... }
    }))
    .catch(error => {
        console.error(`[scan-patterns] Error calling ${detectorName} for ${upperSymbol}:`, error.message);
        // Tangkap detail error jika ada respons dari server (meskipun error)
        const errorData = error.response ? error.response.data : { message: error.message };
         return {
            status: 'rejected',
            detector: detectorName,
            reason: errorData
        };
    });
  });

  // Jalankan semua promise secara paralel dan tunggu hasilnya
  // Menggunakan Promise.allSettled agar kita mendapatkan hasil meskipun beberapa gagal
  const results = await Promise.allSettled(detectionPromises);

  console.log('[scan-patterns] All detection calls completed.');

  let allDetectedPatterns = [];
  let errors = [];
  let parametersUsed = {}; // Ambil parameter dari salah satu hasil sukses jika perlu

  results.forEach(result => {
    // Promise.allSettled membungkus hasil asli
    if (result.status === 'fulfilled' && result.value.status === 'fulfilled') {
      const outcome = result.value; // Hasil dari then() di atas
      const detectorName = outcome.detector;
      const responseData = outcome.data;

      console.log(`[scan-patterns] Result from ${detectorName}: ${responseData.message}`);

      // Jika endpoint mengembalikan pola terkonfirmasi
      if (responseData.patterns && Array.isArray(responseData.patterns) && responseData.patterns.length > 0) {
        // Tambahkan tipe pola ke setiap objek pola sebelum digabung
        const patternsWithType = responseData.patterns.map(p => ({
          ...p,
          patternType: patternTypeMapping[detectorName] || detectorName // Tambahkan nama pola
        }));
        allDetectedPatterns = allDetectedPatterns.concat(patternsWithType);

        // Simpan parameter yang digunakan dari pemanggilan pertama yang sukses
        if (Object.keys(parametersUsed).length === 0 && responseData.parameters_used) {
            parametersUsed = responseData.parameters_used; // Asumsi parameter sama untuk semua
        }
      }
    } else if (result.status === 'fulfilled' && result.value.status === 'rejected') {
        // Kasus di mana panggilan axios di dalam Promise berhasil ditangani catch()
        const outcome = result.value;
        console.error(`[scan-patterns] Detector ${outcome.detector} failed:`, outcome.reason);
        errors.push({ detector: outcome.detector, reason: outcome.reason });
    } else {
      // Kasus di mana Promise itu sendiri gagal (jarang terjadi dengan struktur di atas)
      console.error(`[scan-patterns] Promise failed unexpectedly:`, result.reason);
      errors.push({ detector: 'unknown', reason: result.reason?.message || 'Unknown promise rejection' });
    }
  });

  console.log(`[scan-patterns] Total confirmed patterns found across all types: ${allDetectedPatterns.length}`);

  // Kirim respons gabungan
  response.status(200).json({
    symbol: upperSymbol,
    scanTime: new Date().toISOString(),
    detectedPatterns: allDetectedPatterns, // Array gabungan semua pola terkonfirmasi
    parametersUsed: parametersUsed, // Menampilkan parameter dari salah satu detektor
    errors: errors // Menampilkan jika ada error dari pemanggilan API individual
  });
}