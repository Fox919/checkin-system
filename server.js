import express from 'express';
import mysql from 'mysql2/promise'; 
import dotenv from 'dotenv';
import * as XLSX from 'xlsx';
import cors from 'cors';
import moment from 'moment'; // 🆕 ✨ 關鍵修正：補上缺失的 moment 模組引入！

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

// --- 🛠️ 核心輔助函數區 ---

// 1. 檢查目前時間是否在指定的「開始」與「結束」時間內
function isTimeBetween(nowTimeStr, startTimeStr, endTimeStr) {
  if (!startTimeStr || !endTimeStr) return false;
  return nowTimeStr >= startTimeStr && nowTimeStr <= endTimeStr;
}

// 2. 核心計算函數：自動刷新學員的出勤率
async function refreshAttendanceRate(userId, offeringId) {
  // 撈出該課程要求的總打卡次數（預設為 24 次）
  const [course] = await db.query("SELECT total_checkins_required FROM offerings WHERE id = ?", [offeringId]);
  const totalRequired = course[0]?.total_checkins_required || 24;

  // 計算該學員目前的實際累計打卡總次數
  const [attendance] = await db.query(
    "SELECT COUNT(*) as attended FROM attendance_records WHERE user_id = ? AND offering_id = ?",
    [userId, offeringId]
  );
  const attendedCount = attendance[0].attended;

  // 計算出勤百分比
  const attendanceRate = ((attendedCount / totalRequired) * 100).toFixed(2);

  // 更新或寫入選課狀態表 (course_enrollments)
  await db.query(
    `INSERT INTO course_enrollments (user_id, offering_id, attendance_rate) 
     VALUES (?, ?, ?) 
     ON DUPLICATE KEY UPDATE attendance_rate = ?`,
    [userId, offeringId, attendanceRate, attendanceRate]
  );
}


// --- 📄 路由重構列表 ---

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

