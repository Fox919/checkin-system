import express from 'express';
import mysql from 'mysql2';
import dotenv from 'dotenv';
import * as XLSX from 'xlsx';
import cors from 'cors';

dotenv.config();

const app = express();

// --- Middleware 設定 ---
// 強化 CORS： origin 設定為 true 會自動抓取請求來源，並允許它，這對 Vercel 最穩定
app.use(cors({
  origin: true, 
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
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

// 1. 根目錄測試
app.get('/', (req, res) => {
  res.status(200).send('✅ Check-in System API is running!');
});

// 2. Kiosk 專用：獲取所有用戶簡要名單
app.get("/users", (req, res) => {
  // 增加排序，讓最新加入的人顯示在前面
  const sql = "SELECT id, name, phone, user_type FROM users ORDER BY id DESC";
  db.query(sql, (err, rows) => {
    if (err) {
      console.error("Kiosk 名單讀取錯誤:", err);
      return res.status(500).json({ error: "伺服器讀取名單失敗" });
    }
    res.json(rows);
  });
});

// 3. 預檢：姓名+電話 是否重複 (註冊第一步)
app.post("/check-duplicate", (req, res) => {
  const { lastName, firstName, phone } = req.body;
  if (!lastName || !firstName || !phone) {
    return res.status(400).json({ error: "請填寫完整姓名與電話" });
  }
  const sql = "SELECT id FROM users WHERE last_name = ? AND first_name = ? AND phone = ?";
  db.query(sql, [lastName, firstName, phone], (err, results) => {
    if (err) return res.status(500).json({ error: "資料庫查詢錯誤" });
    res.json({ isDuplicate: results.length > 0 });
  });
});

// 4. 註冊路由 (配合隱藏場景入口)
app.post("/register", (req, res) => {
  const { 
    lastName, firstName, gender, phone, email, 
    contact_method, lang, discovery_source, 
    referrer_name, other_source_text,
    user_type, autoCheckin, notes 
  } = req.body; 

  const fullName = `${lastName}${firstName}`;
  // 產生唯一的 QR Code 標記 (備用)
  const qr_code = `QR_${phone}_${Date.now()}`;
  const finalSource = discovery_source === 'Other' ? other_source_text : discovery_source;
  const emailToSave = (email && email.trim() !== '') ? email : null;
  const initialStatus = autoCheckin ? 'checked-in' : 'active';
  
  // 預設身份邏輯：若前端沒傳 type，預設為 Visitor
  const finalUserType = user_type || 'Visitor';

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
    0, finalUserType, qr_code, notes || '', initialStatus
  ];

  db.query(sql, params, (err, result) => {
    if (err) {
      if (err.code === 'ER_DUP_ENTRY' || err.errno === 1062) {
        return res.status(409).json({ error: "already_registered", message: "此資料已登記過" });
      }
      return res.status(500).json({ error: "登記失敗", detail: err.message });
    }

    const userId = result.insertId;

    // 如果開啟「註冊即簽到」
    if (autoCheckin) {
      db.query("INSERT INTO checkins (user_id, checkin_time, checkin_date) VALUES (?, NOW(), CURDATE())", [userId], (err) => {
        if (err) console.error("自動簽到失敗:", err);
        res.json({ success: true, message: "已完成登記與今日簽到", id: userId, name: fullName });
      });
    } else {
      res.json({ success: true, message: "已完成登記", id: userId, name: fullName });
    }
  });
});

// 5. 簽到路由 (手動點擊簽到)
// 5. 簽到路由 (優化版：支持新人自動轉訪客、防止重複計次但顯示歡迎)
app.post("/checkin/:id", (req, res) => {
  const userId = req.params.id;
  
  // 1. 先獲取用戶目前的身份，並檢查今天是否已經簽到過
  const checkSql = `
    SELECT 
      u.name, 
      u.user_type, 
      (SELECT COUNT(*) FROM checkins WHERE user_id = ? AND checkin_date = CURDATE()) as hasCheckedInToday
    FROM users u 
    WHERE u.id = ?
  `;
  
  db.query(checkSql, [userId, userId], (err, rows) => {
    if (err) return res.status(500).json({ success: false, error: "數據庫查詢失敗" });
    if (rows.length === 0) return res.status(404).json({ success: false, error: "找不到此用戶" });

    const { name, user_type, hasCheckedInToday } = rows[0];

    // --- 情況 A: 今天已經簽到過 (重複簽到) ---
    if (hasCheckedInToday > 0) {
      return res.json({ 
        success: true, 
        name, 
        user_type, 
        message: "歡迎回來！您今天已經簽到過囉 😊",
        already_done: true // 告知前端這是重複操作，不需特別處理
      });
    }

    // --- 情況 B: 今天第一次簽到 ---
    
    // 邏輯判定：如果是「新人 (newcomer)」，簽到後自動轉為「一般訪客 (visitor)」
    // 這樣第二次來（隔天或以後）他就會以 visitor 身份出現
    let targetType = user_type;
    if (user_type && user_type.toLowerCase().includes('newcomer')) {
      targetType = 'visitor';
    }

    // 更新用戶身份 (如果需要) 與 狀態
    const updateSql = "UPDATE users SET status = 'checked-in', user_type = ? WHERE id = ?";
    db.query(updateSql, [targetType, userId], (updateErr) => {
      if (updateErr) return res.status(500).json({ success: false, error: "更新身份失敗" });

      // 插入簽到紀錄
      db.query("INSERT INTO checkins (user_id, checkin_time, checkin_date) VALUES (?, NOW(), CURDATE())", [userId], (insertErr) => {
        if (insertErr) return res.status(500).json({ success: false, error: "簽到紀錄寫入失敗" });
        
        res.json({ 
          success: true, 
          name, 
          user_type: targetType, 
          message: targetType === 'visitor' && user_type !== 'visitor' 
            ? "簽到成功！歡迎您成為正式訪客 🌿" 
            : "簽到成功！" 
        });
      });
    });
  });
});
// 6. 管理端：獲取詳細用戶清單
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
    if (err) return res.status(500).json({ error: "讀取後台名單失敗" });
    res.json(rows);
  });
});

