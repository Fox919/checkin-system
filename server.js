import express from 'express';
import mysql from 'mysql2';
import dotenv from 'dotenv';
import * as XLSX from 'xlsx'; // 這樣可以確保所有工具函數都能正確讀取
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

  // 1. 先查出用戶資料（確保無論是否重複，都能回傳正確的名字）
  const findUserSql = "SELECT name, user_type FROM users WHERE id = ?";
  db.query(findUserSql, [userId], (err, rows) => {
    if (err) return res.status(500).json({ error: "數據庫查詢失敗" });
    if (rows.length === 0) return res.status(404).json({ error: "找不到此用戶" });

    const { name, user_type } = rows[0];

    // 2. 檢查 5 秒內是否重複簽到
    const checkDuplicateSql = `
      SELECT id FROM checkins 
      WHERE user_id = ? AND checkin_time > NOW() - INTERVAL 5 SECOND
    `;

    db.query(checkDuplicateSql, [userId], (err, recentRows) => {
      if (err) return res.status(500).json({ error: "查重失敗" });
      
      if (recentRows.length > 0) {
        console.log(`⚠️ 重複掃描已跳過: ${name}`);
        // 重點：重複時也要回傳 name，前端才不會顯示 undefined
        return res.json({ 
          success: true, 
          name: name, 
          user_type: user_type, 
          message: "請勿重複掃描" 
        });
      }

      // 3. 正常簽到邏輯：更新狀態並寫入紀錄
      const updateUserSql = "UPDATE users SET status = 'checked-in' WHERE id = ?";
      db.query(updateUserSql, [userId], (updateErr) => {
        if (updateErr) return res.status(500).json({ error: "更新狀態失敗" });

        const insertCheckinSql = "INSERT INTO checkins (user_id, checkin_time, checkin_date) VALUES (?, NOW(), CURDATE())";
        db.query(insertCheckinSql, [userId], (insertErr) => {
          if (insertErr) {
            console.error("❌ 寫入 checkins 失敗:", insertErr);
          }
          
          // 正常簽到回傳
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

// 1. 獲取所有簽到名單 (JSON 格式，給網頁表格用)
app.get("/admin/checkins", (req, res) => {
  const sql = `
    SELECT 
      c.id, 
      u.name, 
      u.phone, 
      u.user_type, 
      c.checkin_time 
    FROM checkins c
    JOIN users u ON c.user_id = u.id
    ORDER BY c.checkin_time DESC
  `;

  db.query(sql, (err, rows) => {
    if (err) return res.status(500).json({ error: "資料讀取失敗" });
    res.json(rows);
  });
});

// 2. 導出 Excel API
app.get("/admin/export-excel", (req, res) => {
  const sql = `
    SELECT 
      u.name AS '姓名', 
      u.phone AS '電話', 
      u.user_type AS '身份', 
      c.checkin_time AS '簽到時間' 
    FROM checkins c
    JOIN users u ON c.user_id = u.id
    ORDER BY c.checkin_time DESC
  `;

  db.query(sql, (err, rows) => {
    if (err) return res.status(500).send("導出失敗");

    // 創建工作表
    const worksheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "簽到名單");

    // 生成 Buffer
    const excelBuffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer' });

    // 設定下載標頭
    res.setHeader('Content-Disposition', 'attachment; filename=checkin_list.xlsx');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(excelBuffer);
  });
});

JavaScript
import React, { useEffect, useState } from 'react';

const AdminList = () => {
  const [list, setList] = useState([]);

  // 獲取名單
  const fetchList = async () => {
    try {
      const res = await fetch('https://checkin-system-production-2a74.up.railway.app/admin/checkins');
      const data = await res.json();
      setList(data);
    } catch (err) {
      console.error("讀取失敗", err);
    }
  };

  useEffect(() => {
    fetchList();
  }, []);

  const handleExport = () => {
    // 直接導向下載連結
    window.location.href = 'https://checkin-system-production-2a74.up.railway.app/admin/export-excel';
  };

  return (
    <div style={{ padding: '20px' }}>
      <h2>管理後台 - 簽到名單</h2>
      <button onClick={handleExport} style={{ marginBottom: '20px', padding: '10px', background: '#007bff', color: 'white', border: 'none', borderRadius: '5px' }}>
        導出 Excel 表格
      </button>

      <table border="1" cellPadding="10" style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ background: '#eee' }}>
            <th>姓名</th>
            <th>電話</th>
            <th>身份</th>
            <th>簽到時間</th>
          </tr>
        </thead>
        <tbody>
          {list.map((item) => (
            <tr key={item.id}>
              <td>{item.name}</td>
              <td>{item.phone}</td>
              <td>{item.user_type}</td>
              <td>{new Date(item.checkin_time).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

export default AdminList;

app.get("/", (req, res) => {
  res.json({ message: "後端 API 正常運作中！", database: "已連線" });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`伺服器正運行在 Port: ${PORT}`);
});