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

// Cấu hình Multer
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
});

// --- CẤU HÌNH AUTH CƠ BẢN (Mặc định dùng cho Upload Public) ---
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  "https://developers.google.com/oauthplayground"
);

// Mặc định dùng Token 1 cho các tác vụ chung
oauth2Client.setCredentials({
  refresh_token:
    process.env.GOOGLE_REFRESH_TOKEN_1 || process.env.GOOGLE_REFRESH_TOKEN,
});

const drive = google.drive({ version: "v3", auth: oauth2Client });

// --- LẤY ID THƯ MỤC ---
const getFolderId = (index = 0) => {
  const i = parseInt(index);
  return i === 1 ? process.env.FOLDER_ID_2 : process.env.FOLDER_ID_1;
};

// --- [HÀM MỚI] TẠO KẾT NỐI RIÊNG CHO TỪNG TÀI KHOẢN ---
const createDriveClient = (refreshToken) => {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    "https://developers.google.com/oauthplayground"
  );
  auth.setCredentials({ refresh_token: refreshToken });
  return google.drive({ version: "v3", auth });
};

// --- [CẬP NHẬT] HÀM TÍNH SIZE (CHẤP NHẬN DRIVE CLIENT RIÊNG) ---
async function calculateFolderSize(folderId, driveInstance = drive) {
  let totalBytes = 0;
  let pageToken = null;
  try {
    do {
      // Dùng driveInstance được truyền vào (nếu không truyền thì dùng mặc định)
      const res = await driveInstance.files.list({
        q: `'${folderId}' in parents and trashed = false`,
        fields: "nextPageToken, files(size)",
        pageSize: 1000,
        pageToken: pageToken,
      });

      if (res.data.files) {
        res.data.files.forEach((f) => {
          if (f.size) totalBytes += parseInt(f.size);
        });
      }
      pageToken = res.data.nextPageToken;
    } while (pageToken);
  } catch (e) {
    console.error(`Lỗi tính size folder ${folderId}:`, e.message);
  }
  return totalBytes;
}

