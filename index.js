const fs = require('fs');
const path = require('path');
const { 
    makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    downloadContentFromMessage,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const mime = require('mime-types');
require('dotenv').config();

const { 
    uploadFileStream, 
    deleteFileFromDrive, 
    getDriveQuota, 
    searchDriveFiles, 
    downloadFileFromDrive, 
    setFilePermission 
} = require('./googleDrive');

// Direktori penyimpanan session WhatsApp, folder sementara, dan riwayat
const AUTH_DIR = path.join(__dirname, 'session_auth');
const TEMP_DIR = path.join(__dirname, 'temp_downloads');
const HISTORY_FILE = path.join(__dirname, 'upload_history.json');
const WHITELIST_FILE = path.join(__dirname, 'whitelist.json');
const FOLDER_SESSIONS_FILE = path.join(__dirname, 'folder_sessions.json');

if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}

/**
 * Mengambil mapping folder sesi per pengguna
 */
function getFolderSessions() {
    try {
        if (fs.existsSync(FOLDER_SESSIONS_FILE)) {
            return JSON.parse(fs.readFileSync(FOLDER_SESSIONS_FILE, 'utf8'));
        }
    } catch (e) {}
    return {};
}

/**
 * Mengambil nama folder sesi aktif milik user
 */
function getUserFolderSession(phone) {
    if (!phone) return null;
    const sessions = getFolderSessions();
    return sessions[phone] || null;
}

/**
 * Menyetel folder sesi aktif untuk user
 */
function setUserFolderSession(phone, folderName) {
    if (!phone) return;
    const sessions = getFolderSessions();
    sessions[phone] = folderName;
    fs.writeFileSync(FOLDER_SESSIONS_FILE, JSON.stringify(sessions, null, 2));
}

/**
 * Menghapus folder sesi aktif user (kembali ke tanggal harian)
 */
function clearUserFolderSession(phone) {
    if (!phone) return null;
    const sessions = getFolderSessions();
    const prev = sessions[phone];
    delete sessions[phone];
    fs.writeFileSync(FOLDER_SESSIONS_FILE, JSON.stringify(sessions, null, 2));
    return prev;
}


/**
 * Format bytes menjadi ukuran yang mudah dibaca (KB, MB, GB, TB)
 */
function formatBytes(bytes, decimals = 2) {
    if (!bytes || bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

/**
 * Membuat visual progress bar (contoh: [████████░░░░] 60%)
 */
function makeProgressBar(percent) {
    const totalBars = 10;
    const clamped = Math.max(0, Math.min(100, percent));
    const filled = Math.round((clamped / 100) * totalBars);
    const empty = totalBars - filled;
    return '[' + '█'.repeat(filled) + '░'.repeat(empty) + ']';
}

/**
 * Deteksi kategori cerdas berdasarkan ekstensi dan mime type
 */
function getSmartCategory(fileName, mimetype = '') {
    const ext = path.extname(fileName || '').toLowerCase().replace('.', '');
    const mimeStr = (mimetype || '').toLowerCase();

    if (['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'csv', 'odt', 'rtf'].includes(ext) || 
        mimeStr.includes('pdf') || mimeStr.includes('word') || mimeStr.includes('sheet') || mimeStr.includes('presentation') || mimeStr.includes('document')) {
        return 'Dokumen';
    }
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'bmp', 'svg', 'tiff'].includes(ext) || mimeStr.startsWith('image/')) {
        return 'Foto_Gambar';
    }
    if (['mp4', 'mkv', 'mov', 'avi', 'flv', '3gp', 'wmv'].includes(ext) || mimeStr.startsWith('video/')) {
        return 'Video';
    }
    if (['mp3', 'm4a', 'wav', 'aac', 'opus', 'ogg', 'flac'].includes(ext) || mimeStr.startsWith('audio/')) {
        return 'Audio';
    }
    if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2'].includes(ext) || mimeStr.includes('zip') || mimeStr.includes('compressed')) {
        return 'Arsip';
    }
    return 'Lainnya';
}

// Antrean batch upload untuk notifikasi rapi (Smart Batch Digest - Anti-Spam)
const batchUploadQueue = new Map();

function scheduleBatchDigest(sock, remoteJid, uploadItem) {
    let queue = batchUploadQueue.get(remoteJid);
    if (!queue) {
        queue = { timer: null, items: [], folderName: uploadItem.folder, folderLink: uploadItem.folderLink };
        batchUploadQueue.set(remoteJid, queue);
    }

    queue.items.push(uploadItem);
    if (uploadItem.folder) queue.folderName = uploadItem.folder;
    if (uploadItem.folderLink) queue.folderLink = uploadItem.folderLink;

    if (queue.timer) {
        clearTimeout(queue.timer);
    }

    // Debounce 3.5 detik: tunggu sampai batch pengiriman forward selesai
    queue.timer = setTimeout(async () => {
        try {
            const currentQueue = batchUploadQueue.get(remoteJid);
            if (!currentQueue || currentQueue.items.length === 0) return;

            const items = [...currentQueue.items];
            const folder = currentQueue.folderName || 'Root Drive';
            const folderLink = currentQueue.folderLink;
            batchUploadQueue.delete(remoteJid);

            if (items.length === 1) {
                // Tampilan 1 File (Sleek Minimalist Card)
                const file = items[0];
                let msg = 
                    `╭── ☁️ DRIVE CLOUD [SYNCED] ──\n` +
                    `│ 📄 \`${file.name}\`\n` +
                    `│ 📦 Ukuran: ${file.size}\n` +
                    `│ 📁 Folder: \`${folder}\`\n` +
                    `│ 🕒 ${file.time}\n` +
                    `├─ 🔗 AKSES CEPAT ────────────\n` +
                    `│ 📄 File: ${file.link}\n`;
                if (folderLink) {
                    msg += `│ 📂 Folder: ${folderLink}\n`;
                }
                msg += 
                    `╰────────────────────────────\n` +
                    `💡 _Ketik *menu* untuk opsi lain atau *ambil 1* untuk kirim ke WA._`;

                await sock.sendMessage(remoteJid, { text: msg });
            } else {
                // Tampilan Banyak File / Forward Massal (Batch Digest Card)
                const totalBytes = items.reduce((acc, it) => acc + (it.bytes || 0), 0);
                const totalFormatted = totalBytes > 0 ? formatBytes(totalBytes) : `${items.length} Berkas`;

                let msg = 
                    `╭── 📦 BATCH SYNC COMPLETED ──\n` +
                    `│ ✨ Berhasil upload \`${items.length} file\` sekaligus\n` +
                    `│ 📁 Folder: \`${folder}\`\n` +
                    `│ 💾 Total Size: \`${totalFormatted}\`\n` +
                    `├─ 📋 DAFTAR FILE TERUNGGAH ──\n`;

                items.slice(0, 15).forEach((item, idx) => {
                    msg += `│ ${idx + 1}. \`${item.name}\` (${item.size})\n`;
                });

                if (items.length > 15) {
                    msg += `│ ... dan ${items.length - 15} file lainnya.\n`;
                }

                if (folderLink) {
                    msg += `├─ 📂 BUKA FOLDER LENGKAP ────\n│ ${folderLink}\n`;
                }
                msg += 
                    `╰────────────────────────────\n` +
                    `💡 _Ketik *cek* untuk melihat nomor riwayat atau *ambil <no>*._`;

                await sock.sendMessage(remoteJid, { text: msg });
            }
        } catch (e) {
            console.error('Error sending batch digest:', e);
        }
    }, 3500);
}


