const fs = require('fs');
const path = require('path');

const authDir = path.join(__dirname, 'session_auth');

if (fs.existsSync(authDir)) {
    try {
        fs.rmSync(authDir, { recursive: true, force: true });
        console.log('==================================================');
        console.log('✅ SESI NOMOR WHATSAPP LAMA BERHASIL DIPUTUSKAN!');
        console.log('==================================================');
        console.log('📁 Folder session_auth telah dibersihkan.');
        console.log('👉 Token Google Drive Anda tetap aman (tidak terhapus).\n');
        console.log('Langkah selanjutnya:');
        console.log('1. Jalankan kembali: node index.js');
        console.log('2. Buka WhatsApp di HP nomor baru > Perangkat Tertaut > Scan QR Code baru.\n');
    } catch (err) {
        console.error('❌ Gagal menghapus sesi:', err.message);
        console.log('💡 Pastikan proses "node index.js" sudah dihentikan (Ctrl + C) sebelum mereset sesi.');
    }
} else {
    console.log('ℹ️ Belum ada sesi WhatsApp yang tersimpan.');
}
