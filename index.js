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
    return '[' + '■'.repeat(filled) + '□'.repeat(empty) + ']';
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
                // Tampilan 1 File (Minimalis & Elegan)
                const file = items[0];
                let msg = 
                    `*File Berhasil Diunggah*\n\n` +
                    `• Nama: \`${file.name}\`\n` +
                    `• Ukuran: ${file.size}\n` +
                    `• Folder: \`${folder}\`\n\n` +
                    `Link File:\n${file.link}`;
                if (folderLink) {
                    msg += `\n\nLink Folder:\n${folderLink}`;
                }

                await sock.sendMessage(remoteJid, { text: msg.trim() });
            } else {
                // Tampilan Banyak File / Forward Massal (Minimalis & Rapi)
                const totalBytes = items.reduce((acc, it) => acc + (it.bytes || 0), 0);
                const totalFormatted = totalBytes > 0 ? formatBytes(totalBytes) : `${items.length} Berkas`;

                let msg = 
                    `*Upload Selesai (${items.length} File)*\n` +
                    `Folder: \`${folder}\` • Total: ${totalFormatted}\n\n`;

                items.slice(0, 15).forEach((item, idx) => {
                    msg += `${idx + 1}. \`${item.name}\` (${item.size})\n`;
                });

                if (items.length > 15) {
                    msg += `_... dan ${items.length - 15} file lainnya_\n`;
                }

                if (folderLink) {
                    msg += `\nLink Folder:\n${folderLink}`;
                }

                await sock.sendMessage(remoteJid, { text: msg.trim() });
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

                // Abaikan pesan keluar (ketika nomor bot dipakai chat/kirim file ke orang atau nomor lain)
                // Bot hanya merespons pesan MASUK dari nomor lain, bukan pesan KELUAR dari nomor bot
                const myBotNumber = sock.user?.id ? sock.user.id.split(':')[0].split('@')[0].replace(/[^0-9]/g, '') : '';
                const targetNumber = remoteJid ? remoteJid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '') : '';

                if (isFromMe && (!myBotNumber || targetNumber !== myBotNumber)) {
                    continue;
                }

                const senderJid = msg.key.participant || remoteJid;

                const senderClean = normalizePhone(resolveLidToPhone(senderJid) || senderJid);
                const cleanPushName = (msg.pushName || '').trim();
                const shortName = cleanPushName ? cleanPushName.split(/\s+/)[0].replace(/[^a-zA-Z0-9]/g, '') : '';
                const last4Phone = senderClean.slice(-4) || '0000';
                const userFolderName = shortName ? `${shortName}_${last4Phone}` : `User_${last4Phone}`;
                const senderDisplayName = shortName || `User_${last4Phone}`;
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
                        `*Google Drive Bot*\n` +
                        `Upload file otomatis dengan resolusi asli.\n\n` +
                        `*Upload & Folder*\n` +
                        `• Kirim file langsung ➔ simpan otomatis per kategori\n` +
                        `• Caption \`#nama\` ➔ simpan ke folder spesifik\n` +
                        `• \`folder <nama>\` ➔ set folder sebelum forward massal\n` +
                        `• \`folder reset\` ➔ kembali ke mode otomatis\n\n` +
                        `*Perintah Pengguna*\n` +
                        `• \`cek\` ➔ riwayat file Anda\n` +
                        `• \`status\` ➔ profil & kuota penyimpanan\n` +
                        `• \`cari <kata>\` ➔ cari file di riwayat Anda\n` +
                        `• \`ambil <no>\` ➔ unduh file ke WhatsApp\n` +
                        `• \`hapus <no>\` ➔ hapus file dari Drive\n` +
                        `• \`publik <no>\` / \`privat <no>\` ➔ atur akses link\n\n` +
                        `*Admin Whitelist*\n` +
                        `• \`+user <no>\` ➔ tambah izin nomor\n` +
                        `• \`-user <no>\` ➔ hapus izin nomor\n` +
                        `• \`listuser\` ➔ daftar nomor terdaftar`;

                    await sock.sendMessage(remoteJid, { text: menuText }, { quoted: msg });
                    continue;
                }

                // ==========================================
                // 1A. FITUR PROFIL & STATUS
                // ==========================================
                if (lowerText === '.me' || lowerText === 'me' || lowerText === 'status' || lowerText === 'profil' || lowerText === 'profile') {
                    const myHistory = getHistory(senderClean, 50);
                    const totalFiles = myHistory.length;
                    const sessionFolder = getUserFolderSession(senderClean) || 'Otomatis (Kategori)';

                    let progressBar = '[■□□□□□□□□□]';
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
                        `*Profil Pengguna*\n\n` +
                        `• Nomor: \`${senderClean}\`\n` +
                        `• Akses: ${userIsOwner ? 'Owner / Admin' : 'Terdaftar'}\n` +
                        `• Folder Sesi: \`${sessionFolder}\`\n` +
                        `• File Terunggah: ${totalFiles} file\n\n` +
                        `*Kapasitas Google Drive*\n` +
                        `• Terpakai: ${formatBytes(numUsage)} dari ${numLimit > 0 ? formatBytes(numLimit) : 'Tak Terbatas'} (${percent}%)\n` +
                        `• Status: ${progressBar}\n\n` +
                        `_Ketik \`menu\` untuk opsi lain atau \`cek\` untuk daftar file._`;

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
                                text: `*Folder Sesi Aktif: \`${current}\`*\n\n` +
                                      `Semua file yang Anda kirim atau teruskan akan otomatis masuk ke folder ini.\n\n` +
                                      `• \`folder reset\` ➔ kembali ke otomatis\n` +
                                      `• \`folder <nama>\` ➔ ganti nama folder`
                            }, { quoted: msg });
                        } else {
                            await sock.sendMessage(remoteJid, {
                                text: `*Folder Sesi: Nonaktif (Otomatis)*\n\n` +
                                      `File akan otomatis dipisahkan berdasarkan kategori.\n\n` +
                                      `_Untuk forward banyak file ke satu folder, ketik:_\n` +
                                      `\`folder NamaFolder\` (contoh: \`folder Kuliah\`)`
                            }, { quoted: msg });
                        }
                        continue;
                    }

                    if (lowerArg === 'reset' || lowerArg === 'off' || lowerArg === 'hapus' || lowerArg === 'normal' || lowerArg === 'batal') {
                        const prev = clearUserFolderSession(senderClean);
                        await sock.sendMessage(remoteJid, {
                            text: `*Folder Sesi Dinonaktifkan*\n` +
                                  (prev ? `Folder sebelumnya: \`${prev}\`\n` : '') +
                                  `Penyimpanan file kembali ke mode otomatis.`
                        }, { quoted: msg });
                        continue;
                    }

                    const cleanFolderName = arg.replace(/[^a-zA-Z0-9_\-\s]/g, '').trim().replace(/\s+/g, '_');
                    if (!cleanFolderName) {
                        await sock.sendMessage(remoteJid, {
                            text: `Nama folder tidak valid. Contoh: \`folder Berkas_Penting\``
                        }, { quoted: msg });
                        continue;
                    }

                    setUserFolderSession(senderClean, cleanFolderName);
                    await sock.sendMessage(remoteJid, {
                        text: `*Folder Sesi Diatur: \`${cleanFolderName}\`*\n\n` +
                              `Silakan kirim atau teruskan (forward) file sekarang. Semua file akan masuk ke folder ini.\n\n` +
                              `_Ketik \`folder reset\` bila sudah selesai._`
                    }, { quoted: msg });
                    continue;
                }

                // ==========================================
                // 1C. FITUR MANAJEMEN WHITELIST (+user / -user / listuser)
                // ==========================================
                if (lowerText.startsWith('+user') || lowerText.startsWith('tambah user')) {
                    if (!isOwner(remoteJid, isFromMe, msg.key.participant)) {
                        await sock.sendMessage(remoteJid, {
                            text: 'Akses Ditolak: Hanya Owner / Admin yang dapat menambah user ke whitelist.'
                        }, { quoted: msg });
                        continue;
                    }

                    const numTarget = textBody.replace(/^(\+user|tambah user)\s*/i, '').trim();
                    const added = addWhitelistUser(numTarget);

                    if (!added) {
                        await sock.sendMessage(remoteJid, {
                            text: 'Format nomor tidak valid. Contoh: `+user 081234567890`'
                        }, { quoted: msg });
                    } else {
                        await sock.sendMessage(remoteJid, {
                            text: `*User Berhasil Ditambahkan*\nNomor \`${added}\` sekarang diizinkan menggunakan bot.`
                        }, { quoted: msg });
                    }
                    continue;
                }

                if (lowerText.startsWith('-user') || lowerText.startsWith('hapus user')) {
                    if (!isOwner(remoteJid, isFromMe, msg.key.participant)) {
                        await sock.sendMessage(remoteJid, {
                            text: 'Akses Ditolak: Hanya Owner / Admin yang dapat menghapus user dari whitelist.'
                        }, { quoted: msg });
                        continue;
                    }

                    const numTarget = textBody.replace(/^(\-user|hapus user)\s*/i, '').trim();
                    const removed = removeWhitelistUser(numTarget);

                    if (!removed) {
                        await sock.sendMessage(remoteJid, {
                            text: 'Nomor tidak ditemukan dalam daftar whitelist.'
                        }, { quoted: msg });
                    } else {
                        await sock.sendMessage(remoteJid, {
                            text: `*User Berhasil Dihapus*\nAkses nomor \`${removed}\` telah dinonaktifkan.`
                        }, { quoted: msg });
                    }
                    continue;
                }

                if (lowerText === 'listuser' || lowerText === 'list user' || lowerText === 'users' || lowerText === 'daftar user') {
                    if (!isOwner(remoteJid, isFromMe, msg.key.participant)) {
                        await sock.sendMessage(remoteJid, {
                            text: 'Akses Ditolak: Hanya Owner / Admin yang dapat melihat daftar user.'
                        }, { quoted: msg });
                        continue;
                    }

                    const users = getWhitelist();
                    let uMsg = `*Daftar User Whitelist (${users.length})*\n\n`;
                    users.forEach((u, i) => {
                        uMsg += `${i + 1}. \`${u}\`\n`;
                    });
                    uMsg += `\n_Kelola: \`+user <no>\` atau \`-user <no>\`_`;

                    await sock.sendMessage(remoteJid, { text: uMsg }, { quoted: msg });
                    continue;
                }

                // ==========================================
                // 2. FITUR CEK RIWAYAT
                // ==========================================
                if (lowerText === 'cek' || lowerText === 'daftar' || lowerText === 'list' || lowerText === 'riwayat' || (userIsOwner && (lowerText === 'cek all' || lowerText === 'list all'))) {
                    const isCheckAll = userIsOwner && (lowerText === 'cek all' || lowerText === 'list all');
                    const targetUploader = isCheckAll ? 'ALL' : senderClean;
                    const history = getHistory(targetUploader, 10);
                    if (history.length === 0) {
                        await sock.sendMessage(remoteJid, {
                            text: isCheckAll 
                                ? 'Belum ada riwayat unggahan di bot ini.'
                                : 'Belum ada riwayat unggahan Anda.'
                        }, { quoted: msg });
                        continue;
                    }

                    let listText = isCheckAll 
                        ? `*Semua Unggahan Bot (Admin)* (${history.length} file)\n\n`
                        : `*Riwayat Unggahan Anda* (${history.length} file)\n\n`;

                    history.forEach((item, index) => {
                        let displayFolder = item.folder || '';
                        if (displayFolder.includes('/')) {
                            displayFolder = displayFolder.split('/').slice(1).join('/');
                        }
                        const previewLink = item.id 
                            ? `https://drive.google.com/open?id=${item.id}` 
                            : (item.link || '');

                        listText += `${index + 1}. *${item.name}* (${item.size})\n`;

                        const meta = [];
                        if (isCheckAll && (item.uploaderName || item.uploader)) {
                            meta.push(`👤 ${item.uploaderName || item.uploader}`);
                        }
                        if (displayFolder) {
                            meta.push(`📁 ${displayFolder}`);
                        }
                        if (item.time) {
                            meta.push(`${item.time}`);
                        }
                        if (meta.length > 0) {
                            listText += `   ${meta.join(' • ')}\n`;
                        }
                        if (previewLink) {
                            listText += `   🔗 ${previewLink}\n`;
                        }
                        listText += `\n`;
                    });

                    listText += `_Aksi: \`ambil <no>\` untuk unduh, \`hapus <no>\` atau \`hapus 1-3\` untuk delete._`;

                    await sock.sendMessage(remoteJid, { text: listText.trim() }, { quoted: msg });
                    continue;
                }

                // ==========================================
                // 3. FITUR CEK KUOTA
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
                            `*Kapasitas Google Drive*\n\n` +
                            `• Terpakai: ${formatBytes(numUsage)} dari ${numLimit > 0 ? formatBytes(numLimit) : 'Tak Terbatas'} (${percent}%)\n` +
                            `• Tersedia: ${numLimit > 0 ? formatBytes(numLimit - numUsage) : 'Tak Terbatas'}\n` +
                            `• Status: ${progressBar}`;

                        await sock.sendMessage(remoteJid, { text: quotaMsg }, { quoted: msg });
                    } catch (err) {
                        await sock.sendMessage(remoteJid, {
                            text: `Gagal mengambil info kuota: ${err.message}`
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
                            text: 'Masukkan kata kunci pencarian. Contoh: `cari laporan`'
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
                                text: `Tidak ada file yang cocok dengan kata kunci: "${query}"`
                            }, { quoted: msg });
                            continue;
                        }

                        let searchMsg = `*Hasil Pencarian: "${query}"*\n\n`;
                        results.forEach((file, index) => {
                            const pLink = file.id ? `https://drive.google.com/open?id=${file.id}` : (file.link || file.webViewLink || '');
                            let fName = file.folder || '';
                            if (fName.includes('/')) fName = fName.split('/').slice(1).join('/');

                            searchMsg += `${index + 1}. *${file.name}* (${file.size || 'N/A'})\n`;
                            if (fName) searchMsg += `   📁 ${fName}\n`;
                            if (pLink) searchMsg += `   🔗 ${pLink}\n`;
                            searchMsg += `\n`;
                        });
                        searchMsg += `_Ketik \`ambil [nama file]\` untuk mengunduh ke WA._`;

                        await sock.sendMessage(remoteJid, { text: searchMsg.trim() }, { quoted: msg });
                    } catch (err) {
                        await sock.sendMessage(remoteJid, {
                            text: `Gagal mencari file: ${err.message}`
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
                // 6B. FITUR AMBIL LINK FILE
                // ==========================================
                if (lowerText.match(/^(link|url)\s+(\d+)$/)) {
                    const match = lowerText.match(/^(link|url)\s+(\d+)$/);
                    const idx = parseInt(match[2], 10);
                    const userHistory = getHistory(senderClean, 50);
                    if (idx >= 1 && idx <= userHistory.length) {
                        const target = userHistory[idx - 1];
                        await sock.sendMessage(remoteJid, {
                            text: `*Link File: \`${target.name}\`*\n\n${target.link}`
                        }, { quoted: msg });
                    } else {
                        await sock.sendMessage(remoteJid, {
                            text: `Nomor urut tidak valid. Ketik \`cek\` untuk melihat nomor file (1 - ${userHistory.length}).`
                        }, { quoted: msg });
                    }
                    continue;
                }

                // ==========================================
                // 7. FITUR HAPUS FILE (MENDUKUNG HAPUS BANYAK FILE SEKALIGUS)
                // ==========================================
                if (lowerText.startsWith('hapus') || lowerText.startsWith('del') || lowerText === 'batal') {
                    const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
                    const quotedText = (quoted?.conversation || quoted?.extendedTextMessage?.text || '');
                    
                    let targetItems = [];
                    const userHistory = getHistory(senderClean, 50);

                    if (lowerText === 'batal' || lowerText === 'hapus terakhir' || lowerText === 'del last') {
                        const lastList = getHistory(senderClean, 1);
                        if (lastList[0]) targetItems.push(lastList[0]);
                    } else if (lowerText === 'hapus semua' || lowerText === 'hapus all' || lowerText === 'del all') {
                        targetItems = [...userHistory];
                    } else if (lowerText.match(/^(hapus|del)\s+(\d+)\s*-\s*(\d+)$/)) {
                        // Rentang nomor: contoh hapus 1-5
                        const match = lowerText.match(/^(hapus|del)\s+(\d+)\s*-\s*(\d+)$/);
                        const start = parseInt(match[2], 10);
                        const end = parseInt(match[3], 10);
                        const min = Math.min(start, end);
                        const max = Math.max(start, end);
                        for (let i = min; i <= max; i++) {
                            if (i >= 1 && i <= userHistory.length) {
                                targetItems.push(userHistory[i - 1]);
                            }
                        }
                    } else if (lowerText.match(/^(hapus|del)\s+([\d\s,]+)$/)) {
                        // Beberapa nomor: contoh hapus 1, 2, 3 atau hapus 1 2 3
                        const match = lowerText.match(/^(hapus|del)\s+([\d\s,]+)$/);
                        const rawNums = match[2].split(/[,\s]+/).filter(Boolean);
                        const indices = [...new Set(rawNums.map(n => parseInt(n, 10)).filter(n => !isNaN(n)))];
                        indices.forEach(idx => {
                            if (idx >= 1 && idx <= userHistory.length) {
                                targetItems.push(userHistory[idx - 1]);
                            }
                        });
                    } else if (quotedText) {
                        const found = userHistory.find(h => 
                            quotedText.includes(h.id) || 
                            (h.link && quotedText.includes(h.link)) || 
                            quotedText.includes(h.name)
                        );
                        if (found) targetItems.push(found);
                    }

                    if (targetItems.length === 0) {
                        await sock.sendMessage(remoteJid, {
                            text: `*Panduan Menghapus File*\n\n` +
                                  `• \`hapus 1\` ➔ hapus file no 1 di daftar \`cek\`\n` +
                                  `• \`hapus 1, 2, 3\` ➔ hapus beberapa file sekaligus\n` +
                                  `• \`hapus 1-5\` ➔ hapus rentang file 1 sampai 5\n` +
                                  `• \`hapus terakhir\` ➔ hapus file paling baru\n` +
                                  `• \`hapus semua\` ➔ hapus seluruh riwayat Anda`
                        }, { quoted: msg });
                        continue;
                    }

                    try {
                        await sock.sendMessage(remoteJid, { react: { text: '🗑️', key: msg.key } });

                        let deletedNames = [];
                        for (const item of targetItems) {
                            try {
                                await deleteFileFromDrive(item.id);
                                deleteFromHistory(item.id, senderClean);
                                deletedNames.push(item.name);
                            } catch (e) {
                                console.error(`Gagal menghapus file ${item.name}:`, e.message);
                            }
                        }

                        if (deletedNames.length === 1) {
                            await sock.sendMessage(remoteJid, {
                                text: `*File Berhasil Dihapus*\n\n` +
                                      `• Nama: \`${deletedNames[0]}\`\n` +
                                      `• Status: Dihapus permanen dari Google Drive`
                            }, { quoted: msg });
                        } else {
                            let resMsg = `*${deletedNames.length} File Berhasil Dihapus*\n\n`;
                            deletedNames.forEach((n, i) => {
                                resMsg += `${i + 1}. \`${n}\`\n`;
                            });
                            resMsg += `\n_Semua file di atas telah dihapus dari Google Drive._`;
                            await sock.sendMessage(remoteJid, { text: resMsg.trim() }, { quoted: msg });
                        }
                    } catch (err) {
                        await sock.sendMessage(remoteJid, {
                            text: `Gagal menghapus file: ${err.message}`
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
                            `*Google Drive Bot*\n\n` +
                            `Kirim file apa pun (dokumen, foto, video) untuk diunggah otomatis dalam resolusi asli tanpa kompresi.\n\n` +
                            `• Ketik \`menu\` untuk panduan fitur\n` +
                            `• Ketik \`status\` untuk info kuota & profil\n` +
                            `• Ketik \`cek\` untuk riwayat file`;

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