// 4. 註冊
app.post("/register", async (req, res) => {
  const { 
    lastName, firstName, gender, phone, email, 
    contact_method, lang, discovery_source, 
    referrer_name,       
    other_source_text,   
    is_blessed, 
    user_type, autoCheckin, notes
  } = req.body;

  const fullName = `${lastName || ''}${firstName || ''}`.trim();
  if (!fullName) return res.status(400).json({ error: "姓名為必填項目" });
  if (!phone && !email) return res.status(400).json({ error: "電話或 Email 必須提供其中一項" });

  const qr_code = `QR_${phone || 'no-phone'}_${Date.now()}`;
  const initialStatus = autoCheckin ? 'checked-in' : 'active';
  const contactMethodString = Array.isArray(contact_method) ? contact_method.join(',') : (contact_method || '');

  try {
    const sql = `
      INSERT INTO users (
        last_name, first_name, gender, name, phone, email, 
        contact_method, lang, discovery_source, referrer_name, 
        is_blessed, user_type, qr_code, notes, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

    const finalNotes = other_source_text 
      ? `[補充來源: ${other_source_text}] ${notes || ''}`.trim() 
      : (notes || '');

    const [result] = await db.query(sql, [
      lastName || '', 
      firstName || '', 
      gender || 'Other', 
      fullName, 
      phone || null, 
      email || null, 
      contactMethodString, 
      lang || 'zh', 
      discovery_source || null, 
      referrer_name || null, 
      is_blessed ? 1 : 0, 
      user_type || 'Visitor', 
      qr_code, 
      finalNotes,           
      initialStatus
    ]);
    
    const userId = result.insertId;
    if (autoCheckin) {
      await db.query("INSERT INTO checkins (user_id, checkin_time, checkin_date) VALUES (?, NOW(), CURDATE())", [userId]);
    }
    res.json({ success: true, id: userId, name: fullName });
  } catch (err) {
    console.error("Register Error:", err);
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ error: "此成員（相同姓名與電話）已經登記過囉！" });
    }
    res.status(500).json({ error: "系統登錄失敗，請稍後再試或聯繫管理員。" });
  }
});

// 5. 簽到 (支援密集班多時段與一般服務分流) - ✨ 已整合修復
app.post("/checkin/:id", async (req, res) => {
  const userId = req.params.id;
  
  // 獲取前端管理員選擇的課程期次 ID (若前端沒傳，預設為 1)
  const offeringId = req.query.offeringId || 1; 
  
  const todayStr = moment().format('YYYY-MM-DD');
  const nowTime = moment().format('HH:mm:ss');

  try {
    // 撈取該課程/服務的詳細設定與型態
    const [offerings] = await db.query('SELECT * FROM offerings WHERE id = ?', [offeringId]);
    if (offerings.length === 0) {
      return res.status(404).json({ success: false, message: "找不到該課程或服務期次" });
    }
    const currentOffering = offerings[0];

    // -------------------------------------------------------------
    // 🌸 分流 A：一般服務 (如：一對一能量加持、諮詢問事) -> 保持「一天只能簽到一次」
    // -------------------------------------------------------------
    if (currentOffering.type === 'service') {
      const [existing] = await db.query(
        'SELECT id FROM attendance_records WHERE user_id = ? AND offering_id = ? AND DATE(created_at) = ?',
        [userId, offeringId, todayStr]
      );
      
      if (existing.length > 0) {
        return res.json({ success: false, message: "該學員今日此服務已簽到過囉！" });
      }
      
      // 寫入基本簽到紀錄
      await db.query(
        'INSERT INTO attendance_records (user_id, offering_id, checkin_date, created_at) VALUES (?, ?, ?, NOW())',
        [userId, offeringId, todayStr]
      );
      
      // 撈取名字回傳
      const [users] = await db.query('SELECT name FROM users WHERE id = ?', [userId]);
      return res.json({ success: true, name: users[0]?.name || "隨喜訪客", message: "服務簽到成功" });
    }

    // -------------------------------------------------------------
    // 🧘‍♂️ 分流 B：密集班課程 (如：健身班、減壓班) -> 啟動「時段智慧防重複邏輯」
    // -------------------------------------------------------------
    if (currentOffering.type === 'course') {
      let currentSlot = null;
      
      // ✨ 根據你後面第 12 條的邏輯，動態計算今天是開課的第幾天 (Day 1 ~ Day 8)
      const dayDiff = Math.floor((new Date(todayStr) - new Date(currentOffering.start_date)) / (1000 * 60 * 60 * 24)) + 1;
      const dayNumber = dayDiff > 0 ? dayDiff : 1; 

      // 🧠 智慧判斷：依據課程名稱或類型判定點名時段
      if (currentOffering.title.includes('減壓')) {
        // 🧘 減壓下午班 (只打卡 2 次)
        if (nowTime >= '13:00:00' && nowTime <= '16:30:00') currentSlot = 'slot_1'; // 下午簽到
        if (nowTime >= '16:31:00' && nowTime <= '20:00:00') currentSlot = 'slot_3'; // 傍晚簽退
      } else {
        // 🏋️ 健身班等全天課程 (要打卡 3 次)
        if (nowTime >= '07:00:00' && nowTime <= '11:45:00') currentSlot = 'slot_1'; // 上午簽到
        if (nowTime >= '11:46:00' && nowTime <= '16:00:00') currentSlot = 'slot_2'; // 下午簽到
        if (nowTime >= '16:01:00' && nowTime <= '20:30:00') currentSlot = 'slot_3'; // 下課簽退
      }

      // 如果當前時間不在任何允許的點名範圍內
      if (!currentSlot) {
        return res.json({ 
          success: false, 
          message: `當前時間 (${nowTime.slice(0, 5)}) 暫無開放的點名時段` 
        });
      }

      // 【核心防禦】精準檢查「今天 + 這個特定時段」有沒有點過名了
      const [slotExisting] = await db.query(
        `SELECT id FROM attendance_records 
         WHERE user_id = ? AND offering_id = ? AND DATE(created_at) = ? AND slot_type = ?`,
        [userId, offeringId, todayStr, currentSlot]
      );

      if (slotExisting.length > 0) {
        const slotName = currentSlot === 'slot_1' ? '首節簽到' : currentSlot === 'slot_2' ? '午後半段' : '下課簽退';
        return res.json({ success: false, message: `此學員的【${slotName}】已完成點名，請勿重複掃描` });
      }

      // 驗證通過，寫入考勤表
      await db.query(
        `INSERT INTO attendance_records 
         (user_id, offering_id, checkin_date, day_number, slot_type, created_at) 
         VALUES (?, ?, ?, ?, ?, NOW())`,
        [userId, offeringId, todayStr, dayNumber, currentSlot]
      );

      // ✨ 新增：點名完成後同步刷新該學員的總出勤率，讓大看板同步連動
      await refreshAttendanceRate(userId, offeringId);

      // 撈取學員真實姓名
      const [users] = await db.query('SELECT name FROM users WHERE id = ?', [userId]);
      const studentName = users[0] ? users[0].name : "未知學員";

      return res.json({ 
        success: true, 
        name: studentName,
        message: "點名成功" 
      });
    }

  } catch (error) {
    console.error("後端簽到出錯:", error);
    return res.status(500).json({ success: false, message: "伺服器資料庫發生異常" });
  }
});


// 5.5 更新接待人
app.post("/admin/update-receptionist", async (req, res) => {
  const { userId, receptionistName } = req.body;
  try {
    await db.query("UPDATE users SET receptionist_name = ? WHERE id = ?", [receptionistName, userId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5.6 管理端：變更用戶身份
app.post("/admin/update-type/:id", async (req, res) => {
  const userId = req.params.id;
  const { new_type, offeringId } = req.body;
  
  try {
    await db.query("UPDATE users SET user_type = ? WHERE id = ?", [new_type, userId]);
    
    if (offeringId) {
      await db.query(
        `INSERT INTO course_enrollments (user_id, offering_id, attendance_rate, status) 
         VALUES (?, ?, 0.00, 'active') 
         ON DUPLICATE KEY UPDATE status = 'active'`,
        [userId, offeringId]
      );
    }
    
    res.json({ success: true, message: `身份更新成功，並已成功同步至該課程！` });
  } catch (err) {
    console.error("更新身份與選課失敗:", err);
    res.status(500).json({ error: "操作失敗: " + err.message });
  }
});

// 5.7 管理端：更新用戶備註
app.post("/admin/update-note", async (req, res) => {
  const { userId, notes } = req.body;
  try {
    await db.query("UPDATE users SET notes = ? WHERE id = ?", [notes, userId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "備註更新失敗" });
  }
});

// 6. 管理端：獲取項目列表
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

// 7. 更新課程配置
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

// 10. 管理端：詳細名單
app.get("/admin/users", async (req, res) => {
  try {
    const sql = `
      SELECT 
        u.id, 
        u.name, 
        u.phone, 
        u.email,
        u.user_type, 
        u.lang,                  
        u.referrer_name,          
        u.status, 
        u.discovery_source,
        u.is_blessed,
        u.created_at, 
        MAX(c.checkin_time) as last_checkin_time 
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
    let sql = `SELECT u.name AS '全名', u.phone AS '電話', u.user_type AS '身份', u.lang AS '語言', 
        u.referrer_name AS '介紹人',c.checkin_time AS '簽到時間' FROM checkins c JOIN users u ON c.user_id = u.id`;
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

// 12. 前台：學員手機/Kiosk 智慧時段掃碼打卡
app.post("/api/course-checkin", async (req, res) => {
  const { userId, offeringId } = req.body;
  const nowTimeStr = new Date().toTimeString().split(' ')[0]; // "HH:MM:SS"
  const today = new Date().toISOString().slice(0, 10);        // "YYYY-MM-DD"

  try {
    const [courseRows] = await db.query(
      `SELECT start_date, slot_1_start, slot_1_end, slot_2_start, slot_2_end, slot_3_start, slot_3_end 
       FROM offerings WHERE id = ?`, 
      [offeringId]
    );
    
    if (courseRows.length === 0) return res.status(444).json({ success: false, message: "找不到該課程期次" });
    
    const c = courseRows[0];
    let matchedSlot = null;
    let slotLabel = "";

    if (isTimeBetween(nowTimeStr, c.slot_1_start, c.slot_1_end)) {
      matchedSlot = 'slot_1'; slotLabel = '第一節簽到';
    } else if (isTimeBetween(nowTimeStr, c.slot_2_start, c.slot_2_end)) {
      matchedSlot = 'slot_2'; slotLabel = '第二節簽到';
    } else if (isTimeBetween(nowTimeStr, c.slot_3_start, c.slot_3_end)) {
      matchedSlot = 'slot_3'; slotLabel = '第三節簽退';
    }

    if (!matchedSlot) {
      return res.status(400).json({ success: false, message: "❌ 目前非本課程規定的打卡時間！" });
    }

    const dayDiff = Math.floor((new Date(today) - new Date(c.start_date)) / (1000 * 60 * 60 * 24)) + 1;
    const dayNumber = dayDiff > 0 ? dayDiff : 1; 

    await db.query(
      `INSERT INTO attendance_records (user_id, offering_id, checkin_date, day_number, slot_type) 
       VALUES (?, ?, ?, ?, ?) 
       ON DUPLICATE KEY UPDATE created_at = NOW()`,
      [userId, offeringId, today, dayNumber, matchedSlot]
    );

    await refreshAttendanceRate(userId, offeringId);
    res.json({ success: true, message: `✅ [${slotLabel}] 成功！` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: "系統錯誤" });
  }
});

// 13. 管理端：獲取特定課程所有學員及 8天網格打卡清單
app.get("/admin/course-attendance/:offeringId", async (req, res) => {
  const { offeringId } = req.params;
  try {
    const sqlEnrollments = `
      SELECT u.id AS user_id, u.name, ce.attendance_rate, ce.certificate_no
      FROM course_enrollments ce
      JOIN users u ON ce.user_id = u.id
      WHERE ce.offering_id = ? ORDER BY u.name ASC`;
    const [students] = await db.query(sqlEnrollments, [offeringId]);

    const [records] = await db.query(
      "SELECT user_id, day_number, slot_type FROM attendance_records WHERE offering_id = ?",
      [offeringId]
    );

    const formattedData = students.map(student => {
      const studentRecords = records.filter(r => r.user_id === student.user_id);
      return { ...student, records: studentRecords };
    });

    res.json(formattedData);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 14. 管理端：手動人工補簽 / 取消簽到切換
app.post("/admin/toggle-attendance", async (req, res) => {
  const { userId, offeringId, dayNumber, slotType, status } = req.body;
  const today = new Date().toISOString().slice(0, 10);

  try {
    if (status === true) {
      await db.query(
        `INSERT INTO attendance_records (user_id, offering_id, checkin_date, day_number, slot_type) 
         VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE created_at = NOW()`,
        [userId, offeringId, today, dayNumber, slotType]
      );
    } else {
      await db.query(
        "DELETE FROM attendance_records WHERE user_id = ? AND offering_id = ? AND day_number = ? AND slot_type = ?",
        [userId, offeringId, dayNumber, slotType]
      );
    }

    await refreshAttendanceRate(userId, offeringId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 15. 管理端：審核畢業資格並生成證書號
app.post("/admin/evaluate-graduation", async (req, res) => {
  const { userId, offeringId } = req.body;
  try {
    const [enrollment] = await db.query(
      "SELECT attendance_rate, certificate_no FROM course_enrollments WHERE user_id = ? AND offering_id = ?",
      [userId, offeringId]
    );

    if (enrollment.length === 0) return res.status(404).json({ error: "找不到該選課紀錄" });
    const rate = parseFloat(enrollment[0].attendance_rate || 0);

    if (rate < 85.00) {
      return res.status(400).json({ success: false, message: `未達畢業標準！目前出勤率為 ${rate}%（標準：85%）` });
    }

    if (enrollment[0].certificate_no) {
      return res.json({ success: true, certificate_no: enrollment[0].certificate_no });
    }

    const datePart = new Date().toISOString().slice(0, 7).replace('-', ''); 
    const randomPart = Math.floor(1000 + Math.random() * 9000); 
    const newCertificateNo = `BODHI-${datePart}-${randomPart}`;

    await db.query(
      "UPDATE course_enrollments SET status = 'graduated', certificate_no = ? WHERE user_id = ? AND offering_id = ?",
      [newCertificateNo, userId, offeringId]
    );

    res.json({ success: true, certificate_no: newCertificateNo });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- 啟動 ---
const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => console.log(`✅ 伺服器已啟動: ${PORT}`));

process.on('SIGTERM', async () => {
  await db.end();
  process.exit(0);
});