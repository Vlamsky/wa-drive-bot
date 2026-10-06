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

if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
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
 * Menghapus file tertentu dari riwayat lokal
 */
function deleteFromHistory(fileId) {
    try {
        if (fs.existsSync(HISTORY_FILE)) {
            let history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
            const item = history.find(h => h.id === fileId);
            history = history.filter(h => h.id !== fileId);
            fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
            return item;
        }
    } catch (e) {}
    return null;
}

/**
 * Mengambil riwayat unggahan
 */
function getHistory(limit = 10) {
    try {
        if (fs.existsSync(HISTORY_FILE)) {
            const list = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
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
 * Cek apakah pengirim diizinkan (Whitelist)
 */
function isSenderAllowed(jid, fromMe, participant) {
    const allowed = process.env.ALLOWED_NUMBERS?.trim();
    if (!allowed || allowed === '*') return true;
    if (fromMe) return true;

    const allowedList = allowed.split(',').map(n => normalizePhone(n)).filter(Boolean);

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
            console.log('💡 Semua 6 fitur premium siap digunakan.');
            console.log('--------------------------------------------------\n');
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

                if (!isSenderAllowed(remoteJid, isFromMe, msg.key.participant)) continue;

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
                        `✨ *MENU ASISTEN GOOGLE DRIVE* ✨\n\n` +
                        `📁 *1. Upload File Otomatis:*\n` +
                        `• Kirim file dokumen/foto/video langsung ke chat ini.\n` +
                        `• Tag folder: tambahkan *#kuliah*, *#kerjaan*, dll pada caption.\n` +
                        `• Rename file: tulis nama baru di caption saat kirim file.\n\n` +
                        `📋 *2. Perintah Tersedia:*\n` +
                        `• *cek* ➔ Melihat 10 riwayat unggahan terbaru\n` +
                        `• *cari <kata kunci>* ➔ Mencari file di Google Drive\n` +
                        `• *kuota* ➔ Cek kapasitas Google Drive Anda\n` +
                        `• *ambil <nomor>* ➔ Kirim file Drive ke WhatsApp\n` +
                        `• *hapus <nomor>* ➔ Hapus file dari Google Drive\n` +
                        `• *hapus terakhir* ➔ Batalkan upload file terakhir\n` +
                        `• *publik <nomor>* ➔ Buka akses file (Anyone with link)\n` +
                        `• *privat <nomor>* ➔ Kunci akses file kembali privat`;

                    await sock.sendMessage(remoteJid, { text: menuText }, { quoted: msg });
                    continue;
                }

                // ==========================================
                // 2. FITUR CEK RIWAYAT
                // ==========================================
                if (lowerText === 'cek' || lowerText === 'daftar' || lowerText === 'list' || lowerText === 'riwayat') {
                    const history = getHistory(10);
                    if (history.length === 0) {
                        await sock.sendMessage(remoteJid, {
                            text: '📭 *Belum Ada Riwayat Unggahan*\nAnda belum mengunggah file apa pun ke Google Drive via bot ini.'
                        }, { quoted: msg });
                        continue;
                    }

                    let listText = `📋 *DAFTAR UNGGAHAN TERBARU (${history.length}):*\n\n`;
                    history.forEach((item, index) => {
                        listText += `*${index + 1}.* 📄 *${item.name}* (${item.size})\n`;
                        if (item.folder) listText += `   📁 Folder: *${item.folder}*\n`;
                        listText += `   🕒 ${item.time}\n`;
                        listText += `   🔗 ${item.link}\n\n`;
                    });
                    listText += `💡 *Aksi Cepat:*\n`;
                    listText += `• Ketik *ambil 1* untuk download ke WA\n`;
                    listText += `• Ketik *hapus 1* untuk menghapus file\n`;
                    listText += `• Ketik *publik 1* / *privat 1* untuk ubah akses`;

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
                        const user = quotaData.user;

                        const numLimit = Number(limit || 0);
                        const numUsage = Number(usage || 0);
                        const percent = numLimit > 0 ? Math.round((numUsage / numLimit) * 100) : 0;
                        const progressBar = makeProgressBar(percent);

                        const quotaMsg = 
                            `📊 *STATUS KAPASITAS GOOGLE DRIVE*\n\n` +
                            `Status: ${progressBar} *${percent}%*\n` +
                            `💾 *Terpakai:* ${formatBytes(numUsage)}\n` +
                            `📦 *Total Kuota:* ${numLimit > 0 ? formatBytes(numLimit) : 'Tak Terbatas'}\n` +
                            `🆓 *Sisa Tersedia:* ${numLimit > 0 ? formatBytes(numLimit - numUsage) : 'Tak Terbatas'}\n\n` +
                            `✨ _Data akurat langsung dari Google Drive API._`;

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
                        const results = await searchDriveFiles(query, 5);
                        if (results.length === 0) {
                            await sock.sendMessage(remoteJid, {
                                text: `🔍 *Tidak Ditemukan*\nTidak ada file di Google Drive dengan kata kunci "${query}".`
                            }, { quoted: msg });
                            continue;
                        }

                        let searchMsg = `🔍 *HASIL PENCARIAN GOOGLE DRIVE*\nKata kunci: _"${query}"_\n\n`;
                        results.forEach((file, index) => {
                            searchMsg += `*${index + 1}.* 📄 *${file.name}* (${formatBytes(file.size || 0)})\n`;
                            searchMsg += `   🔗 ${file.webViewLink}\n\n`;
                        });
                        searchMsg += `💡 Ketik *ambil [nama/link]* untuk meminta bot mengirim file ke WA.`;

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

                    if (matchNum) {
                        const index = parseInt(matchNum[2], 10);
                        const history = getHistory(50);
                        if (index >= 1 && index <= history.length) {
                            targetFile = history[index - 1];
                        }
                    }

                    if (!targetFile) {
                        const query = textBody.replace(/^(ambil|download|get)\s+/i, '').trim();
                        if (query) {
                            const searchRes = await searchDriveFiles(query, 1);
                            if (searchRes.length > 0) {
                                targetFile = searchRes[0];
                            }
                        }
                    }

                    if (!targetFile) {
                        await sock.sendMessage(remoteJid, {
                            text: `⚠️ File tidak ditemukan. Ketik *cek* untuk melihat nomor urut (contoh: *ambil 1*) atau ketik *cari <nama file>*.`
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
                    if (matchNum) {
                        const index = parseInt(matchNum[2], 10);
                        const history = getHistory(50);
                        if (index >= 1 && index <= history.length) {
                            targetItem = history[index - 1];
                        }
                    }

                    if (!targetItem) {
                        await sock.sendMessage(remoteJid, {
                            text: `💡 Contoh penggunaan: *publik 1* (agar bisa dibuka siapa saja) atau *privat 1* (agar dikunci).`
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

                    if (lowerText === 'batal' || lowerText === 'hapus terakhir' || lowerText === 'del last') {
                        const history = getHistory(1);
                        targetItem = history[0];
                    } else if (lowerText.match(/^(hapus|del)\s+(\d+)$/)) {
                        const match = lowerText.match(/^(hapus|del)\s+(\d+)$/);
                        const index = parseInt(match[2], 10);
                        const history = getHistory(50);
                        if (index >= 1 && index <= history.length) {
                            targetItem = history[index - 1];
                        } else {
                            await sock.sendMessage(remoteJid, {
                                text: `⚠️ Nomor urut file tidak ditemukan. Ketik *cek* untuk melihat nomor file (1 - ${history.length}).`
                            }, { quoted: msg });
                            continue;
                        }
                    } else if (quotedText) {
                        const history = getHistory(50);
                        targetItem = history.find(h => 
                            quotedText.includes(h.id) || 
                            (h.link && quotedText.includes(h.link)) || 
                            quotedText.includes(h.name)
                        );
                    } else {
                        await sock.sendMessage(remoteJid, {
                            text: `💡 *Panduan Menghapus File:*\n\n` +
                                  `• Ketik *hapus 1* ➔ Hapus file urutan no 1 di daftar *cek*\n` +
                                  `• Ketik *hapus terakhir* ➔ Hapus file paling baru\n` +
                                  `• Atau *Swipe Reply* pesan bot lalu ketik *hapus*`
                        }, { quoted: msg });
                        continue;
                    }

                    if (!targetItem) {
                        await sock.sendMessage(remoteJid, {
                            text: `⚠️ File tidak ditemukan dalam riwayat bot. Ketik *cek* untuk melihat daftar file aktif.`
                        }, { quoted: msg });
                        continue;
                    }

                    try {
                        await sock.sendMessage(remoteJid, { react: { text: '🗑️', key: msg.key } });
                        await deleteFileFromDrive(targetItem.id);
                        deleteFromHistory(targetItem.id);

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
                // 8. PROSES UNGGAH FILE MEDIA (DOKUMEN / FOTO / VIDEO)
                // ==========================================
                const mediaInfo = extractMediaContent(msg.message);
                if (!mediaInfo) continue;

                let { type: mediaType, payload, fileName, mimetype, fileLength, caption } = mediaInfo;

                // FITUR 1: DETEKSI CUSTOM FOLDER DARI TAG CAPTION (misal #kuliah, #kerjaan)
                let customFolder = null;
                const folderMatch = caption.match(/#([a-zA-Z0-9_-]+)/);
                if (folderMatch) {
                    customFolder = folderMatch[1];
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

                // Upload ke Google Drive dengan dukungan custom folder
                const uploadResult = await uploadFileStream({
                    filePath: tempFilePath,
                    fileName: fileName,
                    mimeType: mimetype,
                    customFolder: customFolder
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
                    mimeType: mimetype || mime.lookup(uploadResult.name) || 'application/octet-stream'
                });

                // Kirim notifikasi hasil yang sangat rapi
                const successMessage = 
                    `✅ *Berhasil Diunggah ke Google Drive!*\n\n` +
                    `📄 *Nama File:* ${uploadResult.name}\n` +
                    `📁 *Folder:* ${uploadResult.folderName}\n` +
                    `📦 *Ukuran:* ${formatBytes(uploadResult.size || stats.size)}\n` +
                    `🔗 *Link Google Drive:*\n${directLink}\n\n` +
                    `✨ _File tersimpan dalam resolusi asli tanpa kompresi._\n` +
                    `💡 _Ketik *menu* untuk melihat fitur lainnya._`;

                await sock.sendMessage(remoteJid, { text: successMessage }, { quoted: msg });

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