// 7. 管理端：導出 Excel
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
    if (err) return res.status(500).send("Excel 導出失敗");
    const worksheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "簽到名單");
    const excelBuffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(excelBuffer);
  });
});

// 8. 管理端：快速變更身份 (例如：轉為義工)
app.post("/admin/update-type/:id", (req, res) => {
  const userId = req.params.id;
  const { new_type } = req.body; 

  if (!new_type) return res.status(400).json({ error: "請提供新的身份類別" });

  const sql = "UPDATE users SET user_type = ? WHERE id = ?";
  db.query(sql, [new_type, userId], (err, result) => {
    if (err) return res.status(500).json({ error: "身份更新失敗" });
    res.json({ success: true, message: `已將身份更新為 ${new_type}` });
  });
});

// 9. 管理端：更新用戶備註 (確保欄位名為 notes)
app.post("/admin/update-note", (req, res) => {
  const { userId, notes } = req.body; // 從前端接收 userId 和 notes

  if (!userId) {
    return res.status(400).json({ error: "缺少用戶 ID" });
  }

  // 確保 SQL 語句中使用 notes = ?
  const sql = "UPDATE users SET notes = ? WHERE id = ?";
  
  db.query(sql, [notes || '', userId], (err, result) => {
    if (err) {
      console.error("更新備註失敗:", err);
      return res.status(500).json({ error: "資料庫更新失敗" });
    }
    
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "找不到該用戶" });
    }

    res.json({ success: true, message: "備註已成功存入" });
  });
});


// 10. 提交預約請求 (優化版：加入時段支持)
app.post("/book", (req, res) => {
  // 這裡多接收一個 bookingTime
  const { userId, itemId, bookingDate, bookingTime } = req.body;

  if (!userId || !itemId || !bookingDate) {
    return res.status(400).json({ 
      success: false, 
      error: "預約資料不完整" 
    });
  }

  // SQL 加入 booking_time 欄位 (請確保資料庫 bookings 表有此欄位)
  const sql = "INSERT INTO bookings (user_id, offering_id, booking_date, booking_time, status) VALUES (?, ?, ?, ?, 'pending')";
  
  // 如果前端沒傳 bookingTime (例如課程模式)，給予預設值 '全天'
  const finalTime = bookingTime || '全天';

  db.query(sql, [userId, itemId, bookingDate, finalTime], (err, result) => {
    if (err) {
      console.error("預約寫入失敗:", err);
      return res.status(500).json({ success: false, error: "資料庫寫入失敗" });
    }

    db.query("SELECT name FROM users WHERE id = ?", [userId], (err, rows) => {
      const userName = (rows && rows.length > 0) ? rows[0].name : "學員";
      res.json({ 
        success: true, 
        message: "預約已成功提交",
        bookingId: result.insertId 
      });
    });
  });
});


