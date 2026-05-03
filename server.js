import express from 'express';
import mysql from 'mysql2';
import dotenv from 'dotenv';
import * as XLSX from 'xlsx';
import cors from 'cors';

dotenv.config();

const app = express();

// --- Middleware 設定 ---
// 強化 CORS 設定，解決你遇到的 "No 'Access-Control-Allow-Origin' header" 錯誤
app.use(cors({
  origin: '*', // 測試階段允許所有來源。若要更安全可改為 'https://checkin-frontend-taupe.vercel.app'
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

// Kiosk 專用：獲取所有用戶簡要名單
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

// 1. 預檢：姓名+電話 是否重複
app.post("/check-duplicate", (req, res) => {
  const { lastName, firstName, phone } = req.body;
  if (!lastName || !firstName || !phone) {
    return res.status(400).json({ error: "Missing fields" });
  }
  const sql = "SELECT id FROM users WHERE last_name = ? AND first_name = ? AND phone = ?";
  db.query(sql, [lastName, firstName, phone], (err, results) => {
    if (err) return res.status(500).json({ error: "Database error" });
    res.json({ isDuplicate: results.length > 0 });
  });
});

// 2. 註冊路由
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
  const params = [lastName, firstName, gender, fullName, phone, emailToSave, contactMethodString, lang, '', finalSource, referrer_name || null, 0, user_type, qr_code, notes || '', initialStatus];

  db.query(sql, params, (err, result) => {
    if (err) {
      if (err.code === 'ER_DUP_ENTRY' || err.errno === 1062) {
        return res.status(409).json({ error: "already_registered", message: "此資料已登記過" });
      }
      return res.status(500).json({ error: "登記失敗", detail: err.message });
    }
    const userId = result.insertId;
    if (autoCheckin) {
      db.query("INSERT INTO checkins (user_id, checkin_time, checkin_date) VALUES (?, NOW(), CURDATE())", [userId], (err) => {
        res.json({ success: true, message: "已完成登記與簽到", id: userId, name: fullName });
      });
    } else {
      res.json({ success: true, message: "已完成登記", id: userId, name: fullName });
    }
  });
});

// 3. 簽到路由
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
    if (hasCheckedInToday > 0) return res.json({ success: false, message: "今天已經簽到過了！" });

    db.query("UPDATE users SET status = 'checked-in' WHERE id = ?", [userId], (updateErr) => {
      db.query("INSERT INTO checkins (user_id, checkin_time, checkin_date) VALUES (?, NOW(), CURDATE())", [userId], (insertErr) => {
        res.json({ success: true, name, user_type, message: "簽到成功！" });
      });
    });
  });
});

// 4. 電話後四碼搜尋
app.get("/search-by-phone/:lastFour", (req, res) => {
  const lastFour = req.params.lastFour;
  if (!/^\d{4}$/.test(lastFour)) return res.status(400).json({ success: false, error: "請輸入 4 位數字" });

  const sql = `
    SELECT id, name, user_type, phone FROM users 
    WHERE RIGHT(REPLACE(REPLACE(REPLACE(phone, ' ', ''), '-', ''), '+', ''), 4) = ?
  `;
  db.query(sql, [lastFour], (err, rows) => {
    if (err) return res.status(500).json({ error: "搜尋失敗" });
    if (rows.length === 0) return res.status(404).json({ error: "找不到符合資料" });
    if (rows.length > 1) return res.status(400).json({ error: `找到 ${rows.length} 筆重複資料` });
    res.json({ success: true, ...rows[0] });
  });
});

// 5. 管理端：更新備註
app.post("/admin/update-note", (req, res) => {
  const { userId, note } = req.body;
  db.query("UPDATE users SET notes = ? WHERE id = ?", [note, userId], (err) => {
    if (err) return res.status(500).json({ error: "更新失敗" });
    res.json({ success: true });
  });
});

// --- 6. 管理端：獲取詳細用戶清單 ---
app.get("/admin/users", (req, res) => {
  const sql = `
    SELECT 
      u.id, u.last_name, u.first_name, u.gender, u.name, u.phone, 
      u.user_type, u.email, u.contact_method, 
      u.discovery_source, u.referrer_name,
      u.notes, u.status, u.receptionist_name, u.created_at,
      MAX(c.checkin_date) as last_checkin_date
    FROM users u
    LEFT JOIN checkins c ON u.id = c.user_id
    GROUP BY u.id
    ORDER BY u.id DESC
  `;
  db.query(sql, (err, rows) => {
    if (err) return res.status(500).json({ error: "讀取失敗" });
    res.json(rows);
  });
});

// --- 7. 管理端：導出 Excel ---
app.get("/admin/export-excel", (req, res) => {
  const filterDate = req.query.date;
  let sql = `
    SELECT 
      u.last_name AS '姓', u.first_name AS '名', 
      CASE WHEN u.gender = 'Male' THEN '男' WHEN u.gender = 'Female' THEN '女' ELSE '其他' END AS '性別',
      u.name AS '全名', u.phone AS '電話', u.email AS '電子郵件', 
      u.contact_method AS '聯繫偏好', u.discovery_source AS '來源', 
      u.referrer_name AS '介紹人', u.user_type AS '身份', u.notes AS '備註', 
      c.checkin_time AS '簽到時間' 
    FROM checkins c 
    JOIN users u ON c.user_id = u.id
  `;
  const params = [];
  if (filterDate) { 
    sql += ` WHERE DATE(c.checkin_time) = ?`; 
    params.push(filterDate); 
  }
  sql += ` ORDER BY c.checkin_time DESC`;

  db.query(sql, params, (err, rows) => {
    if (err) return res.status(500).send("導出失敗");
    const worksheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "簽到名單");
    const excelBuffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(excelBuffer);
  });
});

// --- 啟動伺服器 ---
const PORT = process.env.PORT || 5000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ 伺服器運行在 Port: ${PORT}`);
});

// 安全關閉連線池
process.on('SIGTERM', () => {
  db.end(() => process.exit(0));
});