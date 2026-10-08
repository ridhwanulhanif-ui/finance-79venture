/**
 * Finance dashboard (P&L, Balance Sheet, Forecast, Budget, Tax) – 79 Ventures & Arabina
 * Google Apps Script web-app backend. The page (Index.html) calls these functions through
 * google.script.run with the same tool names it uses on claude.ai (see gasShim() in index.html).
 */
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Finance dashboard – 79 Ventures & Arabina')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** get_file_metadata */
function getFileMeta(fileId) {
  var f = DriveApp.getFileById(fileId);
  return { id: f.getId(), title: f.getName(), mimeType: f.getMimeType(), modifiedTime: f.getLastUpdated().toISOString() };
}

/** download_file_content: .xlsx as base64 (native Google Sheets are exported to .xlsx) */
function getDriveFile(fileId) {
  if (!fileId) throw new Error('No file ID. Enter the Drive file link under "Data source".');
  var f = DriveApp.getFileById(fileId), mime = f.getMimeType(), bytes;
  if (mime === MimeType.GOOGLE_SHEETS) {
    var resp = UrlFetchApp.fetch('https://docs.google.com/spreadsheets/d/' + fileId + '/export?format=xlsx',
      { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) throw new Error('Could not export the Google Sheet (HTTP ' + resp.getResponseCode() + ').');
    bytes = resp.getBlob().getBytes();
    mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  } else {
    bytes = f.getBlob().getBytes();
  }
  return { content: Utilities.base64Encode(bytes), title: f.getName(), mimeType: mime, modifiedTime: f.getLastUpdated().toISOString() };
}

/** search_files: supports the query form the page uses, "parentId = '<folderId>'" */
function searchFiles(query) {
  var m = String(query || '').match(/parentId\s*=\s*'([^']+)'/);
  if (!m) throw new Error('Unsupported query: ' + query);
  var folder = DriveApp.getFolderById(m[1]), out = [];
  var it = folder.getFolders();
  while (it.hasNext()) { var d = it.next(); out.push({ id: d.getId(), title: d.getName(), mimeType: 'application/vnd.google-apps.folder', modifiedTime: d.getLastUpdated().toISOString() }); }
  var fi = folder.getFiles();
  while (fi.hasNext()) { var f = fi.next(); out.push({ id: f.getId(), title: f.getName(), mimeType: f.getMimeType(), modifiedTime: f.getLastUpdated().toISOString() }); }
  return { files: out };
}

/** read_file_content: text of a PDF bank statement via Drive OCR (needs the Drive advanced service, see appsscript.json) */
function readFileText(fileId) {
  var src = DriveApp.getFileById(fileId);
  var copy = Drive.Files.copy({ name: 'tmp-ocr-' + fileId, mimeType: MimeType.GOOGLE_DOCS }, fileId, { ocrLanguage: 'en' });
  try {
    var text = DocumentApp.openById(copy.id).getBody().getText();
    return { fileContent: text, title: src.getName() };
  } finally {
    DriveApp.getFileById(copy.id).setTrashed(true);
  }
}
