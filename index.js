import express from "express";
import multer from "multer";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { v4 as uuid } from "uuid";
import cors from "cors";
import morgan from "morgan";
import dotenv from "dotenv";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, "public", "uploads");
const TOKEN = process.env.UPLOAD_TOKEN || "";
const PUBLIC_BASE = process.env.PUBLIC_BASE; // 可選
const MAX_AGE_HOURS = parseInt(process.env.MAX_AGE_HOURS || "24", 10);

// 允許的 MIME 與副檔名對應
const ALLOWED = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "video/mp4": ".mp4",
};

// 建立目錄
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// 中介層
app.use(cors());
app.use(morgan("tiny"));

function requireBearer(req, res, next) {
  if (!TOKEN) return res.status(500).json({ error: "UPLOAD_TOKEN not set" });
  const h = req.headers.authorization || "";
  const ok = h.startsWith("Bearer ") && h.slice(7) === TOKEN;
  if (!ok) return res.status(401).json({ error: "Unauthorized" });
  next();
}

function sanitizeBaseName(name) {
  // 僅保留英數、底線、dash、點；其餘轉為底線
  return (name || "").replace(/[^\w\-\.]/g, "_");
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const mime = file.mimetype;
    const orig = file.originalname || "file";
    const defExt = ALLOWED[mime] || path.extname(orig) || "";
    let ext = path.extname(orig) || defExt || "";
    if (!ext) ext = ALLOWED[mime] || "";

    // 嘗試使用原檔名（安全化）+ uuid，避免同名衝突
    const base = sanitizeBaseName(path.basename(orig, path.extname(orig))) || "file";
    const finalName = `${base}_${uuid()}${ext}`;
    cb(null, finalName);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB
  fileFilter: (_req, file, cb) => {
    if (ALLOWED[file.mimetype]) cb(null, true);
    else cb(new Error("Only jpg/png/gif/mp4 allowed"));
  },
});

// 靜態檔案：外部可直接讀取
app.use(
  "/files",
  express.static(UPLOAD_DIR, {
    maxAge: "1h",
    etag: false,
    setHeaders: (res) => {
      res.setHeader("Cache-Control", "public, max-age=3600");
    },
  })
);

app.get("/health", (_req, res) => res.json({ ok: true }));

// 同時支援 file(單檔) 與 files(多檔)
app.post(
  "/upload",
  requireBearer,
  upload.fields([
    { name: "file", maxCount: 1 },
    { name: "files", maxCount: 20 },
  ]),
  (req, res) => {
    const host =
      PUBLIC_BASE || `${req.protocol}://${req.get("x-forwarded-host") || req.get("host")}`;

    const collected = [];
    const add = (f) => {
      collected.push({
        url: `${host}/files/${encodeURIComponent(f.filename)}`,
        filename: f.filename,
        size: f.size,
        mimetype: f.mimetype,
      });
    };

    if (req.files?.file) req.files.file.forEach(add);
    if (req.files?.files) req.files.files.forEach(add);

    if (collected.length === 0) return res.status(400).json({ error: "No files received" });
    return res.json({ uploaded: collected });
  }
);

// 刪除指定檔案
app.delete("/files/:name", requireBearer, async (req, res) => {
  const name = path.basename(req.params.name);
  const f = path.join(UPLOAD_DIR, name);
  try {
    await fsp.unlink(f);
  } catch (err) {
    if (err.code !== "ENOENT") return res.status(500).json({ error: err.message });
  }
  return res.json({ deleted: true, name });
});

// 自動清檔（依 mtime 判斷）
async function cleanOldFiles() {
  try {
    const entries = await fsp.readdir(UPLOAD_DIR, { withFileTypes: true });
    const now = Date.now();
    const maxAgeMs = MAX_AGE_HOURS * 60 * 60 * 1000;
    let removed = 0;

    for (const e of entries) {
      if (!e.isFile()) continue;
      const full = path.join(UPLOAD_DIR, e.name);
      const stat = await fsp.stat(full);
      if (now - stat.mtimeMs > maxAgeMs) {
        await fsp.unlink(full).catch(() => {});
        removed += 1;
      }
    }
    if (removed > 0) console.log(`[clean] removed ${removed} old files`);
  } catch (err) {
    console.error("[clean] error:", err.message);
  }
}

// 每小時清一次
setInterval(cleanOldFiles, 60 * 60 * 1000);

app.listen(PORT, () => console.log(`File server on :${PORT}`));
