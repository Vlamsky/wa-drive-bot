# 🤖 WhatsApp to Google Drive Bot (Original Quality & Large File Support)

Bot WhatsApp otomatis yang menerima file/media dari WhatsApp dan langsung mengunggahnya ke **Google Drive** pribadi Anda dengan **resolusi 100% asli tanpa kompresi** dan mendukung file besar hingga **2 GB**.

---

## 🌟 Fitur Utama
1. **Resolusi 100% Utuh (Tanpa Kompresi):** Mengambil binary file asli dari WhatsApp dan mengunggahnya ke Google Drive tanpa pemrosesan/kompresi.
2. **Dukungan File Besar (Hingga 2 GB):** Menggunakan teknik *Stream Download & Stream Upload* (hemat memori RAM, tidak crash saat memproses file bergigabyte).
3. **Mendukung Semua Format File:**
   - **Foto / Gambar:** RAW (`.CR2`, `.NEF`, `.ARW`), `.DNG`, `.HEIC`, `.PNG`, `.JPG`, `.WEBP`, dll.
   - **Video:** `.MP4`, `.MKV`, `.MOV`, `.AVI`, ProRes, 4K/60fps, dll.
   - **Dokumen & Data:** `.PDF`, `.ZIP`, `.RAR`, `.7Z`, `.DOCX`, `.XLSX`, `.ISO`, dll.
   - **Audio:** `.FLAC`, `.WAV`, `.MP3`, `.M4A`, dll.
4. **Organisasi Otomatis:** Otomatis membuat subfolder per tanggal (`YYYY-MM-DD`) di Google Drive agar file tertata rapi.
5. **Whitelist Pengirim:** Anda dapat membatasi bot agar hanya merespons nomor Anda sendiri.
6. **Notifikasi Interaktif:** Bot otomatis membalas chat WA:
   - Notifikasi saat file mulai diunduh.
   - Notifikasi saat proses upload ke Google Drive sedang berlangsung.
   - Notifikasi sukses beserta **Link Langsung ke Google Drive**.

---

## 🚀 Panduan Instalasi & Penggunaan

### Langkah 1: Siapkan Google Drive API (Sekali Saja)
1. Buka [Google Cloud Console](https://console.cloud.google.com/).
2. Buat Project baru (misal: `WA-Drive-Uploader`).
3. Buka menu **APIs & Services** > **Library**, cari **Google Drive API** lalu klik **Enable**.
4. Buka menu **OAuth consent screen**:
   - Pilih **External** lalu klik **Create**.
   - Masukkan App name (misal: `WA Bot Drive`), User support email, dan Developer email. Klik **Save and Continue**.
   - Pada bagian **Test Users**, klik **Add Users** dan masukkan alamat email Google Anda sendiri. Klik **Save and Continue**.
5. Buka menu **Credentials**:
   - Klik **+ CREATE CREDENTIALS** > **OAuth client ID**.
   - Pilih Application type: **Desktop app**.
   - Klik **Create**, lalu klik tombol **Download JSON**.
6. Ganti nama file hasil download tersebut menjadi `credentials.json`, lalu pindahkan ke folder proyek ini (`wa drive/`).

---

### Langkah 2: Otorisasi Akun Google Drive
Jalankan perintah berikut di terminal:
```bash
node setup_drive.js
```
- Skrip akan menampilkan link otentikasi Google.
- Buka link tersebut di browser Anda, login dengan akun Google Anda, dan klik **Lanjutkan/Izinkan**.
- Salin kode otorisasi yang muncul, lalu tempelkan (*paste*) ke terminal dan tekan **Enter**.
- File `token.json` akan otomatis dibuat.

---

### Langkah 3: Konfigurasi (.env)
Buka file `.env` di teks editor Anda:
```env
# ID Folder Google Drive tujuan (dapat dilihat dari URL folder di Drive Anda)
# Kosongkan jika ingin upload ke root My Drive
GOOGLE_DRIVE_FOLDER_ID=

# Buat subfolder tanggal otomatis (YYYY-MM-DD)?
AUTO_DATE_FOLDER=true

# Nomor WA yang boleh upload (pisahkan koma jika lebih dari satu)
# Contoh: 6281234567890
# Isi '*' jika ingin membolehkan semua
ALLOWED_NUMBERS=*

# Batas maksimal ukuran file dalam MB (WhatsApp max 2000 MB = 2 GB)
MAX_FILE_SIZE_MB=2000
```

---

### Langkah 4: Jalankan Bot
Jalankan bot dengan perintah:
```bash
node index.js
```
1. QR Code akan muncul di terminal.
2. Buka WhatsApp di HP Anda:
   - Masuk ke **Pengaturan / Titik Tiga** > **Perangkat Tertaut (Linked Devices)**.
   - Klik **Tautkan Perangkat** > Scan QR Code di terminal.
3. Selesai! Bot sekarang aktif.

---

## 💡 Tips Penting: Cara Mengirim File Tanpa Terkompres
Agar foto/video tidak dikompres oleh WhatsApp:
1. Di chat WhatsApp, klik icon **Klip Kertas (+) / Lampiran**.
2. Pilih opsi **"Dokumen" (Document)** (JANGAN pilih "Galeri" / "Foto & Video").
3. Pilih foto, video, atau file yang ingin dikirim.
4. Kirim! WhatsApp akan mengirimkan file 100% sesuai ukuran dan kualitas aslinya ke bot, dan bot langsung mengunggahnya ke Google Drive Anda.
