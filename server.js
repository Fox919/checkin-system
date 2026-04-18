import express from 'express';
import mysql from 'mysql2';
import dotenv from 'dotenv';

dotenv.config();

const app = express();

// --- 萬用 CORS 手動攔截器 ---
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, PATCH, DELETE");
  res.setHeader("Access-Control-Allow-Headers", "X-Requested-With, Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Credentials", "true");

  if (req.method === "OPTIONS") {
    return res.status(200).json({}); 
  }
  next();
});

app.use(express.json());

const db = mysql.createConnection({
  host: process.env.MYSQLHOST,
  user: process.env.MYSQLUSER,
  password: process.env.MYSQLPASSWORD,
  database: process.env.MYSQLDATABASE,
  port: process.env.MYSQLPORT || 3306
});

db.connect((err) => {
  if (err) {
    console.error('❌ 資料庫連線失敗:', err.message);
    return;
  }
  console.log('✅ 成功連進 Railway MySQL 資料庫！');
});

// --- 註冊路由 ---
app.post("/register", (req, res) => {
  const { name, phone, user_type } = req.body;
  const qr_code = `QR_${phone}_${Date.now()}`;
  const sql = "INSERT INTO users (name, phone, user_type, qr_code) VALUES (?, ?, ?, ?)";
  
  db.query(sql, [name, phone, user_type, qr_code], (err, result) => {
    if (err) return res.status(500).json({ error: "登記失敗" });
    res.json({ success: true, id: result.insertId, qr_code: qr_code });
  });
});

// --- 簽到路由 (已加入防重複機制) ---
app.post("/checkin/:id", (req, res) => {
  const userId = req.params.id;

  // 1. 【優化】先檢查該用戶是否在 5 秒內已經有簽到紀錄
  const checkDuplicateSql = `
    SELECT id FROM checkins 
    WHERE user_id = ? AND checkin_time > NOW() - INTERVAL 5 SECOND
  `;

  db.query(checkDuplicateSql, [userId], (err, recentRows) => {
    if (err) return res.status(500).json({ error: "查重失敗" });
    
    // 如果 5 秒內已有紀錄，直接回傳成功，不再寫入
    if (recentRows.length > 0) {
      console.log(`⚠️ 偵測到重複掃描 (ID: ${userId})，已跳過重複寫入`);
      return res.json({ success: true, message: "重複掃描，已跳過" });
    }

    // 2. 檢查用戶是否存在
    const findUserSql = "SELECT name, user_type FROM users WHERE id = ?";
    db.query(findUserSql, [userId], (err, rows) => {
      if (err) return res.status(500).json({ error: "數據庫查詢失敗" });
      if (rows.length === 0) return res.status(404).json({ error: "找不到此用戶" });

      const { name, user_type } = rows[0];

      // 3. 更新 users 狀態並寫入 checkins (建議在正式環境使用 Transaction)
      const updateUserSql = "UPDATE users SET status = 'checked-in' WHERE id = ?";
      db.query(updateUserSql, [userId], (updateErr) => {
        if (updateErr) return res.status(500).json({ error: "更新狀態失敗" });

        const insertCheckinSql = "INSERT INTO checkins (user_id, checkin_time, checkin_date) VALUES (?, NOW(), CURDATE())";
        db.query(insertCheckinSql, [userId], (insertErr) => {
          if (insertErr) {
            console.error("❌ 寫入 checkins 紀錄失敗:", insertErr);
          } else {
            console.log(`✅ 已為 ${name} 新增一筆簽到紀錄`);
          }
          res.json({ success: true, name: name, user_type: user_type });
        });
      });
    });
  });
});

app.get("/", (req, res) => {
  res.json({ message: "後端 API 正常運作中！", database: "已連線" });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`伺服器正運行在 Port: ${PORT}`);
});