import express from "express";
import mysql from "mysql2";
import cors from "cors";
import dotenv from "dotenv";
import { v4 as uuidv4 } from "uuid";
import QRCode from "qrcode";

dotenv.config();


const app = express();

app.use(cors());

app.use(express.json());

// 建議加一個根目錄測試，確認伺服器活著
app.get('/', (req, res) => {
    res.send("Backend is running!");
});

// 確保路徑拼寫與前端呼叫的一致
app.get('/api/checkin-history', (req, res) => {
    // 你的資料庫查詢邏輯...
    res.json({ message: "Success" }); 
});

// 關鍵：監聽環境變數 PORT 並使用 0.0.0.0
const PORT = process.env.PORT || 5050;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server is running on port ${PORT}`);
});
// 7. 資料庫連線 (放在 listen 後面可以防止連線卡住導致伺服器無法啟動)
const db = mysql.createConnection({
  // 將 DB_HOST 改為 MYSQLHOST，依此類推
  host: process.env.MYSQLHOST || "localhost",
  user: process.env.MYSQLUSER || "root",
  password: process.env.MYSQLPASSWORD || "",
  database: process.env.MYSQLDATABASE || "your_db_name",
  port: process.env.MYSQLPORT || 3306
});

db.connect((err) => {
  if (err) {
    console.log("❌ MySQL error:", err);
  } else {
    console.log("✅ MySQL connected (Connected to: Railway)");
    
    // --- 加入這段：強制設定本次連線為洛杉磯時區 ---
    db.query("SET time_zone = '-07:00';", (err) => {
      if (err) console.error("❌ 時區設定失敗:", err);
      else console.log("🕒 時區已切換至洛杉磯 (UTC-7)");
    });
    // ------------------------------------------
  }
});

// ① 註冊 API
app.post("/register", async (req, res) => {
  const { name, phone } = req.body;
  if (!name || !phone) return res.status(400).json({ error: "資料不全" });

  const qr_code = uuidv4();

  db.query(
    "INSERT INTO users (name, phone, qr_code) VALUES (?, ?, ?)",
    [name, phone, qr_code],
    async (err) => {
      if (err) return res.status(500).json({ error: "資料庫寫入失敗" });
      const qrImage = await QRCode.toDataURL(qr_code);
      res.json({ qrImage, qr_code });
    }
  );
});

// ② 簽到 API
app.post("/checkin", (req, res) => {
  const { qr_code } = req.body;
  if (!qr_code) return res.status(400).json({ error: "缺少 QR Code" });

  db.query("SELECT id FROM users WHERE qr_code = ?", [qr_code], (err, users) => {
    if (err) return res.status(500).json({ error: "資料庫查詢錯誤" });
    if (users.length === 0) return res.status(404).json({ error: "找不到此學員" });

    const user_id = users[0].id;
    const now = new Date();
    const today = now.toISOString().slice(0, 10); // YYYY-MM-DD
    const currentTime = now.toTimeString().slice(0, 8); // HH:MM:SS

    // 檢查今天是否重複簽到
    db.query(
      "SELECT * FROM checkins WHERE user_id=? AND checkin_date=?",
      [user_id, today],
      (err, rows) => {
        if (rows && rows.length > 0) return res.json({ message: "今天已簽到過了" });

        // 寫入簽到紀錄 (確保欄位名稱與你的資料庫完全一致)



        // 1. SQL 字串裡有 1 個問號，對應 1 個變數
// 2. 使用 CONVERT_TZ 強制將時間轉為洛杉磯 (-07:00)
const sql = "INSERT INTO checkins (user_id, checkin_time, checkin_date) VALUES (?, CONVERT_TZ(NOW(), '+00:00', '-07:00'), CURDATE())";

db.query(
  sql,
  [user_id], // <--- 這個絕對要保留！它對應 SQL 裡的第一個問號
  (err) => {
    if (err) {
      console.log("❌ 簽到寫入失敗:", err);
      return res.status(500).json({ error: "寫入簽到表失敗" });
    }
    res.json({ message: "簽到成功！歡迎光臨" });
  }
);
      }
    );
  });
});

