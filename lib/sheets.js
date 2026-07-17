const { google } = require('googleapis');

function getGoogleAuth(scopes) {
  const credentials = {
    type:           'service_account',
    client_email:   process.env.GOOGLE_CLIENT_EMAIL,
    private_key:    Buffer.from(process.env.GOOGLE_PRIVATE_KEY, 'base64').toString('utf8'),
    private_key_id: process.env.GOOGLE_PRIVATE_KEY_ID,
  };
  return new google.auth.GoogleAuth({ credentials, scopes });
}

function getSheetsClient() {
  const auth = getGoogleAuth(['https://www.googleapis.com/auth/spreadsheets']);
  return google.sheets({ version: 'v4', auth });
}

// Solo lectura: la cuenta de servicio necesita que el usuario comparta la
// carpeta de Drive con permiso de Lector, nada mas (modulo Facturas IVA).
function getDriveClient() {
  const auth = getGoogleAuth(['https://www.googleapis.com/auth/drive.readonly']);
  return google.drive({ version: 'v3', auth });
}

async function getSheetGid(sheets, spreadsheetId, sheetName) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' });
  const sheet = meta.data.sheets.find(s => s.properties.title === sheetName);
  return sheet ? sheet.properties.sheetId : null;
}

async function ensureSheetExists(sheets, spreadsheetId, sheetName, headerRow) {
  const gid = await getSheetGid(sheets, spreadsheetId, sheetName);
  if (gid !== null) return gid;
  const res = await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ addSheet: { properties: { title: sheetName } } }] },
  });
  const newGid = res.data.replies[0].addSheet.properties.sheetId;
  if (headerRow) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `'${sheetName}'!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [headerRow] },
    });
  }
  return newGid;
}

module.exports = {
  getSheetsClient,
  getDriveClient,
  getSheetGid,
  ensureSheetExists,
  SHEET_ID: process.env.SHEET_ID,
};
