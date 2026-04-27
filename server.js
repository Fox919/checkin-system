import express from 'express';
import mysql from 'mysql2';
import dotenv from 'dotenv';
import * as XLSX from 'xlsx';
import cors from 'cors';

dotenv.config();

const app = express();

// --- Middleware 設定 ---
app.use(cors());
app.use(express.json());
//hfhfhfhfhg
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
// 注意：Pool 不需要手動呼叫 .connect()，它會自動處理

// --- 路由 ---

// 根目錄測試
app.get('/', (req, res) => {
  res.status(200).send('Backend is running!');
});

// 註冊
app.post("/register", (req, res) => {
  const { name, phone, user_type, email, lang, autoCheckin, notes } = req.body; 
  const qr_code = `QR_${phone}_${Date.now()}`;
  const emailToSave = (email && email.trim() !== '') ? email : null;
  const noteToSave = notes || ''; 

  const sql = `INSERT INTO users (name, phone, user_type, qr_code, email, lang, notes) VALUES (?, ?, ?, ?, ?, ?, ?)`;
  
  db.query(sql, [name, phone, user_type, qr_code, emailToSave, lang, noteToSave], (err, result) => {
    if (err) {
      console.error("註冊 SQL 錯誤:", err); 
      return res.status(500).json({ error: "登記失敗" });
    }
    const userId = result.insertId;
    if (autoCheckin) {
      db.query("UPDATE users SET status = 'checked-in' WHERE id = ?", [userId]);
      db.query("INSERT INTO checkins (user_id, checkin_time, checkin_date) VALUES (?, NOW(), CURDATE())", [userId]);
      res.json({ success: true, message: "已完成登記與簽到", id: userId });
    } else {
      res.json({ success: true, message: "已完成登記", id: userId });
    }
  });
});

// 簽到
app.post("/checkin/:id", (req, res) => {
  const userId = req.params.id;
  const findUserSql = "SELECT name, user_type FROM users WHERE id = ?";
  db.query(findUserSql, [userId], (err, rows) => {
    if (err) return res.status(500).json({ error: "數據庫查詢失敗" });
    if (rows.length === 0) return res.status(404).json({ error: "找不到此用戶" });

    const { name, user_type } = rows[0];
    const checkDuplicateSql = `SELECT id FROM checkins WHERE user_id = ? AND checkin_time > NOW() - INTERVAL 5 SECOND`;

    db.query(checkDuplicateSql, [userId], (err, recentRows) => {
      if (err) return res.status(500).json({ error: "查重失敗" });
      if (recentRows.length > 0) {
        return res.json({ success: true, name: name, user_type: user_type, message: "請勿重複掃描" });
      }

      db.query("UPDATE users SET status = 'checked-in' WHERE id = ?", [userId], (updateErr) => {
        if (updateErr) return res.status(500).json({ error: "更新狀態失敗" });
        db.query("INSERT INTO checkins (user_id, checkin_time, checkin_date) VALUES (?, NOW(), CURDATE())", [userId], (insertErr) => {
          res.json({ success: true, name: name, user_type: user_type });
        });
      });
    });
  });
});

// 獲取用戶清單
app.get("/users", (req, res) => {
  db.query("SELECT id, name, phone, user_type FROM users", (err, rows) => {
    if (err) return res.status(500).json({ error: "讀取失敗" });
    res.json(rows);
  });
});

app.get("/admin/users", (req, res) => {
  // 這裡加入 LEFT JOIN，把 users 和 checkins 串接起來
  // 如果你有 created_at 欄位，請確保它也在 SELECT 中
  const sql = `
    SELECT 
      u.id, u.name, u.phone, u.user_type, u.email, u.notes, u.status, u.created_at,
      MAX(c.checkin_date) as checkin_date
    FROM users u
    LEFT JOIN checkins c ON u.id = c.user_id
    GROUP BY u.id
    ORDER BY u.id DESC
  `;

  db.query(sql, (err, rows) => {
    if (err) {
      console.error("查詢錯誤:", err);
      return res.status(500).json({ error: "讀取失敗" });
    }
    res.json(rows);
  });
});



// 管理員：獲取簽到
app.get("/admin/checkins", (req, res) => {
  const sql = `SELECT c.id, u.name, u.phone, u.user_type, c.checkin_time FROM checkins c JOIN users u ON c.user_id = u.id ORDER BY c.checkin_time DESC`;
  db.query(sql, (err, rows) => {
    if (err) return res.status(500).json({ error: "讀取失敗" });
    res.json(rows);
  });
});

// 管理員：導出 Excel
app.get("/admin/export-excel", (req, res) => {
  const filterDate = req.query.date;
  let sql = `SELECT u.name AS '姓名', u.phone AS '電話', u.user_type AS '身份', c.checkin_time AS '簽到時間' FROM checkins c JOIN users u ON c.user_id = u.id`;
  const params = [];
  if (filterDate) { sql += ` WHERE DATE(c.checkin_time) = ?`; params.push(filterDate); }
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
  console.log(`✅ 伺服器正運行在 Port: ${PORT}`);
});

process.on('SIGTERM', () => {
  console.log('收到 SIGTERM 訊號...');
  db.end((err) => process.exit(0));
});