// 11. 管理端：獲取所有預約清單 (優化版：顯示項目名稱與預約時間)
app.get("/admin/bookings", (req, res) => {
  const sql = `
    SELECT 
      b.id, b.booking_date, b.booking_time, b.status, b.created_at,
      u.name as user_name, u.phone,
      o.title as offering_title
    FROM bookings b
    JOIN users u ON b.user_id = u.id
    LEFT JOIN offerings o ON b.offering_id = o.id
    ORDER BY b.created_at DESC
  `;
  
  db.query(sql, (err, rows) => {
    if (err) return res.status(500).json({ error: "讀取預約清單失敗" });
    res.json(rows);
  });
});
// --- 1. 獲取所有項目配置 (Admin & User 通用) ---
app.get('/api/offerings', (req, res) => {
  const sql = "SELECT * FROM offerings";
  db.query(sql, (err, rows) => {
    if (err) {
      console.error("讀取 offerings 失敗:", err);
      return res.status(500).json({ error: "資料庫讀取失敗" });
    }
    
    // 將資料庫存儲的 JSON 字串解析回物件，方便前端直接使用
    const data = rows.map(row => ({
      ...row,
      config: typeof row.config === 'string' ? JSON.parse(row.config || '{}') : row.config
    }));
    res.json(data);
  });
});

// --- 2. 更新特定項目的配置 (AdminPage 專用) ---
app.post('/api/offerings/:id/config', (req, res) => {
  const { id } = req.params;
  const { config } = req.body; // 前端傳來的 config 物件

  if (!config) {
    return res.status(400).json({ error: "缺少配置資料" });
  }

  // 將物件轉為字串存入資料庫的 TEXT 或 JSON 欄位
  const sql = "UPDATE offerings SET config = ? WHERE id = ?";
  db.query(sql, [JSON.stringify(config), id], (err, result) => {
    if (err) {
      console.error("更新 offerings 失敗:", err);
      return res.status(500).json({ error: "資料庫更新失敗" });
    }
    res.json({ success: true, message: "配置更新成功" });
  });
});

//11. 修正後的查詢個人預約路由
// 後端 index.js
app.get('/api/bookings', (req, res) => {
  const userId = req.query.userId;
  // 這裡要確保與你 book 路由寫入時的欄位名稱一致
  const sql = `
    SELECT b.*, o.title, o.type, o.icon 
    FROM bookings b 
    JOIN offerings o ON b.offering_id = o.id 
    WHERE b.user_id = ? 
    ORDER BY b.booking_date DESC`;

  db.query(sql, [userId], (err, results) => {
    if (err) {
      console.error("SQL 錯誤:", err);
      return res.status(500).json({ error: err.message });
    }
    res.json(results); // 確保這裡回傳的是陣列
  });
});
// 12. 取消預約路由
app.post('/api/bookings/:id/cancel', (req, res) => {
  const bookingId = req.params.id;
  // 將狀態改為 cancelled (或你定義的取消狀態碼)
  const sql = "UPDATE bookings SET status = 'cancelled' WHERE id = ?";
  
  db.query(sql, [bookingId], (err, result) => {
    if (err) {
      console.error("取消預約失敗:", err);
      return res.status(500).json({ success: false, error: "資料庫更新失敗" });
    }
    res.json({ success: true, message: "預約已取消" });
  });
});

// --- 啟動伺服器 ---
const PORT = process.env.PORT || 5000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ 伺服器已啟動，監聽連接埠: ${PORT}`);
});

// 接收結束訊號時關閉資料庫連線
process.on('SIGTERM', () => {
  db.end(() => {
    console.log('資料庫連線池已安全關閉');
    process.exit(0);
  });
});