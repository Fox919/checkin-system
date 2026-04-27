import express from 'express';
import mysql from 'mysql2';
import dotenv from 'dotenv';
import * as XLSX from 'xlsx'; 

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



app.post("/register", (req, res) => {
  const { name, phone, user_type, email, lang, autoCheckin, notes } = req.body; 

  const qr_code = `QR_${phone}_${Date.now()}`;
  const emailToSave = (email && email.trim() !== '') ? email : null;
  
  // --- 請在這裡新增這一行，定義 noteToSave ---
  const noteToSave = notes || ''; 

  const sql = `INSERT INTO users (name, phone, user_type, qr_code, email, lang, notes) VALUES (?, ?, ?, ?, ?, ?, ?)`;
  
  // 現在這裡就可以正確使用 noteToSave 了
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
// --- 簽到路由 (已加入防重複機制) ---
app.post("/checkin/:id", (req, res) => {
  const userId = req.params.id;

  const findUserSql = "SELECT name, user_type FROM users WHERE id = ?";
  db.query(findUserSql, [userId], (err, rows) => {
    if (err) return res.status(500).json({ error: "數據庫查詢失敗" });
    if (rows.length === 0) return res.status(404).json({ error: "找不到此用戶" });

    const { name, user_type } = rows[0];

    const checkDuplicateSql = `
      SELECT id FROM checkins 
      WHERE user_id = ? AND checkin_time > NOW() - INTERVAL 5 SECOND
    `;

    db.query(checkDuplicateSql, [userId], (err, recentRows) => {
      if (err) return res.status(500).json({ error: "查重失敗" });
      
      if (recentRows.length > 0) {
        return res.json({ 
          success: true, 
          name: name, 
          user_type: user_type, 
          message: "請勿重複掃描" 
        });
      }

      const updateUserSql = "UPDATE users SET status = 'checked-in' WHERE id = ?";
      db.query(updateUserSql, [userId], (updateErr) => {
        if (updateErr) return res.status(500).json({ error: "更新狀態失敗" });

        const insertCheckinSql = "INSERT INTO checkins (user_id, checkin_time, checkin_date) VALUES (?, NOW(), CURDATE())";
        db.query(insertCheckinSql, [userId], (insertErr) => {
          if (insertErr) console.error("❌ 寫入 checkins 失敗:", insertErr);
          
          res.json({ 
            success: true, 
            name: name, 
            user_type: user_type 
          });
        });
      });
    });
  });
});

// --- 新增：獲取所有註冊用戶 (供 Kiosk 使用) ---
app.get("/users", (req, res) => {
  const sql = "SELECT id, name, phone, user_type FROM users";
  db.query(sql, (err, rows) => {
    if (err) return res.status(500).json({ error: "讀取用戶清單失敗" });
    res.json(rows);
  });
});

// 1. 新增：獲取所有註冊用戶清單 (用於後台名單頁面)
app.get("/admin/users", (req, res) => {
  const sql = "SELECT id, name, phone, user_type, email, notes, status FROM users ORDER BY id DESC";
  db.query(sql, (err, rows) => {
    if (err) return res.status(500).json({ error: "無法獲取用戶資料" });
    res.json(rows);
  });
});

// 2. 新增：更新用戶備註
app.post("/admin/update-note", (req, res) => {
  const { userId, note } = req.body;
  const sql = "UPDATE users SET notes = ? WHERE id = ?";
  
  db.query(sql, [note, userId], (err, result) => {
    if (err) return res.status(500).json({ error: "更新備註失敗" });
    res.json({ success: true, message: "備註已更新" });
  });
});




// --- 管理 API：獲取名單 ---
app.get("/admin/checkins", (req, res) => {
  const sql = `
    SELECT c.id, u.name, u.phone, u.user_type, c.checkin_time 
    FROM checkins c
    JOIN users u ON c.user_id = u.id
    ORDER BY c.checkin_time DESC
  `;
  db.query(sql, (err, rows) => {
    if (err) return res.status(500).json({ error: "資料讀取失敗" });
    res.json(rows);
  });
});

// --- 管理 API：導出 Excel ---
app.get("/admin/export-excel", (req, res) => {
  const filterDate = req.query.date; // 接收前端傳來的日期參數
  
  let sql = `
    SELECT u.name AS '姓名', u.phone AS '電話', u.user_type AS '身份', c.checkin_time AS '簽到時間' 
    FROM checkins c
    JOIN users u ON c.user_id = u.id
  `;
  
  const params = [];
  
  // 如果有選擇日期，就加上 WHERE 條件
  if (filterDate) {
    sql += ` WHERE DATE(c.checkin_time) = ?`;
    params.push(filterDate);
  }
  
  sql += ` ORDER BY c.checkin_time DESC`;

  db.query(sql, params, (err, rows) => {
    if (err) {
      console.error("導出錯誤:", err);
      return res.status(500).send("導出失敗");
    }
    
    const worksheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "簽到名單");
    const excelBuffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer' });

    res.setHeader('Content-Disposition', `attachment; filename=checkin_list_${filterDate || 'all'}.xlsx`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(excelBuffer);
  });
});
// --- 基礎路由 ---
app.get("/", (req, res) => {
  res.json({ message: "後端 API 正常運作中！", database: "已連線" });
});

// --- 啟動伺服器 ---
const PORT = process.env.PORT || 5000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ 伺服器正運行在 Port: ${PORT}`);
});