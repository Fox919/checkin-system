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



// 修改後的註冊路由
// 修改後的註冊路由 (支援姓、名拆分)
// --- 新增：預檢 姓名+電話 是否重複 ---
app.post("/check-duplicate", (req, res) => {
  const { lastName, firstName, phone } = req.body;

  if (!lastName || !firstName || !phone) {
    return res.status(400).json({ error: "Missing fields" });
  }

  // 查詢資料庫中是否有這三項完全符合的紀錄
  const sql = "SELECT id FROM users WHERE last_name = ? AND first_name = ? AND phone = ?";
  
  db.query(sql, [lastName, firstName, phone], (err, results) => {
    if (err) {
      console.error("預檢 SQL 錯誤:", err);
      return res.status(500).json({ error: "Database error" });
    }

    if (results.length > 0) {
      // 找到匹配，判定為重複
      res.json({ isDuplicate: true });
    } else {
      // 沒有重複
      res.json({ isDuplicate: false });
    }
  });
});




app.post("/register", (req, res) => {
  // 1. 接收所有新欄位
  const { 
    lastName, firstName, gender, phone, email, 
    contact_method, lang, city, discovery_source, 
    referrer_name, other_source_text, youtube_subscribed,
    user_type, autoCheckin, notes 
  } = req.body; 

  // 2. 邏輯處理
  const fullName = `${lastName}${firstName}`;
  const qr_code = `QR_${phone}_${Date.now()}`;
  
  // 處理得知管道：如果是 "Other"，則存入說明文字
  const finalSource = discovery_source === 'Other' ? other_source_text : discovery_source;
  
  // 處理 Email：如果是空字串則存 null
  const emailToSave = (email && email.trim() !== '') ? email : null;
  
  // 決定預設狀態 (現場簽到 vs 預約登記)
  const initialStatus = autoCheckin ? 'checked-in' : 'active';

  // 3. 準備完整的 SQL 指令
  // 注意：請確保你已經執行了 ALTER TABLE 指令增加這些欄位
  const sql = `
    INSERT INTO users (
      last_name, first_name, gender, name, phone, email, 
      contact_method, lang, city, discovery_source, 
      referrer_name, youtube_subscribed, user_type, 
      qr_code, notes, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  const contactMethodString = Array.isArray(contact_method) 
    ? contact_method.join(',') 
    : contact_method;

  const params = [
    lastName, 
    firstName, 
    gender, 
    fullName, 
    phone, 
    emailToSave, 
    contactMethodString, 
    lang, 
    city, 
    finalSource, 
    referrer_name || null, 
    youtube_subscribed ? 1 : 0, // MySQL 中 BOOLEAN 存為 1 或 0
    user_type, 
    qr_code, 
    notes || '', 
    initialStatus
  ];

  db.query(sql, params, (err, result) => {
    if (err) {
      if (err.code === 'ER_DUP_ENTRY' || err.errno === 1062) {
        return res.status(409).json({ 
          error: "already_registered", 
          message: "此電話號碼已登記過" 
        });
      }
      console.error("註冊 SQL 錯誤:", err); 
      return res.status(500).json({ error: "登記失敗", detail: err.message });
    }
    
    const userId = result.insertId;
    
    // 4. 自動簽到邏輯 (如果是現場登記)
    if (autoCheckin) {
      db.query("INSERT INTO checkins (user_id, checkin_time, checkin_date) VALUES (?, NOW(), CURDATE())", [userId], (err) => {
        if (err) {
            console.error("自動簽到 SQL 錯誤:", err);
            return res.json({ success: true, message: "登記成功但自動簽到失敗", id: userId, name: fullName });
        }
        res.json({ success: true, message: "已完成登記與簽到", id: userId, name: fullName });
      });
    } else {
      res.json({ success: true, message: "已完成登記", id: userId, name: fullName });
    }
  });
});


// 簽到路由修正版
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
     // return res.status(200).json({ success: false, message: "今天已經簽到過了，請勿重複簽到！" });
    return res.json({ 
    success: false, 
    message: "今天已經簽到過了，請勿重複簽到！" 
  });
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

// --- 新增：電話後四碼搜尋路由 ---
app.get("/search-by-phone/:lastFour", (req, res) => {
  const lastFour = req.params.lastFour;

  if (!/^\d{4}$/.test(lastFour)) {
    return res.status(400).json({ success: false, error: "請輸入正確的 4 位電話號碼" });
  }

  const sql = "SELECT id, name, user_type FROM users WHERE phone LIKE ?";
  
  db.query(sql, [`%${lastFour}`], (err, rows) => {
    if (err) {
      console.error("搜尋 SQL 錯誤:", err);
      return res.status(500).json({ success: false, error: "伺服器搜尋失敗" });
    }

    if (rows.length === 0) {
      return res.status(404).json({ success: false, error: "找不到匹配的登記資料" });
    }

    if (rows.length > 1) {
      return res.status(400).json({ success: false, error: `找到 ${rows.length} 筆重複資料，請輸入完整電話。` });
    }

    res.json({ 
      success: true,
      id: rows[0].id, 
      name: rows[0].name, 
      user_type: rows[0].user_type 
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


  // 新增這一段到 server.js
app.post("/admin/update-note", (req, res) => {
  const { userId, note } = req.body;

  // SQL 指令：更新對應 ID 的用戶備註
  const sql = "UPDATE users SET notes = ? WHERE id = ?";
  
  db.query(sql, [note, userId], (err, result) => {
    if (err) {
      console.error("更新備註 SQL 錯誤:", err);
      return res.status(500).json({ error: "更新備註失敗" });
    }
    
    res.json({ success: true, message: "備註已更新" });
  });
});



app.get("/admin/users", (req, res) => {
  const sql = `
    SELECT 
      u.id, u.last_name, u.first_name, u.gender, u.name, u.phone, 
      u.user_type, u.email, u.contact_method, u.city, 
      u.discovery_source, u.referrer_name, u.youtube_subscribed,
      u.notes, u.status, u.receptionist_name, u.created_at,
      MAX(c.checkin_date) as last_checkin_date
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
// 更新接待人員名稱
app.put("/api/users/:id/receptionist", (req, res) => {
  const userId = req.params.id;
  const { receptionistName } = req.body;

  const sql = "UPDATE users SET receptionist_name = ? WHERE id = ?";
  db.query(sql, [receptionistName, userId], (err, result) => {
    if (err) {
      console.error("更新接待人員錯誤:", err);
      return res.status(500).json({ error: "伺服器錯誤" });
    }
    res.json({ success: true, message: "接待人員已確認" });
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
  let sql = `
    SELECT 
      u.last_name AS '姓', u.first_name AS '名', u.gender AS '性別', 
      u.name AS '全名', u.phone AS '電話', u.email AS '電子郵件', 
      u.contact_method AS '聯繫偏好', u.city AS '居住城市', 
      u.discovery_source AS '來源', u.referrer_name AS '介紹人',
      IF(u.youtube_subscribed, '是', '否') AS '訂閱YouTube',
      u.user_type AS '身份', u.notes AS '備註', 
      u.receptionist_name AS '接待人員',
      c.checkin_time AS '簽到時間' 
    FROM checkins c 
    JOIN users u ON c.user_id = u.id
  `;
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