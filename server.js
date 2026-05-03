import express from 'express';
import mysql from 'mysql2';
import dotenv from 'dotenv';
import * as XLSX from 'xlsx';
import cors from 'cors';

dotenv.config();

const app = express();

// --- Middleware 設定 ---
//app.use(cors());

// 建議改用這個明確的設定
app.use(cors({
  origin: '*', // 允許所有網域存取，或者指定 'https://checkin-frontend-taupe.vercel.app'
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// --- 資料庫連線 (使用 Pool) ---
const db = mysql.createPool({
  host: process.env.MYSQLHOST,
  user: process.env.MYSQLUSER,
  password: process.env.MYSQLPASSWORD,
  database: process.env.MYSQL_DATABASE,
  port: process.env.MYSQLPORT || 3306,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// --- 路由 ---

// 根目錄測試
app.get('/', (req, res) => {
  res.status(200).send('Backend is running!');
});

/**
 * --- 新增：Kiosk 專用路由 ---
 * 解決 Kiosk.js 一進頁面就報錯的問題。
 * 抓取所有用戶的簡單資訊，用於前端快速比對搜尋。
 */
app.get("/users", (req, res) => {
  const sql = "SELECT id, name, phone, user_type FROM users";
  db.query(sql, (err, rows) => {
    if (err) {
      console.error("Kiosk 名單讀取錯誤:", err);
      return res.status(500).json({ error: "讀取名單失敗" });
    }
    res.json(rows);
  });
});

// --- 1. 預檢：姓名+電話 是否重複 ---
app.post("/check-duplicate", (req, res) => {
  const { lastName, firstName, phone } = req.body;

  if (!lastName || !firstName || !phone) {
    return res.status(400).json({ error: "Missing fields" });
  }

  const sql = "SELECT id FROM users WHERE last_name = ? AND first_name = ? AND phone = ?";
  
  db.query(sql, [lastName, firstName, phone], (err, results) => {
    if (err) {
      console.error("預檢 SQL 錯誤:", err);
      return res.status(500).json({ error: "Database error" });
    }
    res.json({ isDuplicate: results.length > 0 });
  });
});

// --- 2. 註冊路由 ---
app.post("/register", (req, res) => {
  const { 
    lastName, firstName, gender, phone, email, 
    contact_method, lang, discovery_source, 
    referrer_name, other_source_text,
    user_type, autoCheckin, notes 
  } = req.body; 

  const fullName = `${lastName}${firstName}`;
  const qr_code = `QR_${phone}_${Date.now()}`;
  const finalSource = discovery_source === 'Other' ? other_source_text : discovery_source;
  const emailToSave = (email && email.trim() !== '') ? email : null;
  const initialStatus = autoCheckin ? 'checked-in' : 'active';

  const sql = `
    INSERT INTO users (
      last_name, first_name, gender, name, phone, email, 
      contact_method, lang, city, discovery_source, 
      referrer_name, youtube_subscribed, user_type, 
      qr_code, notes, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  const contactMethodString = Array.isArray(contact_method) ? contact_method.join(',') : contact_method;

  const params = [
    lastName, firstName, gender, fullName, phone, emailToSave, 
    contactMethodString, lang, '', finalSource, referrer_name || null, 
    0, user_type, qr_code, notes || '', initialStatus
  ];

  db.query(sql, params, (err, result) => {
    if (err) {
      if (err.code === 'ER_DUP_ENTRY' || err.errno === 1062) {
        return res.status(409).json({ error: "already_registered", message: "此資料已登記過" });
      }
      console.error("註冊 SQL 錯誤:", err);
      return res.status(500).json({ error: "登記失敗", detail: err.message });
    }
    
    const userId = result.insertId;
    
    if (autoCheckin) {
      db.query("INSERT INTO checkins (user_id, checkin_time, checkin_date) VALUES (?, NOW(), CURDATE())", [userId], (err) => {
        if (err) {
          return res.json({ success: true, message: "登記成功但自動簽到失敗", id: userId, name: fullName });
        }
        res.json({ success: true, message: "已完成登記與簽到", id: userId, name: fullName });
      });
    } else {
      res.json({ success: true, message: "已完成登記", id: userId, name: fullName });
    }
  });
});

// --- 3. 簽到路由 ---
app.post("/checkin/:id", (req, res) => {
  const userId = req.params.id;
  const checkSql = `
    SELECT u.name, u.user_type, 
    (SELECT COUNT(*) FROM checkins WHERE user_id = ? AND checkin_date = CURDATE()) as hasCheckedInToday
    FROM users u WHERE u.id = ?
  `;

  db.query(checkSql, [userId, userId], (err, rows) => {
    if (err) return res.status(500).json({ success: false, error: "數據庫查詢失敗" });
    if (rows.length === 0) return res.status(404).json({ success: false, error: "找不到此用戶" });

    const { name, user_type, hasCheckedInToday } = rows[0];

    if (hasCheckedInToday > 0) {
      return res.json({ success: false, message: "今天已經簽到過了！" });
    }

    db.query("UPDATE users SET status = 'checked-in' WHERE id = ?", [userId], (updateErr) => {
      if (updateErr) return res.status(500).json({ success: false, error: "更新狀態失敗" });
      
      db.query("INSERT INTO checkins (user_id, checkin_time, checkin_date) VALUES (?, NOW(), CURDATE())", [userId], (insertErr) => {
        if (insertErr) return res.status(500).json({ success: false, error: "插入簽到紀錄失敗" });
        res.json({ success: true, name: name, user_type: user_type, message: "簽到成功！" });
      });
    });
  });
});

// --- 4. 電話後四碼搜尋路由 (用於後端驗證/備用) ---
app.get("/search-by-phone/:lastFour", (req, res) => {
  const lastFour = req.params.lastFour;
  if (!/^\d{4}$/.test(lastFour)) {
    return res.status(400).json({ success: false, error: "請輸入正確的 4 位電話號碼" });
  }

  const sql = `
    SELECT id, name, user_type, phone 
    FROM users 
    WHERE RIGHT(REPLACE(REPLACE(REPLACE(phone, ' ', ''), '-', ''), '+', ''), 4) = ?
  `;

  db.query(sql, [lastFour], (err, rows) => {
    if (err) return res.status(500).json({ success: false, error: "伺服器搜尋錯誤" });
    if (rows.length === 0) return res.status(404).json({ success: false, error: "找不到符合的資料" });
    if (rows.length > 1) return res.status(400).json({ success: false, error: `找到 ${rows.length} 筆重複資料` });

    res.json({ success: true, id: rows[0].id, name: rows[0].name, user_type: rows[0].user_type });
  });
});

// --- 5. 管理端：更新備註 ---
app.post("/admin/update-note", (req, res) => {
  const { userId, note } = req.body;
  db.query("UPDATE users SET notes = ? WHERE id = ?", [note, userId], (err) => {
    if (err) return res.status(500).json({ error: "更新失敗" });
    res.json({ success: true, message: "備註已更新" });
  });
});

// --- 6. 管理端：獲取詳細用戶清單 ---
app