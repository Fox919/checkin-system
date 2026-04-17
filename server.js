// 1. 引入必要的套件
import express from 'express';
import mysql from 'mysql2';
import cors from 'cors';
import dotenv from 'dotenv'; // 1. 確保有引入 dotenv

dotenv.config(); // 2. 必須執行 config() 才會讀取變數

const app = express();
app.use(cors());
app.use(express.json());

// 3. 檢查這裡的變數名稱是否跟 Railway 後台的 Variables 一模一樣
const db = mysql.createConnection({
  host: process.env.MYSQLHOST,
  user: process.env.MYSQLUSER,        // 檢查是否寫成 MYSQLUSER
  password: process.env.MYSQLPASSWORD, // 檢查是否寫成 MYSQLPASSWORD
  database: process.env.MYSQLDATABASE, // 檢查是否寫成 MYSQLDATABASE
  port: process.env.MYSQLPORT || 3306
});

// 4. 增加一個錯誤監聽，防止程式因為連線失敗直接崩潰
db.connect((err) => {
  if (err) {
    console.error('❌ 資料庫連線失敗:', err.message);
    return;
  }
  console.log('✅ 成功連進 Railway MySQL 資料庫！');
});// 5. 路由設定 (這裡才是放 app.post 的地方)

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