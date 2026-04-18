// 1. 引入必要的套件
import express from 'express';
import mysql from 'mysql2';
import cors from 'cors';
import dotenv from 'dotenv'; // 1. 確保有引入 dotenv

dotenv.config(); // 2. 必須執行 config() 才會讀取變數

const app = express();
app.use(cors({
  origin: 'https://checkin-frontend-taupe.vercel.app', // 建議填寫你前端的正確網址
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));
// 2. 額外手動處理 OPTIONS 請求 (這是針對某些環境下 CORS 套件失效的保險)
app.options('(.*)', cors());
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
    
    // 關鍵修改：回傳 result.insertId
    res.json({ 
      success: true, 
      id: result.insertId, // 這是資料庫自動生成的數字 ID
      qr_code: qr_code 
    });
  });
});// --- 你原本的簽到路由 ---
app.post("/checkin/:id", (req, res) => {
  const userId = req.params.id;

  // 1. 檢查用戶是否存在
  const findUserSql = "SELECT name, user_type FROM users WHERE id = ?";
  
  db.query(findUserSql, [userId], (err, rows) => {
    if (err) return res.status(500).json({ error: "數據庫查詢失敗" });
    if (rows.length === 0) return res.status(404).json({ error: "找不到此用戶" });

    const { name, user_type } = rows[0];

    // 2. 更新 users 表狀態 (標記目前在場)
    const updateUserSql = "UPDATE users SET status = 'checked-in' WHERE id = ?";
    
    db.query(updateUserSql, [userId], (updateErr) => {
      if (updateErr) return res.status(500).json({ error: "更新用戶狀態失敗" });

      // 3. 寫入 checkins 歷史紀錄表 (留下時間足跡)
      // 使用 NOW() 讓資料庫自動填入當前時間
      const insertCheckinSql = "INSERT INTO checkins (user_id, checkin_time) VALUES (?, NOW())";
      
      db.query(insertCheckinSql, [userId], (insertErr) => {
        if (insertErr) {
          console.error("❌ 寫入 checkins 紀錄失敗:", insertErr);
          // 這裡我們不報錯給前端，因為 users 表已經更新成功了
        } else {
          console.log(`✅ 已為 ${name} 新增一筆簽到紀錄`);
        }
        
        // 4. 回傳成功訊息給前端掃描器
        res.json({ 
          success: true, 
          name: name, 
          user_type: user_type 
        });
      });
    });
  });
});