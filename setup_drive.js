const fs = require('fs');
const http = require('http');
const url = require('url');
const readline = require('readline');
const { getOAuth2Client, SCOPES, TOKEN_PATH, CREDENTIALS_PATH } = require('./googleDrive');

async function main() {
    console.log('==================================================');
    console.log('   PANDUAN SETUP KONEKSI GOOGLE DRIVE API');
    console.log('==================================================\n');

    if (!fs.existsSync(CREDENTIALS_PATH)) {
        console.error('❌ File credentials.json belum ditemukan di folder ini!\n');
        console.log('Langkah mendapatkan credentials.json:');
        console.log('1. Buka Google Cloud Console: https://console.cloud.google.com/');
        console.log('2. Buat Project baru (atau pilih project yang sudah ada).');
        console.log('3. Buka menu "APIs & Services" > "Enabled APIs & Services".');
        console.log('4. Klik "+ ENABLE APIS AND SERVICES", cari "Google Drive API" lalu klik ENABLE.');
        console.log('5. Buka tab "OAuth consent screen":');
        console.log('   - Pilih User Type "External" -> Create.');
        console.log('   - Isi App Name, email pengembang -> Save and Continue.');
        console.log('   - Pada tab "Test Users", masukkan email Google Anda -> Save and Continue.');
        console.log('6. Buka tab "Credentials":');
        console.log('   - Klik "+ CREATE CREDENTIALS" > "OAuth client ID".');
        console.log('   - Application type: Pilih "Desktop app" (atau "Web application" dengan redirect URI: http://localhost:3000/oauth2callback).');
        console.log('   - Klik CREATE, lalu download file JSON.');
        console.log('7. Ganti nama file yang di-download menjadi "credentials.json" dan taruh di folder proyek ini:');
        console.log('   ' + __dirname + '\n');
        return;
    }

    const oAuth2Client = getOAuth2Client();

    // Buat URL otentikasi
    const authUrl = oAuth2Client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: SCOPES,
    });

    console.log('🔗 Silakan buka link berikut di browser untuk memberikan izin akses Google Drive:');
    console.log('\n--------------------------------------------------');
    console.log(authUrl);
    console.log('--------------------------------------------------\n');

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    console.log('👉 Setelah klik Izinkan/Allow di browser, browser akan membuka halaman kosong "localhost".');
    console.log('👉 SALIN SELURUH ALAMAT WEB (URL) di address bar browser Anda yang ada tulisan "http://localhost/?...code=...", lalu paste di bawah ini:\n');

    rl.question('Paste URL lengkap atau Kode di sini: ', async (input) => {
        rl.close();
        let code = input.trim();

        // Otomatis ekstrak nilai parameter 'code' jika user paste seluruh URL dari browser
        if (code.includes('code=')) {
            try {
                const targetUrl = code.startsWith('http') ? code : `http://${code}`;
                const parsedUrl = new URL(targetUrl);
                code = parsedUrl.searchParams.get('code') || code;
            } catch (e) {
                const match = code.match(/code=([^&]+)/);
                if (match) {
                    code = decodeURIComponent(match[1]);
                }
            }
        }

        try {
            console.log('\n⏳ Menghubungkan ke Google Drive...');
            const { tokens } = await oAuth2Client.getToken(code.trim());
            fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
            console.log('\n==================================================');
            console.log('✅ SELAMAT! AKUN GOOGLE DRIVE BERHASIL TERHUBUNG!');
            console.log('==================================================');
            console.log(`📁 File token tersimpan di: ${TOKEN_PATH}`);
            console.log('\nSekarang Anda dapat menjalankan bot dengan perintah:');
            console.log('   node index.js\n');
        } catch (err) {
            console.error('\n❌ Gagal menukar kode otentikasi:', err.message);
            console.log('\n💡 Tips: Pastikan Anda menyalin seluruh URL di address bar (dari "http..." sampai selesai), lalu coba jalankan:');
            console.log('   node setup_drive.js');
        }
    });
}

main();
