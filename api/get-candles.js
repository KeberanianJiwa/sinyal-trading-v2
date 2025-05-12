// File: api/get-candles.js
import axios from 'axios';

export default async function handler(request, response) {
  // Ambil simbol dari query parameter URL (misalnya, /api/get-candles?symbol=BTCUSDT)
  const { symbol } = request.query;

  if (!symbol) {
    return response.status(400).json({ message: 'Parameter "symbol" diperlukan.' });
  }

  const granularity = '1H'; // Interval 1 jam sesuai permintaan
  const limit = 200;      // Ambil 200 data candlestick terakhir

  try {
    const bitgetApiUrl = `https://api.bitget.com/api/v2/spot/public/candles`;

    console.log(`Workspaceing candles for: ${symbol.toUpperCase()}, Granularity: ${granularity}, Limit: ${limit}`);

    const apiResponse = await axios.get(bitgetApiUrl, {
      params: {
        symbol: symbol.toUpperCase(), // Pastikan simbol dalam huruf besar
        granularity: granularity,
        limit: limit,
      },
    });

    // Bitget mengembalikan data dalam format: [timestamp, open, high, low, close, baseVolume, quoteVolume]
    // Kita ubah menjadi format yang lebih mudah dibaca (array of objects)
    if (apiResponse.data && apiResponse.data.code === "00000" && Array.isArray(apiResponse.data.data)) {
      const candles = apiResponse.data.data.map(candle => ({
        timestamp: parseInt(candle[0]), // Timestamp (ms)
        open: parseFloat(candle[1]),
        high: parseFloat(candle[2]),
        low: parseFloat(candle[3]),
        close: parseFloat(candle[4]),
        volume: parseFloat(candle[5]),      // baseVolume
        quoteVolume: parseFloat(candle[6]) // quoteVolume
      })).sort((a, b) => a.timestamp - b.timestamp); // Urutkan dari yang terlama ke terbaru (Bitget kadang mengembalikan dari terbaru)


      response.status(200).json({
        message: `Berhasil mengambil ${candles.length} data candlestick untuk ${symbol.toUpperCase()} (1 Jam)`,
        symbol: symbol.toUpperCase(),
        granularity: granularity,
        data: candles,
      });
    } else {
      console.error('Invalid data structure from Bitget or error code:', apiResponse.data);
      response.status(500).json({
        message: 'Gagal mengambil data candlestick dari Bitget atau format respons tidak sesuai.',
        bitgetResponse: apiResponse.data,
      });
    }
  } catch (error) {
    console.error(`Error fetching candles for ${symbol}:`, error.message);

    let errorDetails = {
        message: `Terjadi kesalahan internal saat menghubungi API Bitget untuk data candlestick ${symbol}.`,
        errorMessage: error.message,
    };

    if (error.response) {
        errorDetails.bitgetStatus = error.response.status;
        errorDetails.bitgetData = error.response.data;
        console.error('Bitget API Error Response:', error.response.data);
    } else if (error.request) {
        errorDetails.message = `Tidak ada respons dari server Bitget untuk data candlestick ${symbol}.`;
    }
    response.status(500).json(errorDetails);
  }
}