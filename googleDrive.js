const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
require('dotenv').config();

const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');
const TOKEN_PATH = path.join(__dirname, 'token.json');

const SCOPES = ['https://www.googleapis.com/auth/drive.file'];

/**
 * Mendapatkan OAuth2 Client
 */
function getOAuth2Client() {
    if (!fs.existsSync(CREDENTIALS_PATH)) {
        throw new Error(
            'File credentials.json tidak ditemukan!\n' +
            'Silakan download file credentials.json (OAuth 2.0 Client Desktop App) dari Google Cloud Console ' +
            'lalu simpan di folder ini.'
        );
    }

    const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
    const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
    const redirectUri = (redirect_uris && redirect_uris[0]) || 'http://localhost';
    
    return new google.auth.OAuth2(client_id, client_secret, redirectUri);
}

/**
 * Memastikan koneksi terotentikasi ke Google Drive
 */
async function getDriveClient() {
    const oAuth2Client = getOAuth2Client();

    if (!fs.existsSync(TOKEN_PATH)) {
        throw new Error(
            'File token.json belum ada! Silakan jalankan:\n' +
            '   node setup_drive.js\n' +
            'untuk menghubungkan akun Google Drive Anda terlebih dahulu.'
        );
    }

    const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
    oAuth2Client.setCredentials(token);

    // Auto save token jika di-refresh
    oAuth2Client.on('tokens', (tokens) => {
        const currentToken = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
        const updatedToken = { ...currentToken, ...tokens };
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(updatedToken, null, 2));
    });

    return google.drive({ version: 'v3', auth: oAuth2Client });
}

/**
 * Mencari atau membuat folder baru di Google Drive
 */