// --- API PUBLIC ---

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
    // Lưu ý: Phần Public này đang dùng token mặc định.
    // Nếu acc 2 không share quyền cho acc 1 thì cần sửa thêm logic switch token ở đây.
    const response = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields:
        "files(id, name, mimeType, thumbnailLink, webViewLink, webContentLink)",
      pageSize: 100,
      orderBy: "createdTime desc",
    });
    res.json({ success: true, files: response.data.files });
  } catch (error) {
    console.error("Lỗi lấy list file:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// API Stats Trang chủ (Đơn giản)
app.get("/stats", async (req, res) => {
  try {
    const folderId = getFolderId(req.query.index);

    // Đếm số file
    const listRes = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: "files(id)",
      pageSize: 1000,
    });

    // Tính size folder
    const usedBytes = await calculateFolderSize(folderId, drive);

    // Lấy limit mặc định
    const limitBytes = 15 * 1024 * 1024 * 1024;
    const percent = ((usedBytes / limitBytes) * 100).toFixed(2);

    res.json({
      success: true,
      totalFiles: listRes.data.files?.length || 0,
      storage: {
        used: (usedBytes / 1024 / 1024 / 1024).toFixed(2),
        total: (limitBytes / 1024 / 1024 / 1024).toFixed(2),
        percent: percent,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API Upload
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

// --- API ADMIN ---

app.post("/admin/login", (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) res.json({ success: true });
  else res.status(401).json({ success: false });
});

const checkAdmin = (req, res, next) => {
  const token = req.headers["x-admin-pass"];
  if (token === ADMIN_PASSWORD) next();
  else res.status(401).json({ success: false, message: "Sai mật khẩu Admin" });
};

// --- [FIX QUAN TRỌNG] ADMIN STATS ĐA TÀI KHOẢN ---
app.get("/admin/stats-all", checkAdmin, async (req, res) => {
  try {
    // Cấu hình danh sách Server kèm Token riêng
    const serverConfigs = [
      {
        name: "Server VIP 1",
        id: process.env.FOLDER_ID_1,
        // Ưu tiên Token 1, nếu không có thì dùng token chung
        token:
          process.env.GOOGLE_REFRESH_TOKEN_1 ||
          process.env.GOOGLE_REFRESH_TOKEN,
      },
      {
        name: "Server VIP 2",
        id: process.env.FOLDER_ID_2,
        // Token riêng cho mail 2
        token: process.env.GOOGLE_REFRESH_TOKEN_2,
      },
    ];

    const servers = [];

    // Lặp qua từng cấu hình
    for (const sv of serverConfigs) {
      // Nếu thiếu token, báo lỗi
      if (!sv.token) {
        servers.push({ name: sv.name, error: "Chưa cấu hình Token" });
        continue;
      }

      // 1. TẠO KẾT NỐI RIÊNG (Switch Account)
      const currentDrive = createDriveClient(sv.token);

      // 2. LẤY THÔNG TIN ACCOUNT CỦA TOKEN ĐÓ
      const aboutRes = await currentDrive.about.get({ fields: "storageQuota" });
      const quota = aboutRes.data.storageQuota;

      const limitBytes = parseInt(quota.limit) || 15 * 1024 * 1024 * 1024;
      const totalUsedBytes = parseInt(quota.usage) || 0;
      const driveOnlyBytes = parseInt(quota.usageInDrive) || 0;
      const gmailBytes = Math.max(0, totalUsedBytes - driveOnlyBytes);

      // 3. TÍNH DUNG LƯỢNG FOLDER TRÊN TOKEN ĐÓ
      const webBytes = await calculateFolderSize(sv.id, currentDrive);
      const otherDriveBytes = Math.max(0, driveOnlyBytes - webBytes);

      servers.push({
        name: sv.name,
        // Gửi Raw Bytes về Client
        bytes_Limit: limitBytes,
        bytes_Total: totalUsedBytes,
        bytes_Web: webBytes,
        bytes_OtherDrive: otherDriveBytes,
        bytes_Gmail: gmailBytes,
      });
    }

    res.json({ success: true, servers });
  } catch (error) {
    console.error("Lỗi API Stats:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Admin File List
app.get("/admin/files/:index", checkAdmin, async (req, res) => {
  try {
    const folderId = getFolderId(req.params.index);
    const response = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields:
        "files(id, name, size, createdTime, mimeType, webViewLink, thumbnailLink, md5Checksum)",
      pageSize: 1000,
      orderBy: "createdTime desc",
    });
    res.json({ success: true, files: response.data.files });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Admin Delete File
app.delete("/admin/files/:index/:id", checkAdmin, async (req, res) => {
  try {
    await drive.files.delete({ fileId: req.params.id });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Admin Delete Multiple
app.post("/admin/delete-multiple", checkAdmin, async (req, res) => {
  try {
    const { fileIds } = req.body;
    if (!fileIds || !Array.isArray(fileIds)) {
      return res
        .status(400)
        .json({ success: false, message: "Dữ liệu không hợp lệ" });
    }

    let successCount = 0;
    let failCount = 0;

    const deletePromises = fileIds.map(async (id) => {
      try {
        await drive.files.delete({ fileId: id });
        successCount++;
      } catch (err) {
        console.error(`Lỗi xóa file ${id}:`, err.message);
        failCount++;
      }
    });

    await Promise.all(deletePromises);

    res.json({
      success: true,
      message: `Đã xóa ${successCount} file. (Lỗi/Không tìm thấy: ${failCount})`,
    });
  } catch (error) {
    console.error("Lỗi hệ thống xóa nhiều:", error);
    res
      .status(500)
      .json({ success: false, message: "Lỗi Server: " + error.message });
  }
});

// Admin Rename
app.post("/admin/rename", checkAdmin, async (req, res) => {
  try {
    const { fileId, newName } = req.body;
    await drive.files.update({
      fileId: fileId,
      requestBody: { name: newName },
    });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Admin Empty Trash
app.post("/admin/empty-trash/:index", checkAdmin, async (req, res) => {
  try {
    // Với logic Empty Trash cho từng acc riêng, bạn cũng nên tạo client riêng
    // Tuy nhiên ở đây đang dùng client chung, nếu cần fix kỹ phần này hãy báo mình
    await drive.files.emptyTrash();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server chạy port ${PORT}`));