/**
 * Menyimpan riwayat file yang berhasil di-upload
 */
function saveToHistory(entry) {
    let history = [];
    try {
        if (fs.existsSync(HISTORY_FILE)) {
            history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
        }
    } catch (e) {
        history = [];
    }
    history.unshift(entry);
    if (history.length > 50) history = history.slice(0, 50);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

/**
 * Menghapus file tertentu dari riwayat lokal (Hanya jika milik user tersebut atau Owner)
 */
function deleteFromHistory(fileId, userPhone = null) {
    try {
        if (fs.existsSync(HISTORY_FILE)) {
            let history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
            const item = history.find(h => 
                h.id === fileId && 
                (!userPhone || userPhone === 'ALL' || !h.uploader || h.uploader === userPhone || h.uploader.endsWith(userPhone) || userPhone.endsWith(h.uploader))
            );
            if (!item) return null;
            history = history.filter(h => h.id !== fileId);
            fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
            return item;
        }
    } catch (e) {}
    return null;
}

/**
 * Mengambil riwayat unggahan (Khusus untuk user tertentu agar tidak bercampur)
 */
function getHistory(userPhone = null, limit = 10) {
    try {
        if (fs.existsSync(HISTORY_FILE)) {
            let list = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
            if (userPhone && userPhone !== 'ALL') {
                list = list.filter(item => 
                    !item.uploader || 
                    item.uploader === userPhone || 
                    item.uploader.endsWith(userPhone) || 
                    userPhone.endsWith(item.uploader)
                );
            }
            return list.slice(0, limit);
        }
    } catch (e) {}
    return [];
}

/**
 * Mengubah WhatsApp LID (Privacy ID) menjadi nomor telepon asli berdasarkan sesi Baileys
 */
function resolveLidToPhone(rawJid) {
    if (!rawJid) return null;
    const clean = rawJid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');

    try {
        if (fs.existsSync(AUTH_DIR)) {
            const files = fs.readdirSync(AUTH_DIR);
            for (const file of files) {
                if (file.startsWith('lid-mapping-') && !file.includes('_reverse')) {
                    const filePath = path.join(AUTH_DIR, file);
                    const content = fs.readFileSync(filePath, 'utf8');
                    if (content.includes(clean)) {
                        return file.replace('lid-mapping-', '').replace('.json', '');
                    }
                }
            }
        }
    } catch (e) {}

    return null;
}

/**
 * Normalisasi format nomor telepon
 */
function normalizePhone(num) {
    if (!num) return '';
    let clean = num.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
    if (clean.startsWith('0')) clean = '62' + clean.slice(1);
    return clean;
}

/**
 * Mengambil daftar nomor yang diizinkan (gabungan whitelist.json dan .env)
 */
function getWhitelist() {
    let list = [];
    try {
        if (fs.existsSync(WHITELIST_FILE)) {
            list = JSON.parse(fs.readFileSync(WHITELIST_FILE, 'utf8'));
        }
    } catch (e) {
        list = [];
    }
    // Gabungkan dengan ALLOWED_NUMBERS dari .env
    const envAllowed = (process.env.ALLOWED_NUMBERS || '').split(',').map(n => normalizePhone(n)).filter(Boolean);
    envAllowed.forEach(num => {
        if (!list.includes(num)) list.push(num);
    });
    return list;
}

/**
 * Menyimpan whitelist ke file whitelist.json
 */
function saveWhitelist(list) {
    fs.writeFileSync(WHITELIST_FILE, JSON.stringify(list, null, 2));
}

/**
 * Menambahkan nomor ke whitelist
 */
function addWhitelistUser(number) {
    const clean = normalizePhone(number);
    if (!clean || clean.length < 5) return null;
    let list = getWhitelist();
    if (!list.includes(clean)) {
        list.push(clean);
        saveWhitelist(list);
    }
    return clean;
}

/**
 * Menghapus nomor dari whitelist
 */
function removeWhitelistUser(number) {
    const clean = normalizePhone(number);
    if (!clean) return null;
    let list = getWhitelist();
    const beforeLen = list.length;
    list = list.filter(n => n !== clean && !n.endsWith(clean) && !clean.endsWith(n));
    saveWhitelist(list);
    return beforeLen !== list.length ? clean : null;
}

/**
 * Cek apakah pengirim adalah Owner/Admin bot
 */
function isOwner(remoteJid, isFromMe, participant) {
    if (isFromMe) return true;
    const jidClean = normalizePhone(remoteJid);
    const partClean = normalizePhone(participant);
    const resolvedPhoneJid = normalizePhone(resolveLidToPhone(remoteJid) || '');
    const resolvedPhonePart = normalizePhone(resolveLidToPhone(participant) || '');

    const candidates = [jidClean, partClean, resolvedPhoneJid, resolvedPhonePart].filter(Boolean);

    // Ambil nomor admin dari .env (default nomor utama Anda)
    const adminList = (process.env.ALLOWED_NUMBERS || '6281230129867,42331331928234')
        .split(',')
        .map(n => normalizePhone(n))
        .filter(Boolean);

    return adminList.some(admin => 
        candidates.some(cand => cand === admin || cand.endsWith(admin) || admin.endsWith(cand))
    );
}

/**
 * Cek apakah pengirim diizinkan (Whitelist)
 */
function isSenderAllowed(jid, fromMe, participant) {
    const allowed = process.env.ALLOWED_NUMBERS?.trim();
    if (allowed === '*') return true;
    if (fromMe) return true;

    const allowedList = getWhitelist();

    const jidClean = normalizePhone(jid);
    const partClean = normalizePhone(participant);

    const resolvedPhoneJid = normalizePhone(resolveLidToPhone(jid) || '');
    const resolvedPhonePart = normalizePhone(resolveLidToPhone(participant) || '');

    const candidates = [jidClean, partClean, resolvedPhoneJid, resolvedPhonePart].filter(Boolean);

    return allowedList.some(num => 
        candidates.some(cand => cand === num || cand.endsWith(num) || num.endsWith(cand))
    );
}

/**
 * Mengekstrak payload media dan caption dari berbagai jenis pesan
 */
function extractMediaContent(message) {
    if (!message) return null;

    const unwrapMsg = message.viewOnceMessage?.message || 
                     message.viewOnceMessageV2?.message || 
                     message.documentWithCaptionMessage?.message || 
                     message;

    let caption = '';

    if (unwrapMsg.documentMessage) {
        caption = unwrapMsg.documentMessage.caption || message.documentWithCaptionMessage?.message?.documentMessage?.caption || '';
        return {
            type: 'document',
            payload: unwrapMsg.documentMessage,
            fileName: unwrapMsg.documentMessage.fileName || `doc_${Date.now()}`,
            mimetype: unwrapMsg.documentMessage.mimetype || 'application/octet-stream',
            fileLength: Number(unwrapMsg.documentMessage.fileLength || 0),
            caption: caption.trim()
        };
    }

    if (unwrapMsg.imageMessage) {
        caption = unwrapMsg.imageMessage.caption || '';
        const ext = mime.extension(unwrapMsg.imageMessage.mimetype) || 'jpg';
        return {
            type: 'image',
            payload: unwrapMsg.imageMessage,
            fileName: `IMG_${Date.now()}.${ext}`,
            mimetype: unwrapMsg.imageMessage.mimetype || 'image/jpeg',
            fileLength: Number(unwrapMsg.imageMessage.fileLength || 0),
            caption: caption.trim()
        };
    }

    if (unwrapMsg.videoMessage) {
        caption = unwrapMsg.videoMessage.caption || '';
        const ext = mime.extension(unwrapMsg.videoMessage.mimetype) || 'mp4';
        return {
            type: 'video',
            payload: unwrapMsg.videoMessage,
            fileName: `VID_${Date.now()}.${ext}`,
            mimetype: unwrapMsg.videoMessage.mimetype || 'video/mp4',
            fileLength: Number(unwrapMsg.videoMessage.fileLength || 0),
            caption: caption.trim()
        };
    }

    if (unwrapMsg.audioMessage) {
        const ext = mime.extension(unwrapMsg.audioMessage.mimetype) || 'mp3';
        return {
            type: 'audio',
            payload: unwrapMsg.audioMessage,
            fileName: `AUD_${Date.now()}.${ext}`,
            mimetype: unwrapMsg.audioMessage.mimetype || 'audio/mpeg',
            fileLength: Number(unwrapMsg.audioMessage.fileLength || 0),
            caption: ''
        };
    }

    return null;
}

/**
 * Mengunduh media secara streaming ke file lokal
 */
async function downloadMediaToDisk(mediaPayload, mediaType, outputPath) {
    const stream = await downloadContentFromMessage(mediaPayload, mediaType);
    const writeStream = fs.createWriteStream(outputPath);

    for await (const chunk of stream) {
        writeStream.write(chunk);
    }

    return new Promise((resolve, reject) => {
        writeStream.end();
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
    });
}

/**
 * Fungsi utama Bot WhatsApp
 */
async function startBot() {
    console.log('🤖 Menginisialisasi WhatsApp Client...');

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: state,
        syncFullHistory: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('\n📲 SILAKAN SCAN QR CODE INI DI WHATSAPP:\n');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const shouldReconnect = 
                (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                console.log('🔄 Menghubungkan kembali...');
                startBot();
            } else {
                console.log('❌ Anda keluar dari sesi (Logged out).');
            }
        } else if (connection === 'open') {
            console.log('==================================================');
            console.log('✅ BOT WHATSAPP GOOGLE DRIVE PREMIUM SUDAH AKTIF!');
            console.log('==================================================');
            console.log('💡 Semua fitur premium & auto-responder aktif.');
            console.log('🚫 Fitur anti-call (tolak otomatis panggilan) aktif.');
            console.log('--------------------------------------------------\n');
        }
    });

    // ==========================================
    // AUTO REJECT CALL (Tolak Telepon & Video Call Otomatis)
    // ==========================================
    sock.ev.on('call', async (calls) => {
        for (const call of calls) {
            if (call.status === 'offer') {
                try {
                    await sock.rejectCall(call.id, call.from);
                    console.log(`🚫 Panggilan dari ${call.from} otomatis ditolak.`);
                    await sock.sendMessage(call.from, {
                        text: `🚫 *Panggilan Ditolak Otomatis*\n\n` +
                              `Nomor ini adalah *Bot WhatsApp Otomatis* dan tidak dapat menerima panggilan suara atau video call.\n\n` +
                              `Silakan kirim pesan teks atau dokumen untuk dilayani oleh bot. Ketik *menu* untuk melihat panduan.`
                    });
                } catch (e) {
                    console.error('Gagal menolak panggilan:', e.message);
                }
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            try {
                if (!msg.message) continue;

                const remoteJid = msg.key.remoteJid;
                const isFromMe = msg.key.fromMe;
                const senderJid = msg.key.participant || remoteJid;

                const senderClean = normalizePhone(resolveLidToPhone(senderJid) || senderJid);
                const senderDisplayName = (msg.pushName || '').replace(/[^a-zA-Z0-9_-]/g, '').trim();
                const userFolderName = senderDisplayName ? `${senderDisplayName}_${senderClean}` : `User_${senderClean}`;
                const userIsOwner = isOwner(remoteJid, isFromMe, msg.key.participant);

                // Jika nomor tidak diizinkan, beri tahu nomor tersebut
                if (!isSenderAllowed(remoteJid, isFromMe, msg.key.participant)) {
                    if (!remoteJid.endsWith('@g.us') && !isFromMe) {
                        await sock.sendMessage(remoteJid, {
                            text: `⛔ *Akses Ditolak*\n\nNomor Anda belum terdaftar di sistem bot ini.\nHubungi pemilik untuk menambahkan nomor Anda ke daftar izin (*whitelist*).`
                        }, { quoted: msg });
                    }
                    continue;
                }

                const textBody = (
                    msg.message.conversation || 
                    msg.message.extendedTextMessage?.text || 
                    ''
                ).trim();
                const lowerText = textBody.toLowerCase();

                // ==========================================
                // 1. FITUR MENU / HELP
                // ==========================================
                if (lowerText === 'menu' || lowerText === 'help' || lowerText === 'bantuan') {
                    const menuText = 
                        `╭── ⚡ GOOGLE DRIVE BOT v2.5 ──\n` +
                        `│ _Cloud Assistant WhatsApp Berkecepatan Tinggi_\n` +
                        `├─ 📥 UPLOAD & FORWARD ────────\n` +
                        `│ • Kirim file langsung ➔ Auto-upload resolusi asli\n` +
                        `│ • Caption \`#nama\` ➔ Masuk folder tertentu\n` +
                        `│ • Tanpa caption ➔ Otomatis masuk kategori cerdas\n` +
                        `├─ 📂 FOLDER MASSAL (FORWARD) ─\n` +
                        `│ • \`folder <nama>\` ➔ Set folder aktif sebelum forward\n` +
                        `│ • \`folder status\` ➔ Cek folder aktif saat ini\n` +
                        `│ • \`folder reset\`  ➔ Kembali ke mode otomatis\n` +
                        `├─ 📋 PERINTAH FILE ──────────\n` +
                        `│ • \`cek\`           ➔ 15 file riwayat Anda\n` +
                        `│ • \`status\` / \`.me\` ➔ Profil & statistik Anda\n` +
                        `│ • \`cari <kata>\`   ➔ Cari file di arsip Anda\n` +
                        `│ • \`kuota\`         ➔ Cek kapasitas penyimpanan\n` +
                        `│ • \`ambil <no>\`    ➔ Kirim file ke WhatsApp\n` +
                        `│ • \`hapus <no>\`    ➔ Hapus file dari Drive\n` +
                        `│ • \`hapus terakhir\`➔ Hapus file paling baru\n` +
                        `│ • \`publik <no>\`   ➔ Buka link untuk umum\n` +
                        `│ • \`privat <no>\`   ➔ Kunci file kembali\n` +
                        `├─ 👑 ADMIN WHITELIST ────────\n` +
                        `│ • \`+user <no>\`    ➔ Tambah nomor izin\n` +
                        `│ • \`-user <no>\`    ➔ Hapus izin nomor\n` +
                        `│ • \`listuser\`      ➔ Cek semua nomor terdaftar\n` +
                        `╰────────────────────────────`;

                    await sock.sendMessage(remoteJid, { text: menuText }, { quoted: msg });
                    continue;
                }

                // ==========================================
                // 1A. FITUR MINI DASHBOARD PERSONAL (.me / status / profil)
                // ==========================================
                if (lowerText === '.me' || lowerText === 'me' || lowerText === 'status' || lowerText === 'profil' || lowerText === 'profile') {
                    const myHistory = getHistory(senderClean, 50);
                    const totalFiles = myHistory.length;
                    const sessionFolder = getUserFolderSession(senderClean) || 'Default (Auto-Category)';

                    let progressBar = '[████░░░░░░]';
                    let percent = 0;
                    let numLimit = 0;
                    let numUsage = 0;
                    try {
                        const quotaData = await getDriveQuota();
                        const { limit, usage } = quotaData.storageQuota;
                        numLimit = Number(limit || 0);
                        numUsage = Number(usage || 0);
                        percent = numLimit > 0 ? Math.round((numUsage / numLimit) * 100) : 0;
                        progressBar = makeProgressBar(percent);
                    } catch (e) {}

                    const profileMsg = 
                        `╭── 👤 PROFIL CLOUD ANDA ─────\n` +
                        `│ 📱 Nomor: \`${senderClean}\`\n` +
                        `│ 🛡️ Status: \`${userIsOwner ? 'OWNER / ADMIN' : 'WHITELIST VERIFIED'}\`\n` +
                        `│ 📂 Folder Sesi: \`${sessionFolder}\`\n` +
                        `├─ 📊 STATISTIK PENGGUNA ─────\n` +
                        `│ 📄 Total File Anda: \`${totalFiles} File\`\n` +
                        `├─ ☁️ STATUS STORAGE BOT ─────\n` +
                        `│ Status: ${progressBar} *${percent}%*\n` +
                        `│ 💾 Terpakai: ${formatBytes(numUsage)} / ${numLimit > 0 ? formatBytes(numLimit) : 'Tak Terbatas'}\n` +
                        `╰────────────────────────────\n` +
                        `💡 _Ketik *menu* untuk opsi lain atau *cek* untuk daftar file._`;

                    await sock.sendMessage(remoteJid, { text: profileMsg }, { quoted: msg });
                    continue;
                }

                // ==========================================
                // 1B. FITUR SET FOLDER SESI (UNTUK FORWARD BANYAK FILE SEKALIGUS)
                // ==========================================
                if (lowerText.startsWith('folder') || lowerText.startsWith('set folder')) {
                    const arg = textBody.replace(/^(set\s+)?folder\s*/i, '').trim();
                    const lowerArg = arg.toLowerCase();

                    if (!arg || lowerArg === 'status' || lowerArg === 'cek') {
                        const current = getUserFolderSession(senderClean);
                        if (current) {
                            await sock.sendMessage(remoteJid, {
                                text: `📁 *Folder Sesi Aktif:*\n📂 *${current}*\n\n` +
                                      `Semua file yang Anda kirim atau teruskan (forward) saat ini akan otomatis masuk ke folder ini tanpa perlu caption #hashtag!\n\n` +
                                      `💡 *Perintah Terkait:*\n` +
                                      `• Ketik *folder reset* ➔ Kembali ke folder tanggal harian\n` +
                                      `• Ketik *folder <nama baru>* ➔ Ganti nama folder`
                            }, { quoted: msg });
                        } else {
                            await sock.sendMessage(remoteJid, {
                                text: `📁 *Mode Folder Sesi Saat Ini: NONAKTIF*\n` +
                                      `File otomatis masuk ke folder tanggal harian.\n\n` +
                                      `💡 *Cara Mudah Teruskan (Forward) Banyak File:* \n` +
                                      `1. Ketik: *folder NamaFolder* (contoh: *folder Berkas_Lomba*)\n` +
                                      `2. Teruskan / forward puluhan file sekaligus dari chat lain ke bot ini.\n` +
                                      `3. Semua file otomatis masuk ke folder *Berkas_Lomba*!\n` +
                                      `4. Ketik *folder reset* bila sudah selesai.`
                            }, { quoted: msg });
                        }
                        continue;
                    }

                    if (lowerArg === 'reset' || lowerArg === 'off' || lowerArg === 'hapus' || lowerArg === 'normal' || lowerArg === 'batal') {
                        const prev = clearUserFolderSession(senderClean);
                        await sock.sendMessage(remoteJid, {
                            text: `🔄 *Folder Sesi Dinonaktifkan!*\n\n` +
                                  (prev ? `Folder sebelumnya (*${prev}*) telah dinonaktifkan.\n` : '') +
                                  `File yang Anda kirim sekarang akan kembali masuk ke folder tanggal harian.`
                        }, { quoted: msg });
                        continue;
                    }

                    // Set folder baru
                    const cleanFolderName = arg.replace(/[^a-zA-Z0-9_\-\s]/g, '').trim().replace(/\s+/g, '_');
                    if (!cleanFolderName) {
                        await sock.sendMessage(remoteJid, {
                            text: `⚠️ Nama folder tidak valid. Contoh: *folder Dokumen_Rapat*`
                        }, { quoted: msg });
                        continue;
                    }

                    setUserFolderSession(senderClean, cleanFolderName);
                    await sock.sendMessage(remoteJid, {
                        text: `📁 *Folder Sesi Berhasil Disetel!* 🎯\n\n` +
                              `📂 Target: *${cleanFolderName}*\n\n` +
                              `✨ *Silakan teruskan (forward) atau kirim file Anda sekarang!*\n` +
                              `Semua file yang Anda kirim akan otomatis tersimpan rapi di dalam folder *${cleanFolderName}*.\n\n` +
                              `💡 Ketik *folder reset* jika sudah selesai mengunggah.`
                    }, { quoted: msg });
                    continue;
                }

                // ==========================================
                // 1C. FITUR MANAJEMEN WHITELIST (+user / -user / listuser)
                // ==========================================
                if (lowerText.startsWith('+user') || lowerText.startsWith('tambah user')) {
                    if (!isOwner(remoteJid, isFromMe, msg.key.participant)) {
                        await sock.sendMessage(remoteJid, {
                            text: '⛔ *Akses Ditolak*\nHanya Owner / Admin yang dapat menambah user ke whitelist.'
                        }, { quoted: msg });
                        continue;
                    }

                    const numTarget = textBody.replace(/^(\+user|tambah user)\s*/i, '').trim();
                    const added = addWhitelistUser(numTarget);

                    if (!added) {
                        await sock.sendMessage(remoteJid, {
                            text: '⚠️ Format nomor tidak valid. Contoh: *+user 081234567890*'
                        }, { quoted: msg });
                    } else {
                        await sock.sendMessage(remoteJid, {
                            text: `✅ *User Berhasil Ditambahkan!*\n\n` +
                                  `📱 *Nomor:* ${added}\n` +
                                  `✨ Sekarang nomor tersebut sudah diizinkan menggunakan bot ini.`
                        }, { quoted: msg });
                    }
                    continue;
                }

                if (lowerText.startsWith('-user') || lowerText.startsWith('hapus user')) {
                    if (!isOwner(remoteJid, isFromMe, msg.key.participant)) {
                        await sock.sendMessage(remoteJid, {
                            text: '⛔ *Akses Ditolak*\nHanya Owner / Admin yang dapat menghapus user dari whitelist.'
                        }, { quoted: msg });
                        continue;
                    }

                    const numTarget = textBody.replace(/^(\-user|hapus user)\s*/i, '').trim();
                    const removed = removeWhitelistUser(numTarget);

                    if (!removed) {
                        await sock.sendMessage(remoteJid, {
                            text: '⚠️ Nomor tidak ditemukan dalam daftar whitelist.'
                        }, { quoted: msg });
                    } else {
                        await sock.sendMessage(remoteJid, {
                            text: `🗑️ *User Berhasil Dihapus!*\n\n` +
                                  `📱 *Nomor:* ${removed}\n` +
                                  `Akses nomor tersebut ke bot telah dinonaktifkan.`
                        }, { quoted: msg });
                    }
                    continue;
                }

                if (lowerText === 'listuser' || lowerText === 'list user' || lowerText === 'users' || lowerText === 'daftar user') {
                    if (!isOwner(remoteJid, isFromMe, msg.key.participant)) {
                        await sock.sendMessage(remoteJid, {
                            text: '⛔ *Akses Ditolak*\nHanya Owner / Admin yang dapat melihat daftar user.'
                        }, { quoted: msg });
                        continue;
                    }

                    const users = getWhitelist();
                    let uMsg = `👥 *DAFTAR USER WHITELIST AKTIF (${users.length}):*\n\n`;
                    users.forEach((u, i) => {
                        uMsg += `${i + 1}. 📱 *${u}*\n`;
                    });
                    uMsg += `\n💡 *Perintah Kelola:*\n• *+user <nomor>* ➔ Tambah izin user\n• *-user <nomor>* ➔ Hapus izin user`;

                    await sock.sendMessage(remoteJid, { text: uMsg }, { quoted: msg });
                    continue;
                }

                // ==========================================
                // 2. FITUR CEK RIWAYAT
                // ==========================================
                if (lowerText === 'cek' || lowerText === 'daftar' || lowerText === 'list' || lowerText === 'riwayat' || (userIsOwner && (lowerText === 'cek all' || lowerText === 'list all'))) {
                    const isCheckAll = userIsOwner && (lowerText === 'cek all' || lowerText === 'list all');
                    const targetUploader = isCheckAll ? 'ALL' : senderClean;
                    const history = getHistory(targetUploader, 15);
                    if (history.length === 0) {
                        await sock.sendMessage(remoteJid, {
                            text: isCheckAll 
                                ? '📭 *Belum Ada Riwayat Unggahan di Bot Ini*'
                                : '📭 *Belum Ada Riwayat Unggahan*\nAnda belum mengunggah file apa pun ke Google Drive via bot ini.'
                        }, { quoted: msg });
                        continue;
                    }

                    let listText = isCheckAll 
                        ? `╭── 📋 SEMUA UNGGAHAN BOT (ADMIN) ──\n│ Total: \`${history.length} file\`\n├────────────────────────────\n`
                        : `╭── 📋 DAFTAR UNGGAHAN ANDA ─\n│ Menampilkan \`${history.length} file\` terbaru\n├────────────────────────────\n`;

                    history.forEach((item, index) => {
                        listText += `│ *${index + 1}.* 📄 \`${item.name}\` (${item.size})\n`;
                        if (isCheckAll && (item.uploaderName || item.uploader)) {
                            listText += `│    👤 Oleh: *${item.uploaderName ? `${item.uploaderName} (${item.uploader})` : item.uploader}*\n`;
                        }
                        if (item.folder) listText += `│    📁 \`${item.folder}\` • 🕒 ${item.time}\n`;
                        listText += `│    🔗 ${item.link}\n│\n`;
                    });
                    listText += `├─ 💡 AKSI CEPAT ────────────\n`;
                    listText += `│ • \`ambil <no>\`  ➔ Unduh ke WhatsApp\n`;
                    listText += `│ • \`hapus <no>\`  ➔ Hapus file dari Drive\n`;
                    listText += `│ • \`publik <no>\` ➔ Buka akses file link\n`;
                    if (userIsOwner && !isCheckAll) {
                        listText += `│ • \`cek all\`     ➔ Lihat unggahan semua user\n`;
                    }
                    listText += `╰────────────────────────────`;

                    await sock.sendMessage(remoteJid, { text: listText }, { quoted: msg });
                    continue;
                }

                // ==========================================
                // 3. FITUR CEK KUOTA (STORAGE BAR)
                // ==========================================
                if (lowerText === 'kuota' || lowerText === 'storage' || lowerText === 'kapasitas') {
                    try {
                        const quotaData = await getDriveQuota();
                        const { limit, usage } = quotaData.storageQuota;

                        const numLimit = Number(limit || 0);
                        const numUsage = Number(usage || 0);
                        const percent = numLimit > 0 ? Math.round((numUsage / numLimit) * 100) : 0;
                        const progressBar = makeProgressBar(percent);

                        const quotaMsg = 
                            `╭── 📊 STORAGE GOOGLE DRIVE ─\n` +
                            `│ Status: ${progressBar} *${percent}%*\n` +
                            `├────────────────────────────\n` +
                            `│ 💾 Terpakai : \`${formatBytes(numUsage)}\`\n` +
                            `│ 📦 Total    : \`${numLimit > 0 ? formatBytes(numLimit) : 'Tak Terbatas'}\`\n` +
                            `│ 🆓 Tersedia : \`${numLimit > 0 ? formatBytes(numLimit - numUsage) : 'Tak Terbatas'}\`\n` +
                            `╰────────────────────────────\n` +
                            `✨ _Data akurat tersinkronisasi via Google Drive API._`;

                        await sock.sendMessage(remoteJid, { text: quotaMsg }, { quoted: msg });
                    } catch (err) {
                        await sock.sendMessage(remoteJid, {
                            text: `❌ Gagal mengambil info kuota: ${err.message}`
                        }, { quoted: msg });
                    }
                    continue;
                }

                // ==========================================
                // 4. FITUR CARI FILE (SEARCH)
                // ==========================================
                if (lowerText.startsWith('cari ') || lowerText.startsWith('search ')) {
                    const query = textBody.replace(/^(cari|search)\s+/i, '').trim();
                    if (!query) {
                        await sock.sendMessage(remoteJid, {
                            text: '💡 Masukkan kata kunci pencarian. Contoh: *cari konseling* atau *cari laporan*'
                        }, { quoted: msg });
                        continue;
                    }

                    try {
                        let results = [];
                        if (userIsOwner && query.includes('--all')) {
                            // Admin bisa cari global di Google Drive dengan --all
                            const cleanQ = query.replace('--all', '').trim();
                            results = await searchDriveFiles(cleanQ, 5);
                        } else {
                            // Pengguna hanya mencari di antara file miliknya sendiri
                            const myHistory = getHistory(senderClean, 50);
                            results = myHistory.filter(f => f.name.toLowerCase().includes(query.toLowerCase()));
                        }

                        if (results.length === 0) {
                            await sock.sendMessage(remoteJid, {
                                text: `🔍 *Tidak Ditemukan*\nTidak ada file milik Anda dengan kata kunci "${query}".`
                            }, { quoted: msg });
                            continue;
                        }

                        let searchMsg = `╭── 🔍 HASIL PENCARIAN ─────\n│ Kata kunci: _"${query}"_\n├────────────────────────────\n`;
                        results.forEach((file, index) => {
                            searchMsg += `│ *${index + 1}.* 📄 \`${file.name}\` (${file.size || 'N/A'})\n`;
                            if (file.folder) searchMsg += `│    📁 \`${file.folder}\`\n`;
                            searchMsg += `│    🔗 ${file.link || file.webViewLink}\n│\n`;
                        });
                        searchMsg += `╰────────────────────────────\n💡 Ketik *ambil [nama file]* untuk mengunduh ke WA.`;

                        await sock.sendMessage(remoteJid, { text: searchMsg }, { quoted: msg });
                    } catch (err) {
                        await sock.sendMessage(remoteJid, {
                            text: `❌ Gagal mencari file: ${err.message}`
                        }, { quoted: msg });
                    }
                    continue;
                }

                // ==========================================
                // 5. FITUR AMBIL FILE DARI DRIVE KE WA
                // ==========================================
                if (lowerText.startsWith('ambil') || lowerText.startsWith('download') || lowerText.startsWith('get')) {
                    const matchNum = lowerText.match(/^(ambil|download|get)\s+(\d+)$/);
                    let targetFile = null;

                    const userHistory = getHistory(senderClean, 50);

                    if (matchNum) {
                        const index = parseInt(matchNum[2], 10);
                        if (index >= 1 && index <= userHistory.length) {
                            targetFile = userHistory[index - 1];
                        }
                    }

                    if (!targetFile) {
                        const query = textBody.replace(/^(ambil|download|get)\s+/i, '').trim();
                        if (query) {
                            targetFile = userHistory.find(h => h.name.toLowerCase().includes(query.toLowerCase()));
                        }
                    }

                    if (!targetFile) {
                        await sock.sendMessage(remoteJid, {
                            text: `⚠️ File tidak ditemukan dalam riwayat unggahan Anda.\nKetik *cek* untuk melihat nomor file Anda (contoh: *ambil 1*) atau ketik *cari <nama file>*.`
                        }, { quoted: msg });
                        continue;
                    }

                    try {
                        await sock.sendMessage(remoteJid, { react: { text: '⏳', key: msg.key } });

                        const downloadPath = path.join(TEMP_DIR, `get_${Date.now()}_${targetFile.name}`);
                        const fileMeta = await downloadFileFromDrive(targetFile.id, downloadPath);

                        let finalName = fileMeta.name || targetFile.name || 'file';
                        let finalMime = fileMeta.mimeType || targetFile.mimeType;

                        // Pastikan mimetype valid dan bukan generic octet-stream jika nama file memiliki ekstensi
                        if (!finalMime || finalMime === 'application/octet-stream') {
                            finalMime = mime.lookup(finalName) || 'application/octet-stream';
                        }

                        // Pastikan ekstensi nama file terpasang sesuai mimetype
                        const currentExt = path.extname(finalName);
                        if (!currentExt && finalMime && finalMime !== 'application/octet-stream') {
                            const extFromMime = mime.extension(finalMime);
                            if (extFromMime) finalName = `${finalName}.${extFromMime}`;
                        } else if (currentExt) {
                            finalMime = mime.lookup(currentExt) || finalMime;
                        }

                        await sock.sendMessage(remoteJid, {
                            document: fs.readFileSync(downloadPath),
                            fileName: finalName,
                            mimetype: finalMime,
                            caption: `📥 *File dari Google Drive:* ${finalName}`
                        }, { quoted: msg });

                        try { fs.unlinkSync(downloadPath); } catch (e) {}
                        await sock.sendMessage(remoteJid, { react: { text: '✅', key: msg.key } });
                    } catch (err) {
                        await sock.sendMessage(remoteJid, {
                            text: `❌ Gagal mengunduh file dari Google Drive: ${err.message}`
                        }, { quoted: msg });
                    }
                    continue;
                }

                // ==========================================
                // 6. FITUR PERMISSION (PUBLIK / PRIVAT)
                // ==========================================
                if (lowerText.startsWith('publik') || lowerText.startsWith('public') || 
                    lowerText.startsWith('privat') || lowerText.startsWith('private')) {
                    
                    const isPublic = lowerText.startsWith('publik') || lowerText.startsWith('public');
                    const matchNum = lowerText.match(/^(publik|public|privat|private)\s+(\d+)$/);

                    let targetItem = null;
                    const userHistory = getHistory(senderClean, 50);

                    if (matchNum) {
                        const index = parseInt(matchNum[2], 10);
                        if (index >= 1 && index <= userHistory.length) {
                            targetItem = userHistory[index - 1];
                        }
                    }

                    if (!targetItem) {
                        await sock.sendMessage(remoteJid, {
                            text: `💡 Contoh penggunaan: *publik 1* (agar bisa dibuka siapa saja) atau *privat 1* (agar dikunci).\nKetik *cek* untuk melihat daftar file Anda.`
                        }, { quoted: msg });
                        continue;
                    }

                    try {
                        await setFilePermission(targetItem.id, isPublic);
                        const statusDesc = isPublic 
                            ? `🌐 *Akses Diubah Menjadi PUBLIK*\nSiapa saja yang memiliki link sekarang dapat melihat & mendownload file *${targetItem.name}*.`
                            : `🔒 *Akses Diubah Menjadi PRIVAT*\nAkses file *${targetItem.name}* telah dikunci kembali hanya untuk akun Google Anda.`;

                        await sock.sendMessage(remoteJid, { text: statusDesc }, { quoted: msg });
                    } catch (err) {
                        await sock.sendMessage(remoteJid, {
                            text: `❌ Gagal mengubah hak akses file: ${err.message}`
                        }, { quoted: msg });
                    }
                    continue;
                }

                // ==========================================
                // 7. FITUR HAPUS FILE
                // ==========================================
                if (lowerText.startsWith('hapus') || lowerText.startsWith('del') || lowerText === 'batal') {
                    const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
                    const quotedText = (quoted?.conversation || quoted?.extendedTextMessage?.text || '');
                    
                    let targetItem = null;
                    const userHistory = getHistory(senderClean, 50);

                    if (lowerText === 'batal' || lowerText === 'hapus terakhir' || lowerText === 'del last') {
                        const lastList = getHistory(senderClean, 1);
                        targetItem = lastList[0];
                    } else if (lowerText.match(/^(hapus|del)\s+(\d+)$/)) {
                        const match = lowerText.match(/^(hapus|del)\s+(\d+)$/);
                        const index = parseInt(match[2], 10);
                        if (index >= 1 && index <= userHistory.length) {
                            targetItem = userHistory[index - 1];
                        } else {
                            await sock.sendMessage(remoteJid, {
                                text: `⚠️ Nomor urut file tidak ditemukan. Ketik *cek* untuk melihat nomor file Anda (1 - ${userHistory.length}).`
                            }, { quoted: msg });
                            continue;
                        }
                    } else if (quotedText) {
                        targetItem = userHistory.find(h => 
                            quotedText.includes(h.id) || 
                            (h.link && quotedText.includes(h.link)) || 
                            quotedText.includes(h.name)
                        );
                    } else {
                        await sock.sendMessage(remoteJid, {
                            text: `💡 *Panduan Menghapus File:*\n\n` +
                                  `• Ketik *hapus 1* ➔ Hapus file nomor 1 di daftar *cek* Anda\n` +
                                  `• Ketik *hapus terakhir* ➔ Hapus file terakhir yang Anda upload\n` +
                                  `• Atau *Swipe Reply* pesan file bot lalu ketik *hapus*`
                        }, { quoted: msg });
                        continue;
                    }

                    if (!targetItem) {
                        await sock.sendMessage(remoteJid, {
                            text: `⚠️ File tidak ditemukan dalam riwayat Anda. Anda hanya dapat menghapus file yang Anda unggah sendiri.`
                        }, { quoted: msg });
                        continue;
                    }

                    try {
                        await sock.sendMessage(remoteJid, { react: { text: '🗑️', key: msg.key } });
                        await deleteFileFromDrive(targetItem.id);
                        deleteFromHistory(targetItem.id, senderClean);

                        await sock.sendMessage(remoteJid, {
                            text: `🗑️ *File Berhasil Dihapus!*\n\n` +
                                  `📄 *Nama File:* ${targetItem.name}\n` +
                                  `📦 *Ukuran:* ${targetItem.size}\n\n` +
                                  `✨ _File telah dihapus secara permanen dari Google Drive._`
                        }, { quoted: msg });
                    } catch (err) {
                        await sock.sendMessage(remoteJid, {
                            text: `❌ *Gagal Menghapus File:* ${err.message}`
                        }, { quoted: msg });
                    }
                    continue;
                }

                // ==========================================
                // 8. AUTO-RESPONDER (Untuk Chat Teks Biasa / Sapaan)
                // ==========================================
                const mediaInfo = extractMediaContent(msg.message);
                if (!mediaInfo) {
                    if (textBody && !isFromMe) {
                        const greetingMsg = 
                            `🤖 *Halo! Saya adalah Bot WhatsApp Google Drive.* ☁️\n\n` +
                            `Kirim file dokumen, foto, atau video langsung ke chat ini untuk otomatis diunggah ke Google Drive dengan resolusi asli tanpa kompresi.\n\n` +
                            `📌 *Perintah Cepat:*\n` +
                            `• Ketik *menu* ➔ Melihat semua fitur lengkap\n` +
                            `• Ketik *kuota* ➔ Cek kapasitas penyimpanan Drive\n` +
                            `• Ketik *cek* ➔ Melihat riwayat unggahan\n` +
                            `• Ketik *cari <nama>* ➔ Mencari file di Drive\n` +
                            `• Kirim file + caption *#kuliah* ➔ Masuk ke folder Kuliah`;

                        await sock.sendMessage(remoteJid, { text: greetingMsg }, { quoted: msg });
                    }
                    continue;
                }

                let { type: mediaType, payload, fileName, mimetype, fileLength, caption } = mediaInfo;

                // FITUR 1: DETEKSI CUSTOM FOLDER (HASHTAG -> FOLDER SESI -> SMART AUTO-CATEGORY)
                let customFolder = null;
                const folderMatch = caption.match(/#([a-zA-Z0-9_-]+)/);
                if (folderMatch) {
                    customFolder = folderMatch[1];
                } else {
                    const sessionFolder = getUserFolderSession(senderClean);
                    if (sessionFolder) {
                        customFolder = sessionFolder;
                    } else {
                        // Smart Auto-Category otomatis jika user tidak menentukan folder
                        customFolder = getSmartCategory(fileName, mimetype);
                    }
                }

                // FITUR 2: AUTO RENAME FILE DARI CAPTION
                let renameText = caption.replace(/#([a-zA-Z0-9_-]+)/g, '').trim();
                if (renameText && renameText.length > 0) {
                    const ext = path.extname(fileName) || `.${mime.extension(mimetype) || 'bin'}`;
                    if (!renameText.toLowerCase().endsWith(ext.toLowerCase())) {
                        fileName = `${renameText}${ext}`;
                    } else {
                        fileName = renameText;
                    }
                }

                // Cek batas ukuran
                const maxMb = Number(process.env.MAX_FILE_SIZE_MB || 2000);
                const maxBytes = maxMb * 1024 * 1024;
                if (fileLength > maxBytes) {
                    await sock.sendMessage(remoteJid, {
                        text: `⚠️ *File Terlalu Besar*\nFile *${fileName}* (${formatBytes(fileLength)}) melebihi batas konfigurasi ${maxMb} MB.`,
                    }, { quoted: msg });
                    continue;
                }

                console.log(`\n📥 Menerima: "${fileName}" [${formatBytes(fileLength)}] folder: [${customFolder || 'default'}]`);

                // Reaksi ⏳ saat download dimulai
                try {
                    await sock.sendMessage(remoteJid, { react: { text: '⏳', key: msg.key } });
                } catch (e) {}

                const tempFileName = `${Date.now()}_${fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
                const tempFilePath = path.join(TEMP_DIR, tempFileName);

                await downloadMediaToDisk(payload, mediaType, tempFilePath);
                const stats = fs.statSync(tempFilePath);

                // Reaksi ☁️ saat upload ke Drive dimulai
                try {
                    await sock.sendMessage(remoteJid, { react: { text: '☁️', key: msg.key } });
                } catch (e) {}

                // Upload ke Google Drive dengan dukungan folder per user dan subfolder
                const uploadResult = await uploadFileStream({
                    filePath: tempFilePath,
                    fileName: fileName,
                    mimeType: mimetype,
                    customFolder: customFolder,
                    userFolder: userFolderName
                });

                console.log(`✅ Sukses upload ke Google Drive: ${uploadResult.name} (Folder: ${uploadResult.folderName})`);

                try { fs.unlinkSync(tempFilePath); } catch (e) {}

                // Reaksi ✅ saat selesai
                try {
                    await sock.sendMessage(remoteJid, { react: { text: '✅', key: msg.key } });
                } catch (e) {}

                const now = new Date();
                const timeStr = now.toLocaleDateString('id-ID', {
                    day: '2-digit', month: 'short', year: 'numeric',
                    hour: '2-digit', minute: '2-digit'
                });

                const directLink = uploadResult.webViewLink || `https://drive.google.com/open?id=${uploadResult.id}`;
                saveToHistory({
                    id: uploadResult.id,
                    name: uploadResult.name,
                    size: formatBytes(uploadResult.size || stats.size),
                    time: timeStr,
                    link: directLink,
                    folder: uploadResult.folderName,
                    mimeType: mimetype || mime.lookup(uploadResult.name) || 'application/octet-stream',
                    uploader: senderClean,
                    uploaderName: senderDisplayName
                });

                // Kirim notifikasi via Smart Batch Digest (Anti-Spam & Rapi)
                scheduleBatchDigest(sock, remoteJid, {
                    id: uploadResult.id,
                    name: uploadResult.name,
                    size: formatBytes(uploadResult.size || stats.size),
                    bytes: uploadResult.size || stats.size,
                    time: timeStr,
                    link: directLink,
                    folder: uploadResult.folderName,
                    folderLink: uploadResult.folderLink,
                    uploader: senderClean
                });

            } catch (err) {
                console.error('❌ Terjadi kesalahan saat memproses file:', err);
                try {
                    await sock.sendMessage(msg.key.remoteJid, { react: { text: '❌', key: msg.key } });
                    await sock.sendMessage(msg.key.remoteJid, {
                        text: `❌ *Gagal Mengunggah ke Google Drive:*\n\n${err.message}`
                    }, { quoted: msg });
                } catch (e) {}
            }
        }
    });
}

// Jalankan bot
startBot().catch(err => {
    console.error('❌ Gagal menjalankan bot:', err);
});