async function getOrCreateFolder(drive, folderName, parentId = null) {
    let query = `name = '${folderName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
    if (parentId) {
        query += ` and '${parentId}' in parents`;
    }

    const listRes = await drive.files.list({
        q: query,
        fields: 'files(id, name)',
        spaces: 'drive'
    });

    if (listRes.data.files && listRes.data.files.length > 0) {
        return listRes.data.files[0].id;
    }

    const fileMetadata = {
        name: folderName,
        mimeType: 'application/vnd.google-apps.folder',
        parents: parentId ? [parentId] : undefined
    };

    const folderRes = await drive.files.create({
        requestBody: fileMetadata,
        fields: 'id'
    });

    return folderRes.data.id;
}

/**
 * Upload file besar via stream ke Google Drive (Mendukung folder per user dan custom folder)
 */
async function uploadFileStream({ filePath, fileName, mimeType, customFolder = null, userFolder = null }) {
    const drive = await getDriveClient();
    let targetFolderId = process.env.GOOGLE_DRIVE_FOLDER_ID?.trim() || null;

    // 1. Isolasi folder per user (berdasarkan nomor/nama pengirim)
    if (userFolder) {
        targetFolderId = await getOrCreateFolder(drive, userFolder, targetFolderId);
    }

    // 2. Sub-folder kategori (#hashtag) atau tanggal
    if (customFolder) {
        targetFolderId = await getOrCreateFolder(drive, customFolder, targetFolderId);
    } else if (process.env.AUTO_DATE_FOLDER === 'true') {
        const today = new Date().toISOString().split('T')[0];
        targetFolderId = await getOrCreateFolder(drive, today, targetFolderId);
    }

    const fileMetadata = {
        name: fileName,
        parents: targetFolderId ? [targetFolderId] : undefined
    };

    const media = {
        mimeType: mimeType || 'application/octet-stream',
        body: fs.createReadStream(filePath)
    };

    const response = await drive.files.create({
        requestBody: fileMetadata,
        media: media,
        fields: 'id, name, webViewLink, webContentLink, size, parents'
    }, {
        timeout: 1800000 // 30 menit timeout
    });

    // Default: izinkan sharing via link
    try {
        await drive.permissions.create({
            fileId: response.data.id,
            requestBody: {
                role: 'reader',
                type: 'anyone'
            }
        });
    } catch (e) {}

    const subFolder = customFolder || (process.env.AUTO_DATE_FOLDER === 'true' ? new Date().toISOString().split('T')[0] : '');
    const displayFolder = userFolder ? (subFolder ? `${userFolder}/${subFolder}` : userFolder) : (subFolder || 'Root Drive');

    return {
        ...response.data,
        folderName: displayFolder
    };
}

/**
 * Menghapus file dari Google Drive berdasarkan File ID
 */
async function deleteFileFromDrive(fileId) {
    const drive = await getDriveClient();
    await drive.files.delete({ fileId });
    return true;
}

/**
 * Mengambil informasi kapasitas / storage Google Drive
 */
async function getDriveQuota() {
    const drive = await getDriveClient();
    const res = await drive.about.get({
        fields: 'storageQuota, user'
    });
    return res.data;
}

/**
 * Mencari file di Google Drive berdasarkan nama/kata kunci
 */
async function searchDriveFiles(query, limit = 5) {
    const drive = await getDriveClient();
    const escaped = query.replace(/'/g, "\\'");
    const res = await drive.files.list({
        q: `name contains '${escaped}' and mimeType != 'application/vnd.google-apps.folder' and trashed = false`,
        pageSize: limit,
        fields: 'files(id, name, size, mimeType, webViewLink, modifiedTime)'
    });
    return res.data.files || [];
}

/**
 * Mengunduh file dari Google Drive ke disk lokal dengan MIME type dan ekstensi asli
 */
async function downloadFileFromDrive(fileId, outputPath) {
    const drive = await getDriveClient();
    const metaRes = await drive.files.get({
        fileId,
        fields: 'id, name, mimeType, size'
    });
    const meta = metaRes.data;

    let res;
    let finalMime = meta.mimeType;

    // Jika file dikonversi menjadi format Google Workspace (Docs/Slides/Sheets), ekspor ke format standar Microsoft Office
    if (meta.mimeType === 'application/vnd.google-apps.presentation') {
        finalMime = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
        res = await drive.files.export(
            { fileId, mimeType: finalMime },
            { responseType: 'stream' }
        );
    } else if (meta.mimeType === 'application/vnd.google-apps.document') {
        finalMime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
        res = await drive.files.export(
            { fileId, mimeType: finalMime },
            { responseType: 'stream' }
        );
    } else if (meta.mimeType === 'application/vnd.google-apps.spreadsheet') {
        finalMime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
        res = await drive.files.export(
            { fileId, mimeType: finalMime },
            { responseType: 'stream' }
        );
    } else {
        res = await drive.files.get(
            { fileId, alt: 'media' },
            { responseType: 'stream' }
        );
    }

    const dest = fs.createWriteStream(outputPath);
    await new Promise((resolve, reject) => {
        res.data.pipe(dest);
        dest.on('finish', resolve);
        dest.on('error', reject);
    });

    return { ...meta, mimeType: finalMime };
}

/**
 * Mengatur hak akses publik atau privat
 */
async function setFilePermission(fileId, isPublic) {
    const drive = await getDriveClient();
    if (isPublic) {
        await drive.permissions.create({
            fileId,
            requestBody: { role: 'reader', type: 'anyone' }
        });
        return true;
    } else {
        const perms = await drive.permissions.list({ fileId });
        for (const p of perms.data.permissions || []) {
            if (p.type === 'anyone') {
                await drive.permissions.delete({ fileId, permissionId: p.id });
            }
        }
        return false;
    }
}

module.exports = {
    getOAuth2Client,
    getDriveClient,
    uploadFileStream,
    deleteFileFromDrive,
    getDriveQuota,
    searchDriveFiles,
    downloadFileFromDrive,
    setFilePermission,
    SCOPES,
    TOKEN_PATH,
    CREDENTIALS_PATH
};
