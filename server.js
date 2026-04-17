// 1. 引入必要的套件
import express from 'express';
import mysql from 'mysql2';
import cors from 'cors';

// 2. 初始化 app (這行沒寫就會報你看到的錯誤)
const app = express();

// 3. 中間件設定
app.use(cors());
app.use(express.json());

// 4. 資料庫連線設定 (這裡維持你原本的 db 設定)
const db = mysql.createConnection({
  host: process.env.MYSQLHOST,
  // ... 其他設定
});

// 5. 路由設定 (這裡才是放 app.post 的地方)

// --- 你剛新增的註冊路由 ---
app.post("/register", (req, res) => {
  const { name, phone, user_type } = req.body;
  const qr_code = `QR_${phone}_${Date.now()}`;
  const sql = "INSERT INTO users (name, phone, user_type, qr_code) VALUES (?, ?, ?, ?)";
  
  db.query(sql, [name, phone, user_type, qr_code], (err, result) => {
    if (err) return res.status(500).json({ error: "登記失敗" });
    res.json({ success: true, qr_code: qr_code });
  });
});

// --- 你原本的簽到路由 ---
app.post("/checkin", (req, res) => {
  // ... 原本的代碼
});

// 6. 啟動伺服器
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});