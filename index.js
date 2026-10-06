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

const { uploadFileStream, deleteFileFromDrive } = require('./googleDrive');

// Direktori penyimpanan session WhatsApp, folder sementara, dan riwayat
const AUTH_DIR = path.join(__dirname, 'session_auth');
const TEMP_DIR = path.join(__dirname, 'temp_downloads');
const HISTORY_FILE = path.join(__dirname, 'upload_history.json');

if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}

/**
 * Format bytes menjadi ukuran yang mudah dibaca (KB, MB, GB)
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
    history.unshift(entry); // Masukkan paling depan (terbaru)
    if (history.length > 50) history = history.slice(0, 50); // Simpan 50 terakhir
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
 * Menghapus pesan dengan aman
 */
async function deleteMessage(sock, remoteJid, messageKey) {
    if (!messageKey) return;
    try {
        await sock.sendMessage(remoteJid, { delete: messageKey });
    } catch (e) {
        // Abaikan jika pesan sudah terhapus
    }
}

/**
 * Menjadwalkan penghapusan pesan otomatis setelah N menit
 */
function scheduleAutoDelete(sock, remoteJid, messageKey, minutes) {
    const min = Number(minutes || 0);
    if (min <= 0 || !messageKey) return;

    setTimeout(async () => {
        await deleteMessage(sock, remoteJid, messageKey);
    }, min * 60 * 1000);
}

/**
 * Mengubah WhatsApp LID (Privacy ID) menjadi nomor telepon asli berdasarkan sesi Baileys
 */
function resolveLidToPhone(rawJid) {
    if (!rawJid) return null;
    const clean = rawJid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');

    // Cek file mapping di folder session_auth
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
 * Normalisasi format nomor telepon (menghilangkan prefix 0, tanda +, @s.whatsapp.net, :device)
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
    if (fromMe) return true; // Pesan dari bot sendiri selalu diizinkan

    const allowedList = allowed.split(',').map(n => normalizePhone(n)).filter(Boolean);

    // Ambil JID bersih
    const jidClean = normalizePhone(jid);
    const partClean = normalizePhone(participant);

    // Otomatis terjemahkan jika pengirim menggunakan WhatsApp Privacy LID (@lid)
    const resolvedPhoneJid = normalizePhone(resolveLidToPhone(jid) || '');
    const resolvedPhonePart = normalizePhone(resolveLidToPhone(participant) || '');

    const candidates = [jidClean, partClean, resolvedPhoneJid, resolvedPhonePart].filter(Boolean);

    const isMatch = allowedList.some(num => 
        candidates.some(cand => cand === num || cand.endsWith(num) || num.endsWith(cand))
    );

    if (!isMatch) {
        console.log(`⛔ Pesan/File dari [${jidClean || jid}] diabaikan karena tidak cocok dengan ALLOWED_NUMBERS: [${allowedList.join(', ')}]`);
    } else if (resolvedPhoneJid) {
        console.log(`🔓 Mengenali pengirim via WhatsApp LID [${jidClean}] -> Nomor Asli: [${resolvedPhoneJid}]`);
    }

    return isMatch;
}

/**
 * Mengekstrak payload media dari berbagai jenis pesan
 */
function extractMediaContent(message) {
    if (!message) return null;

    const unwrapMsg = message.viewOnceMessage?.message || 
                     message.viewOnceMessageV2?.message || 
                     message.documentWithCaptionMessage?.message || 
                     message;

    if (unwrapMsg.documentMessage) {
        return {
            type: 'document',
            payload: unwrapMsg.documentMessage,
            fileName: unwrapMsg.documentMessage.fileName || `doc_${Date.now()}`,
            mimetype: unwrapMsg.documentMessage.mimetype || 'application/octet-stream',
            fileLength: Number(unwrapMsg.documentMessage.fileLength || 0)
        };
    }

    if (unwrapMsg.imageMessage) {
        const ext = mime.extension(unwrapMsg.imageMessage.mimetype) || 'jpg';
        return {
            type: 'image',
            payload: unwrapMsg.imageMessage,
            fileName: `IMG_${Date.now()}.${ext}`,
            mimetype: unwrapMsg.imageMessage.mimetype || 'image/jpeg',
            fileLength: Number(unwrapMsg.imageMessage.fileLength || 0)
        };
    }

    if (unwrapMsg.videoMessage) {
        const ext = mime.extension(unwrapMsg.videoMessage.mimetype) || 'mp4';
        return {
            type: 'video',
            payload: unwrapMsg.videoMessage,
            fileName: `VID_${Date.now()}.${ext}`,
            mimetype: unwrapMsg.videoMessage.mimetype || 'video/mp4',
            fileLength: Number(unwrapMsg.videoMessage.fileLength || 0)
        };
    }

    if (unwrapMsg.audioMessage) {
        const ext = mime.extension(unwrapMsg.audioMessage.mimetype) || 'mp3';
        return {
            type: 'audio',
            payload: unwrapMsg.audioMessage,
            fileName: `AUD_${Date.now()}.${ext}`,
            mimetype: unwrapMsg.audioMessage.mimetype || 'audio/mpeg',
            fileLength: Number(unwrapMsg.audioMessage.fileLength || 0)
        };
    }

    return null;
}

