import express from 'express';
import mysql from 'mysql2/promise'; // 統一使用 promise
import dotenv from 'dotenv';
import * as XLSX from 'xlsx';
import cors from 'cors';

dotenv.config();

const app = express();

// --- Middleware 設定 ---
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

// --- 路由重構 (全部改用 async/await) ---

// 1. 根目錄
app.get('/', (req, res) => res.status(200).send('✅ Check-in System API is running!'));

// 2. Kiosk 用戶名單
app.get("/users", async (req, res) => {
  try {
    const [rows] = await db.query("SELECT id, name, phone, user_type FROM users ORDER BY id DESC");
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. 預檢重複
app.post("/check-duplicate", async (req, res) => {
  const { lastName, firstName, phone } = req.body;
  try {
    const [results] = await db.query("SELECT id FROM users WHERE last_name = ? AND first_name = ? AND phone = ?", [lastName, firstName, phone]);
    res.json({ isDuplicate: results.length > 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. 註冊 (優化外展活動邏輯)
app.post("/register", async (req, res) => {
  const { 
    lastName, firstName, gender, phone, email, 
    contact_method, lang, discovery_source, 
    is_blessed, // 新增：加持標記
    user_type, autoCheckin, notes 
  } = req.body;

  // 1. 組合姓名
  const fullName = `${lastName || ''}${firstName || ''}`.trim();
  
  // 2. 驗證姓名必填 (後端最後一道防線)
  if (!fullName) return res.status(400).json({ error: "姓名為必填項目" });

  // 3. 驗證聯繫方式二選一
  if (!phone && !email) return res.status(400).json({ error: "電話或 Email 必須提供其中一項" });

  const qr_code = `QR_${phone || 'no-phone'}_${Date.now()}`;
  const initialStatus = autoCheckin ? 'checked-in' : 'active';
  const contactMethodString = Array.isArray(contact_method) ? contact_method.join(',') : (contact_method || '');

  try {
    const sql = `
      INSERT INTO users (
        last_name, first_name, gender, name, phone, email, 
        contact_method, lang, discovery_source, is_blessed, 
        user_type, qr_code, notes, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

    const [result] = await db.query(sql, [
      lastName || '', 
      firstName || '', 
      gender || 'Other', 
      fullName, 
      phone || null, 
      email || null, 
      contactMethodString, 
      lang || 'zh', 
      discovery_source || 'Outreach', 
      is_blessed ? 1 : 0, // 存入 1 (已加持) 或 0
      user_type || 'Visitor', 
      qr_code, 
      notes || '', 
      initialStatus
    ]);
    
    const userId = result.insertId;
    if (autoCheckin) {
      await db.query("INSERT INTO checkins (user_id, checkin_time, checkin_date) VALUES (?, NOW(), CURDATE())", [userId]);
    }
    res.json({ success: true, id: userId, name: fullName });
  } catch (err) {
    console.error("Register Error:", err);
    res.status(500).json({ error: "註冊失敗，可能是手機號碼已存在或資料庫錯誤。" });
  }
});


// 5. 簽到
app.post("/checkin/:id", async (req, res) => {
  const userId = req.params.id;
  try {
    const [rows] = await db.query(
      "SELECT name, user_type, (SELECT COUNT(*) FROM checkins WHERE user_id = ? AND checkin_date = CURDATE()) as hasCheckedInToday FROM users WHERE id = ?", 
      [userId, userId]
    );
    
    if (rows.length === 0) return res.status(404).json({ error: "找不到用戶" });

    const { name, user_type, hasCheckedInToday } = rows[0];
    
    // 如果今天已經簽到過
    if (hasCheckedInToday > 0) {
      return res.json({ 
        success: true, 
        name, 
        already_done: true,
        message: "您今天已經簽到過囉 😊" 
      });
    }

    let targetType = user_type?.toLowerCase().includes('newcomer') ? 'visitor' : user_type;

    // --- 關鍵修正點：同時更新 users 表的 last_checkin_time ---
    await db.query(
      "UPDATE users SET status = 'checked-in', user_type = ?, last_checkin_time = NOW() WHERE id = ?", 
      [targetType, userId]
    );

    // 保持原本的簽到紀錄表寫入
    await db.query(
      "INSERT INTO checkins (user_id, checkin_time, checkin_date) VALUES (?, NOW(), CURDATE())", 
      [userId]
    );
    
    res.json({ success: true, name, user_type: targetType });
  } catch (err) {
    console.error("簽到錯誤:", err);
    res.status(500).json({ error: err.message });
  }
});
// 5.5
app.post("/admin/update-receptionist", async (req, res) => {
  const { userId, receptionistName } = req.body;
  try {
    await db.query("UPDATE users SET receptionist_name = ? WHERE id = ?", [receptionistName, userId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5.6 管理端：變更用戶身份 (例如訪客轉義工)
app.post("/admin/update-type/:id", async (req, res) => {
  const userId = req.params.id;
  const { new_type } = req.body;
  try {
    await db.query("UPDATE users SET user_type = ? WHERE id = ?", [new_type, userId]);
    res.json({ success: true, message: `已將身份更新為 ${new_type}` });
  } catch (err) {
    res.status(500).json({ error: "身份更新失敗: " + err.message });
  }
});

// 5.7管理端：更新用戶備註
app.post("/admin/update-note", async (req, res) => {
  const { userId, notes } = req.body; // 注意前端送的是 notes 還是 note，這裡統一用 notes
  try {
    await db.query("UPDATE users SET notes = ? WHERE id = ?", [notes, userId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "備註更新失敗" });
  }
});


// 6. 管理端：獲取項目 (合併後的唯一路徑)
app.get('/api/offerings', async (req, res) => {
  try {
    const [rows] = await db.query("SELECT * FROM offerings");
    const data = rows.map(row => ({
      ...row,
      config: typeof row.config === 'string' ? JSON.parse(row.config || '{}') : row.config
    }));
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7. 更新課程配置 (開班管理專用 - PUT)
app.put('/api/offerings/:id/config', async (req, res) => {
  const { id } = req.params;
  const { config } = req.body;
  try {
    await db.query("UPDATE offerings SET config = ? WHERE id = ?", [JSON.stringify(config), id]);
    res.json({ success: true, message: "✅ 期次更新成功" });
  } catch (err) {
    console.error("SQL 錯誤:", err);
    res.status(500).json({ success: false, message: "❌ 資料庫更新失敗: " + err.message });
  }
});

// 8. 預約提交
app.post("/book", async (req, res) => {
  const { userId, itemId, bookingDate, bookingTime } = req.body;
  try {
    const [result] = await db.query("INSERT INTO bookings (user_id, offering_id, booking_date, booking_time, status) VALUES (?, ?, ?, ?, 'pending')", [userId, itemId, bookingDate, bookingTime || '全天']);
    res.json({ success: true, bookingId: result.insertId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 9. 查詢個人預約
app.get('/api/bookings', async (req, res) => {
  try {
    const [results] = await db.query("SELECT b.*, o.title, o.type, o.icon FROM bookings b JOIN offerings o ON b.offering_id = o.id WHERE b.user_id = ? ORDER BY b.booking_date DESC", [req.query.userId]);
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 10. 管理端：詳細名單 (移除性別，整合登記時間與簽到時間)
app.get("/admin/users", async (req, res) => {
  try {
    const sql = `
      SELECT 
        u.id, 
        u.name, 
        u.phone, 
        u.email,
        u.user_type, 
        u.status, 
        u.discovery_source,
        u.is_blessed,
        u.created_at, -- 來自 users 表的登記時間
        MAX(c.checkin_time) as last_checkin_time -- 來自 checkins 表的最後簽到時間
      FROM users u 
      LEFT JOIN checkins c ON u.id = c.user_id 
      GROUP BY u.id 
      ORDER BY u.id DESC`;
      
    const [rows] = await db.query(sql);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// 11. Excel 導出
app.get("/admin/export-excel", async (req, res) => {
  try {
    const filterDate = req.query.date;
    let sql = `SELECT u.name AS '全名', u.phone AS '電話', u.user_type AS '身份', c.checkin_time AS '簽到時間' FROM checkins c JOIN users u ON c.user_id = u.id`;
    const [rows] = filterDate ? await db.query(sql + " WHERE DATE(c.checkin_time) = ?", [filterDate]) : await db.query(sql);
    
    const worksheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Sheet1");
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
  } catch (err) {
    res.status(500).send("Export failed");
  }
});

// --- 啟動 ---
const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => console.log(`✅ 伺服器已啟動: ${PORT}`));

process.on('SIGTERM', async () => {
  await db.end();
  process.exit(0);
});