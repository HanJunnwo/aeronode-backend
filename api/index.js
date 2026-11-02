const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

// Impor gaya Modular untuk Firebase (Standar terbaru)
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');

// 1. Inisialisasi Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// 2. Inisialisasi Firebase Admin
try {
  // Cek agar Firebase tidak diinisialisasi dua kali oleh Vercel
  if (!getApps().length) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    initializeApp({
      credential: cert(serviceAccount)
    });
  }
} catch (error) {
  console.error('Gagal inisialisasi Firebase:', error);
}

// 3. Fungsi Utama (Serverless Function Vercel)
module.exports = async (req, res) => {
  try {
    // A. Tarik Data dari API Publik BMKG
    const bmkgUrl = 'https://data.bmkg.go.id/DataMKG/TEWS/autogempa.json';
    const response = await axios.get(bmkgUrl);
    const gempa = response.data.Infogempa.gempa;

    // Gunakan DateTime BMKG sebagai ID Unik
    const alertId = gempa.DateTime; 

    // B. Cek Duplikasi di Supabase (Cegah Spam Notifikasi)
    const { data: existingLog, error: fetchError } = await supabase
      .from('alert_logs')
      .select('id')
      .eq('alert_id', alertId)
      .single();

    if (fetchError && fetchError.code !== 'PGRST116') {
      throw fetchError;
    }

    if (existingLog) {
      // Jika data sudah ada, hentikan proses (Jangan kirim ke Firebase lagi)
      return res.status(200).json({ 
        status: 'skipped', 
        message: 'Data gempa sudah diproses sebelumnya.', 
        alertId 
      });
    }

    // C. Jika data baru, siapkan Payload JSON untuk disimpan & dikirim
    const payloadJson = {
        tanggal: gempa.Tanggal,
        jam: gempa.Jam,
        magnitude: gempa.Magnitude,
        kedalaman: gempa.Kedalaman,
        wilayah: gempa.Wilayah,
        potensi: gempa.Potensi,
        coordinates: gempa.Coordinates
    };

    // Simpan ke Supabase (alert_logs)
    const { error: insertError } = await supabase
      .from('alert_logs')
      .insert([
        { alert_id: alertId, type: 'gempa', payload_json: payloadJson }
      ]);

    if (insertError) throw insertError;

    // D. Tembakkan Push Notification (FCM) menggunakan Modular API
    const message = {
      topic: 'darurat_sumut',
      data: {
        type: 'gempa',
        payload: JSON.stringify(payloadJson) 
      },
      notification: {
        title: `Peringatan Gempa M ${gempa.Magnitude}`,
        body: `${gempa.Wilayah}. Potensi: ${gempa.Potensi}`
      }
    };

    await getMessaging().send(message);

    // Respon sukses
    return res.status(200).json({ 
      status: 'success', 
      message: 'Peringatan gempa baru berhasil disebar ke Firebase FCM!', 
      data: payloadJson 
    });

  } catch (error) {
    console.error('Terjadi kesalahan sistem:', error);
    return res.status(500).json({ error: error.message });
  }
};