/**
 * Mengunduh media secara streaming ke file lokal (Hemat RAM)
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
            console.log('✅ BOT WHATSAPP BERHASIL AKTIF & SIAP DIGUNAKAN!');
            console.log('==================================================');
            console.log('💡 Perintah teks tersedia: ketik "cek" untuk riwayat unggahan.');
            console.log('💡 Pesan status proses akan otomatis dibersihkan.');
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

                // 1. CEK PERINTAH TEKS ("cek", "daftar", "list", "riwayat", "help")
                const textBody = (
                    msg.message.conversation || 
                    msg.message.extendedTextMessage?.text || 
                    ''
                ).trim().toLowerCase();

                if (textBody === 'cek' || textBody === 'daftar' || textBody === 'list' || textBody === 'riwayat') {
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
                        listText += `   🕒 ${item.time}\n`;
                        listText += `   🔗 ${item.link}\n\n`;
                    });
                    listText += `💡 *Cara Menghapus:*\n`;
                    listText += `• Balas dengan: *hapus 1* (untuk menghapus no 1)\n`;
                    listText += `• Balas dengan: *hapus terakhir* (untuk membatalkan upload terakhir)\n`;
                    listText += `• Atau swipe reply pesan bot lalu ketik: *hapus*`;

                    await sock.sendMessage(remoteJid, {
                        text: listText
                    }, { quoted: msg });
                    continue;
                }

                // 2. CEK PERINTAH HAPUS ("hapus 1", "hapus terakhir", "del 2", "batal", atau reply pesan bot)
                if (textBody.startsWith('hapus') || textBody.startsWith('del') || textBody === 'batal') {
                    const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
                    const quotedText = (quoted?.conversation || quoted?.extendedTextMessage?.text || '');
                    
                    let targetItem = null;

                    if (textBody === 'batal' || textBody === 'hapus terakhir' || textBody === 'del last') {
                        const history = getHistory(1);
                        targetItem = history[0];
                    } else if (textBody.match(/^(hapus|del)\s+(\d+)$/)) {
                        const match = textBody.match(/^(hapus|del)\s+(\d+)$/);
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
                            text: `💡 *Panduan Menghapus File di Google Drive:*\n\n` +
                                  `• Ketik *hapus 1* ➔ Hapus file urutan ke-1 di daftar\n` +
                                  `• Ketik *hapus terakhir* ➔ Hapus file paling baru\n` +
                                  `• Atau *Swipe Reply* pesan hasil unggahan bot lalu ketik *hapus*`
                        }, { quoted: msg });
                        continue;
                    }

                    if (!targetItem) {
                        await sock.sendMessage(remoteJid, {
                            text: `⚠️ File tidak ditemukan dalam riwayat bot. Ketik *cek* untuk melihat daftar file aktif.`
                        }, { quoted: msg });
                        continue;
                    }

                    // Beri reaksi emoji tempat sampah 🗑️
                    try {
                        await sock.sendMessage(remoteJid, { react: { text: '🗑️', key: msg.key } });
                    } catch (e) {}

                    try {
                        console.log(`🗑️ Menghapus file "${targetItem.name}" (ID: ${targetItem.id}) dari Google Drive...`);
                        await deleteFileFromDrive(targetItem.id);
                        deleteFromHistory(targetItem.id);

                        await sock.sendMessage(remoteJid, {
                            text: `🗑️ *File Berhasil Dihapus!*\n\n` +
                                  `📄 *Nama File:* ${targetItem.name}\n` +
                                  `📦 *Ukuran:* ${targetItem.size}\n\n` +
                                  `✨ _File telah dihapus dari Google Drive Anda._`
                        }, { quoted: msg });
                        console.log(`✅ File "${targetItem.name}" sukses dihapus.`);
                    } catch (err) {
                        console.error('❌ Gagal menghapus file dari Drive:', err);
                        await sock.sendMessage(remoteJid, {
                            text: `❌ *Gagal Menghapus File*\n\nAlasan: ${err.message}`
                        }, { quoted: msg });
                    }
                    continue;
                }

                // 2. CEK FILE MEDIA
                const mediaInfo = extractMediaContent(msg.message);
                if (!mediaInfo) continue;

                const { type: mediaType, payload, fileName, mimetype, fileLength } = mediaInfo;

                // Cek batas ukuran
                const maxMb = Number(process.env.MAX_FILE_SIZE_MB || 2000);
                const maxBytes = maxMb * 1024 * 1024;
                if (fileLength > maxBytes) {
                    const warnMsg = await sock.sendMessage(remoteJid, {
                        text: `⚠️ *File Terlalu Besar*\nFile *${fileName}* (${formatBytes(fileLength)}) melebihi batas konfigurasi ${maxMb} MB.`,
                    }, { quoted: msg });
                    scheduleAutoDelete(sock, remoteJid, warnMsg.key, 3);
                    continue;
                }

                console.log(`\n📥 Menerima file: "${fileName}" [${formatBytes(fileLength)}] dari ${senderJid}`);

                // Step 1: Beri reaksi emoji ⏳ pada file yang dikirim
                try {
                    await sock.sendMessage(remoteJid, {
                        react: { text: '⏳', key: msg.key }
                    });
                } catch (e) {}

                const tempFileName = `${Date.now()}_${fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
                const tempFilePath = path.join(TEMP_DIR, tempFileName);

                // Step 2: Download file via stream
                await downloadMediaToDisk(payload, mediaType, tempFilePath);
                const stats = fs.statSync(tempFilePath);

                // Step 3: Update reaksi emoji menjadi ☁️ (Sedang mengunggah ke Google Drive)
                try {
                    await sock.sendMessage(remoteJid, {
                        react: { text: '☁️', key: msg.key }
                    });
                } catch (e) {}

                // Step 4: Upload ke Google Drive
                const uploadResult = await uploadFileStream({
                    filePath: tempFilePath,
                    fileName: fileName,
                    mimeType: mimetype
                });

                console.log(`✅ Berhasil diunggah ke Google Drive: ${uploadResult.name}`);

                // Hapus file lokal sementara
                try {
                    fs.unlinkSync(tempFilePath);
                } catch (e) {}

                // Step 5: Update reaksi emoji menjadi ✅ (Selesai!)
                try {
                    await sock.sendMessage(remoteJid, {
                        react: { text: '✅', key: msg.key }
                    });
                } catch (e) {}

                // Simpan ke riwayat lokal
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
                    link: directLink
                });

                // Step 6: Kirim HANYA SATU pesan hasil akhir yang rapi
                const successMessage = 
                    `✅ *Berhasil Diunggah ke Google Drive!*\n\n` +
                    `📄 *Nama File:* ${uploadResult.name}\n` +
                    `📦 *Ukuran:* ${formatBytes(uploadResult.size || stats.size)}\n` +
                    `🔗 *Link Google Drive:*\n${directLink}\n\n` +
                    `✨ _File tersimpan dalam resolusi asli tanpa kompresi._\n` +
                    `💡 _Ketik *cek* untuk melihat riwayat semua unggahan._`;

                const msgSuccess = await sock.sendMessage(remoteJid, {
                    text: successMessage
                }, { quoted: msg });

                // Auto delete opsional (jika diaktifkan > 0 di .env)
                const autoDeleteMin = Number(process.env.AUTO_DELETE_SUCCESS_MINUTES || 0);
                if (autoDeleteMin > 0) {
                    scheduleAutoDelete(sock, remoteJid, msgSuccess.key, autoDeleteMin);
                }

            } catch (err) {
                console.error('❌ Terjadi kesalahan saat memproses file:', err);
                try {
                    // Reaksi silang ❌ jika gagal
                    await sock.sendMessage(msg.key.remoteJid, {
                        react: { text: '❌', key: msg.key }
                    });
                    await sock.sendMessage(msg.key.remoteJid, {
                        text: `❌ *Gagal Mengunggah ke Google Drive*\n\nAlasan: ${err.message}`
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
