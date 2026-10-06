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
    const redirectUri = (redirect_uris && redirect_uris[0]) || 'urn:ietf:wg:oauth:2.0:oob';
    
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
 * Upload file besar via stream ke Google Drive
 */
async function uploadFileStream({ filePath, fileName, mimeType }) {
    const drive = await getDriveClient();
    let targetFolderId = process.env.GOOGLE_DRIVE_FOLDER_ID?.trim() || null;

    // Jika fitur sub-folder tanggal aktif
    if (process.env.AUTO_DATE_FOLDER === 'true') {
        const today = new Date().toISOString().split('T')[0]; // Format: YYYY-MM-DD
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

    // Resumable upload untuk file besar agar hemat RAM & tahan gangguan jaringan
    const response = await drive.files.create({
        requestBody: fileMetadata,
        media: media,
        fields: 'id, name, webViewLink, webContentLink, size'
    }, {
        // Timeout 30 menit untuk file gigabyte
        timeout: 1800000
    });

    // Buat file dapat dilihat/diakses (opsional: jika ingin public link atau view)
    try {
        await drive.permissions.create({
            fileId: response.data.id,
            requestBody: {
                role: 'reader',
                type: 'anyone'
            }
        });
    } catch (e) {
        // Abaikan jika akun workspace melarang sharing public
    }

    return response.data;
}

/**
 * Menghapus file dari Google Drive berdasarkan File ID
 */
async function deleteFileFromDrive(fileId) {
    const drive = await getDriveClient();
    await drive.files.delete({ fileId });
    return true;
}

module.exports = {
    getOAuth2Client,
    getDriveClient,
    uploadFileStream,
    deleteFileFromDrive,
    SCOPES,
    TOKEN_PATH,
    CREDENTIALS_PATH
};
