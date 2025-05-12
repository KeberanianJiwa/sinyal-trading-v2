// File: api/test-bitget.js
import axios from 'axios';

export default async function handler(request, response) {
  try {
    // URL endpoint API Bitget untuk mendapatkan daftar simbol spot publik
    const bitgetApiUrl = 'https://api.bitget.com/api/v2/spot/public/symbols';

    // Melakukan permintaan GET ke API Bitget menggunakan axios
    const apiResponse = await axios.get(bitgetApiUrl);

    // Mengirimkan data yang diterima dari Bitget sebagai respons
    // Data simbol biasanya ada di dalam `apiResponse.data.data` atau `apiResponse.data`
    // tergantung struktur respons Bitget
    if (apiResponse.data && apiResponse.data.code === "00000") { // "00000" biasanya kode sukses di Bitget
        response.status(200).json({
            message: 'Berhasil mengambil data dari Bitget!',
            data: apiResponse.data.data // atau sesuaikan dengan struktur data simbol
        });
    } else {
        // Jika Bitget mengembalikan respons yang tidak diharapkan (bukan error jaringan)
        response.status(500).json({
            message: 'Gagal mengambil data dari Bitget atau format respons tidak sesuai.',
            bitgetResponse: apiResponse.data
        });
    }

  } catch (error) {
    // Menangani error jika terjadi masalah saat menghubungi API Bitget
    console.error('Error fetching data from Bitget:', error.message);

    let errorDetails = {
        message: 'Terjadi kesalahan internal saat menghubungi API Bitget.',
        errorMessage: error.message
    };

    if (error.response) {
        // Server Bitget merespons dengan status error (4xx, 5xx)
        errorDetails.bitgetStatus = error.response.status;
        errorDetails.bitgetData = error.response.data;
    } else if (error.request) {
        // Permintaan dibuat tapi tidak ada respons yang diterima
        errorDetails.message = 'Tidak ada respons dari server Bitget.';
    }

    response.status(500).json(errorDetails);
  }
}