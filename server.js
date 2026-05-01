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
app.post("/register", (req, res) => {
  const { name, phone, user_type, email, lang, autoCheckin, notes } = req.body; 
  const qr_code = `QR_${phone}_${Date.now()}`;
  const emailToSave = (email && email.trim() !== '') ? email : null;
  const noteToSave = notes || ''; 
  
  // 決定預設狀態
  const initialStatus = autoCheckin ? 'checked-in' : 'active';

  const sql = `INSERT INTO users (name, phone, user_type, qr_code, email, lang, notes, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
  
  db.query(sql, [name, phone, user_type, qr_code, emailToSave, lang, noteToSave, initialStatus], (err, result) => {
    if (err) {
      // --- 核心修正：判斷重複登記 ---
      if (err.code === 'ER_DUP_ENTRY' || err.errno === 1062) {
        console.log(`[重複攔截] 姓名: ${name}, 電話: ${phone}`);
        // 回傳 409 Conflict 狀態碼與特定錯誤字串
        return res.status(409).json({ 
          error: "already_registered", 
          message: "此姓名與電話組合已登記過" 
        });
      }

      console.error("註冊 SQL 錯誤:", err); 
      return res.status(500).json({ error: "登記失敗" });
    }
    
    const userId = result.insertId;
    
    // 如果是 autoCheckin，才需要額外插入簽到記錄
    if (autoCheckin) {
      db.query("INSERT INTO checkins (user_id, checkin_time, checkin_date) VALUES (?, NOW(), CURDATE())", [userId], (err) => {
        if (err) {
            console.error("自動簽到 SQL 錯誤:", err);
            // 即使簽到失敗，登記其實已經成功了
            return res.json({ success: true, message: "登記成功但自動簽到失敗", id: userId });
        }
        res.json({ success: true, message: "已完成登記與簽到", id: userId });
      });
    } else {
      res.json({ success: true, message: "已完成登記", id: userId });
    }
  });
});


// 簽到
// 簽到
// 簽到路由修正版
app.post("/checkin/:id", (req, res) => {
  const userId = req.params.id; // 從網址取得 ID

  // 1. 檢查用戶是否存在
  db.query("SELECT id, name FROM users WHERE id = ?", [userId], (err, users) => {
    if (err) return res.status(500).json({ success: false, error: "資料庫查詢失敗" });
    if (users.length === 0) return res.status(404).json({ success: false, error: "找不到此用戶" });

    const user_id = users[0].id;
    const name = users[0].name;
    const today = new Date().toISOString().slice(0, 10);

    // 2. 檢查今天是否已簽到 (使用簽到日期判斷)
    db.query(
      "SELECT * FROM checkins WHERE user_id = ? AND checkin_date = ?",
      [user_id, today],
      (err, rows) => {
        if (err) return res.status(500).json({ success: false, error: "檢查簽到紀錄失敗" });
        
        if (rows.length > 0) {
          // 已經簽過名了，統一回傳結構
          return res.status(200).json({ success: false, message: "今天已經簽到過了，請勿重複簽到！" });
        }

        // 3. 寫入簽到紀錄
        db.query(
          "INSERT INTO checkins (user_id, checkin_time, checkin_date) VALUES (?, NOW(), ?)",
          [user_id, today],
          (err) => {
            if (err) return res.status(500).json({ success: false, error: "寫入簽到紀錄失敗" });

            res.json({ success: true, message: "簽到成功", name: name });
          }
        );
      }
    );
  });
});// --- 新增：電話後四碼搜尋路由 ---
app.get("/search-by-phone/:lastFour", (req, res) => {
  const lastFour = req.params.lastFour;

  // 驗證輸入是否為 4 位數字
  if (!/^\d{4}$/.test(lastFour)) {
    return res.status(400).json({ error: "請輸入正確的 4 位電話號碼" });
  }

  // SQL: 尋找電話結尾匹配這 4 碼的人
  const sql = "SELECT id, name, user_type FROM users WHERE phone LIKE ?";
  
  db.query(sql, [`%${lastFour}`], (err, rows) => {
    if (err) {
      console.error("搜尋 SQL 錯誤:", err);
      return res.status(500).json({ error: "伺服器搜尋失敗" });
    }

    if (rows.length === 0) {
      return res.status(404).json({ error: "找不到匹配的登記資料" });
    }

    // 如果匹配到多筆資料（後四碼剛好重複）
    if (rows.length > 1) {
      return res.status(400).json({ 
        error: `找到 ${rows.length} 筆重複資料，請輸入完整電話進行登記。` 
      });
    }

    // 成功找到唯一匹配：回傳資料
    res.json({ 
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