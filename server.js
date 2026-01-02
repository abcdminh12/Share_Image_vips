require("dotenv").config();
const express = require("express");
const multer = require("multer");
const { google } = require("googleapis");
const cors = require("cors");
const stream = require("stream");
const axios = require("axios");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

// --- KẾT NỐI OAUTH2 (Thay thế Robot cũ) ---
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  "https://developers.google.com/oauthplayground"
);

oauth2Client.setCredentials({
  refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
});

const drive = google.drive({ version: "v3", auth: oauth2Client });

// --- LẤY ID THƯ MỤC ---
const getFolderId = (index = 0) => {
  const i = parseInt(index);
  return i === 1 ? process.env.FOLDER_ID_2 : process.env.FOLDER_ID_1;
};

// --- CÁC API ---

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/accounts", (req, res) => {
  res.json({
    success: true,
    accounts: [
      { index: 0, name: "Server VIP 1 (Của Bạn)" },
      { index: 1, name: "Server VIP 2 (Của Bạn)" },
    ],
  });
});

app.get("/files", async (req, res) => {
  try {
    const folderId = getFolderId(req.query.index);
    const response = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields:
        "files(id, name, mimeType, thumbnailLink, webViewLink, webContentLink)",
      pageSize: 100,
      orderBy: "createdTime desc",
    });
    res.json({ success: true, files: response.data.files });
  } catch (error) {
    // THÊM DÒNG NÀY ĐỂ IN LỖI RA TERMINAL:
    console.error("Lỗi lấy file:", error); 
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/stats", async (req, res) => {
  try {
    const folderId = getFolderId(req.query.index);
    const listRes = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: "files(id)",
      pageSize: 1000,
    });
    const aboutRes = await drive.about.get({ fields: "storageQuota" });
    const quota = aboutRes.data.storageQuota;

    const limit = parseInt(quota.limit) || 0;
    const usage = parseInt(quota.usage) || 0;
    const percent = limit > 0 ? ((usage / limit) * 100).toFixed(1) : 0;

    res.json({
      success: true,
      totalFiles: listRes.data.files?.length || 0,
      storage: {
        used: (usage / 1024 / 1024 / 1024).toFixed(2),
        total: (limit / 1024 / 1024 / 1024).toFixed(2),
        percent: percent,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/upload", upload.single("myFile"), async (req, res) => {
  try {
    if (!req.file)
      return res.status(400).json({ success: false, error: "No file" });

    const folderId = getFolderId(req.body.accountIndex);
    const bufferStream = new stream.PassThrough();
    bufferStream.end(req.file.buffer);

    const driveRes = await drive.files.create({
      requestBody: {
        name: req.file.originalname,
        parents: [folderId],
      },
      media: {
        mimeType: req.file.mimetype,
        body: bufferStream,
      },
      fields: "id, name, webViewLink, thumbnailLink, mimeType",
    });

    await drive.permissions.create({
      fileId: driveRes.data.id,
      requestBody: { role: "reader", type: "anyone" },
    });

    res.json({
      success: true,
      data: {
        fileId: driveRes.data.id,
        name: driveRes.data.name,
        driveLink: driveRes.data.webViewLink,
        thumbnailLink: driveRes.data.thumbnailLink,
        mimeType: driveRes.data.mimeType,
      },
    });
  } catch (err) {
    console.error("Lỗi Upload:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/upload-url", async (req, res) => {
  try {
    const { url, accountIndex } = req.body;
    if (!url)
      return res.status(400).json({ success: false, message: "Thiếu URL" });

    const folderId = getFolderId(accountIndex);
    const response = await axios({
      method: "GET",
      url: url,
      responseType: "stream",
    });

    let filename = `url_upload_${Date.now()}.jpg`;
    // Logic lấy tên file đơn giản
    try {
      filename = url.split("/").pop().split("?")[0];
    } catch (e) {}

    const driveResponse = await drive.files.create({
      requestBody: { name: filename, parents: [folderId] },
      media: {
        mimeType: response.headers["content-type"],
        body: response.data,
      },
      fields: "id, name, webViewLink, thumbnailLink, mimeType",
    });

    await drive.permissions.create({
      fileId: driveResponse.data.id,
      requestBody: { role: "reader", type: "anyone" },
    });

    res.json({
      success: true,
      data: {
        fileId: driveResponse.data.id,
        name: driveResponse.data.name,
        driveLink: driveResponse.data.webViewLink,
        thumbnailLink: driveResponse.data.thumbnailLink,
        mimeType: driveResponse.data.mimeType,
      },
    });
  } catch (error) {
    res
      .status(500)
      .json({ success: false, message: "Lỗi tải từ URL: " + error.message });
  }
});

// Admin API rút gọn (Bạn có thể thêm lại logic Admin đầy đủ nếu cần)
app.post("/admin/login", (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) res.json({ success: true });
  else res.status(401).json({ success: false });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server chạy port ${PORT}`));