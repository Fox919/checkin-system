import express from 'express';
import mysql from 'mysql2/promise'; 
import dotenv from 'dotenv';
import * as XLSX from 'xlsx';
import cors from 'cors';
import QRCode from 'qrcode'; 
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

// 1. 安全解析 JSON 避免崩潰
function safeParseJSON(jsonStr, fallback = {}) {
  if (!jsonStr) return fallback;
  if (typeof jsonStr === 'object') return jsonStr;
  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    console.error("❌ JSON 解析失敗，使用備用配置:", e.message);
    return fallback;
  }
}

// 2. 檢查目前時間是否在指定的「開始」與「結束」時間內
function isTimeBetween(nowTimeStr, startTimeStr, endTimeStr) {
  if (!startTimeStr || !endTimeStr) return false;
  return nowTimeStr >= startTimeStr && nowTimeStr <= endTimeStr;
}

// 3. 獲取當前洛杉磯精準時間物件
function getLAFormattedDateTime() {
  const d = new Date();
  const dateStr = d.toLocaleDateString('sv-SE', { timeZone: 'America/Los_Angeles' });
  const timeStr = d.toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour12: false });
  return {
    todayStr: dateStr,
    nowTime: timeStr,
    fullDateTimeStr: `${dateStr} ${timeStr}`
  };
}

// 4. 統一匹配課程簽到時段
function matchCourseSlot(nowTime, config) {
  if (isTimeBetween(nowTime, config.slot_1_start, config.slot_1_end)) return { slot: 'slot_1', label: '第一節簽到' };
  if (isTimeBetween(nowTime, config.slot_2_start, config.slot_2_end)) return { slot: 'slot_2', label: '第二節簽到' };
  if (isTimeBetween(nowTime, config.slot_3_start, config.slot_3_end)) return { slot: 'slot_3', label: '第三節簽退' };
  return { slot: null, label: '' };
}

// 5. 核心計算函數：自動刷新學員的出勤率
async function refreshAttendanceRate(userId, offeringId) {
  const [course] = await db.query("SELECT total_checkins_required FROM offerings WHERE id = ?", [offeringId]);
  const totalRequired = course[0]?.total_checkins_required || 24;

  const [attendance] = await db.query(
    "SELECT COUNT(*) as attended FROM attendance_records WHERE user_id = ? AND offering_id = ?",
    [userId, offeringId]
  );
  const attendedCount = attendance[0].attended;
  const attendanceRate = ((attendedCount / totalRequired) * 100).toFixed(2);

  await db.query(
    `INSERT INTO course_enrollments (user_id, offering_id, attendance_rate) 
     VALUES (?, ?, ?) 
     ON DUPLICATE KEY UPDATE attendance_rate = ?`,
    [userId, offeringId, attendanceRate, attendanceRate]
  );
}

// 暫時性路由：生成所有學員的姓名與 QR Code Base64 圖片資料
app.get("/admin/temporary-badges", async (req, res) => {
  try {
    const sql = `SELECT id, name, phone, qr_code FROM users WHERE user_type = 'Student' ORDER BY name ASC`;
    const [students] = await db.query(sql);

    const badgesData = await Promise.all(students.map(async (student) => {
      const qrContent = student.qr_code || `QR_${student.phone || student.id}`;
      
      try {
        const qrImageUrl = await QRCode.toDataURL(qrContent, {
          width: 250,  
          margin: 2,   
          errorCorrectionLevel: 'H' 
        });

        return {
          id: student.id,
          name: student.name,
          qrCodeImage: qrImageUrl 
        };
      } catch (qrErr) {
        console.error(`學員 ${student.name} 二維碼生成失敗:`, qrErr.message);
        return {
          id: student.id,
          name: student.name,
          qrCodeImage: null
        };
      }
    }));

    res.json(badgesData);
  } catch (err) {
    console.error("生成臨時學員證資料失敗:", err);
    res.status(500).json({ error: "伺服器錯誤，無法生成學員證資料" });
  }
});

// --- 📄 路由列表 ---

app.get('/', (req, res) => res.status(200).send('✅ Check-in System API is running!'));

app.get("/users", async (req, res) => {
  try {
    const [rows] = await db.query("SELECT id, name, phone, user_type FROM users ORDER BY id DESC");
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/check-duplicate", async (req, res) => {
  const { lastName, firstName, phone } = req.body;
  try {
    const [results] = await db.query("SELECT id FROM users WHERE last_name = ? AND first_name = ? AND phone = ?", [lastName, firstName, phone]);
    res.json({ isDuplicate: results.length > 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 🌟 補上管理控制台缺失的人員清單 API，防止 404 錯誤
// ==========================================
app.get("/admin/users", async (req, res) => {
  try {
    const [rows] = await db.query(
      "SELECT id, last_name, first_name, name, phone, email, gender, user_type, notes, status, qr_code FROM users ORDER BY id DESC"
    );
    res.json(rows);
  } catch (err) {
    console.error("❌ 控制台撈取人員清單失敗:", err);
    res.status(500).json({ error: "無法取得人員清單資料" });
  }
});

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

  const { todayStr, fullDateTimeStr } = getLAFormattedDateTime();

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
      await db.query("INSERT INTO checkins (user_id, checkin_time, checkin_date) VALUES (?, ?, ?)", [userId, fullDateTimeStr, todayStr]);
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

// ==========================================
// 🌟 班級選單 API：加強萬用相容版，防止控制台顯示空白
// ==========================================
app.get("/api/offerings", async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT *, title AS name FROM offerings ORDER BY id DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error("❌ 撈取 offerings 失敗:", err);
    res.status(500).json({ error: "無法取得課程列表資料" });
  }
});

// ==========================================
// 🧘‍♂️ 簽到路由分流 A：修復後的舊網址入口
// ==========================================
app.post("/checkin/:id", async (req, res) => {
  const userId = req.params.id;
  const offeringId = req.query?.offeringId || req.body?.offeringId || 1; 
  
  const { todayStr, nowTime, fullDateTimeStr } = getLAFormattedDateTime();

  const parsedUserId = parseInt(userId, 10);
  const parsedOfferingId = parseInt(offeringId, 10);

  if (isNaN(parsedUserId)) {
    return res.status(400).json({ success: false, message: "❌ 簽到失敗：無效的學員 ID" });
  }
  try {
    const [offerings] = await db.query('SELECT * FROM offerings WHERE id = ?', [parsedOfferingId]);
    if (!offerings || offerings.length === 0) {
      return res.status(444).json({ success: false, message: `❌ 找不到該課程期次 (ID: ${parsedOfferingId})` });
    }
    const currentOffering = offerings[0];

    const [users] = await db.query('SELECT name, user_type FROM users WHERE id = ?', [parsedUserId]);
    if (!users || users.length === 0) {
      return res.status(444).json({ success: false, message: "❌ 找不到此成員資料" });
    }
    const currentUser = users[0];
    const studentName = currentUser.name || "隨喜訪客";
    const userType = currentUser.user_type || "Visitor";

    if (currentOffering.type === 'service' || userType !== 'Student') {
      const [existing] = await db.query(
        'SELECT id FROM attendance_records WHERE user_id = ? AND offering_id = ? AND checkin_date = ?',
        [parsedUserId, parsedOfferingId, todayStr]
      );
      
      if (existing.length > 0) {
        return res.json({ success: false, message: `【${studentName}】今日已完成簽到，請勿重複掃描` });
      }
      
      await db.query(
        'INSERT INTO attendance_records (user_id, offering_id, checkin_date, day_number, slot_type, created_at) VALUES (?, ?, ?, 0, "regular", ?)',
        [parsedUserId, parsedOfferingId, todayStr, fullDateTimeStr]
      );
      
      const roleLabel = userType === 'Volunteer' ? '義工' : userType === 'Venerable' ? '法師' : '訪客';
      return res.json({ 
        success: true, 
        name: studentName, 
        message: `${roleLabel}簽到成功！歡迎來到現場。` 
      });
    }

    if (currentOffering.type === 'course' && userType === 'Student') {
      const config = safeParseJSON(currentOffering.config);
      const { slot: currentSlot, label: slotLabel } = matchCourseSlot(nowTime, config);

      if (!currentSlot) {
        return res.json({ 
          success: false, 
          message: `學員【${studentName}】目前非開放點名時間。當前時間：${nowTime.slice(0, 5)}` 
        });
      }

      const dayNumber = parseInt(todayStr.split('-')[2], 10) || 1;

      const [slotExisting] = await db.query(
        `SELECT id FROM attendance_records 
         WHERE user_id = ? AND offering_id = ? AND checkin_date = ? AND slot_type = ?`,
        [parsedUserId, parsedOfferingId, todayStr, currentSlot]
      );

      if (slotExisting.length > 0) {
        return res.json({ success: false, message: `學員【${studentName}】的【${slotLabel}】已完成點名，請勿重複掃描` });
      }

      await db.query(
        `INSERT INTO attendance_records 
         (user_id, offering_id, checkin_date, day_number, slot_type, created_at) 
         VALUES (?, ?, ?, ?, ?, ?)`,
        [parsedUserId, parsedOfferingId, todayStr, dayNumber, currentSlot, fullDateTimeStr]
      );

      await refreshAttendanceRate(parsedUserId, parsedOfferingId);

      return res.json({ 
        success: true, 
        name: studentName,
        message: `【${slotLabel}】點名成功！` 
      });
    }

  } catch (error) {
    console.error("後端舊路由簽到出錯:", error);
    return res.status(500).json({ success: false, message: `伺服器資料庫發生異常: ${error.message}` });
  }
});

// ==========================================
// 🧘‍♂️ 簽到路由分流 B：安全強化新網址入口（萬無一失防禦版）
// ==========================================
app.post("/api/course-checkin", async (req, res) => {
  let bodyData = req.body;
  if (typeof bodyData === 'string') {
    try { bodyData = JSON.parse(bodyData); } catch(e){}
  }

  const incomingUserId = bodyData?.userId || bodyData?.user_id || bodyData?.userid;
  const incomingOfferingId = bodyData?.offeringId || bodyData?.offering_id || bodyData?.offeringid || 1;

  // 🌟 修正點 1：將遺漏的洛杉磯時間物件獲取補回來，確保變數可用
  const { todayStr, nowTime, fullDateTimeStr } = getLAFormattedDateTime();

  const parsedUserId = parseInt(String(incomingUserId).replace(/\D/g, ""), 10);
  const parsedOfferingId = parseInt(String(incomingOfferingId).replace(/\D/g, ""), 10);

  console.log(`👉 收到簽到請求 - 解析後的學員ID: ${parsedUserId}, 班級ID: ${parsedOfferingId}`);

  if (!parsedUserId || isNaN(parsedUserId)) {
    return res.status(400).json({ success: false, message: "❌ 簽到失敗：無效的學員 ID 格式" });
  }
  if (!parsedOfferingId || isNaN(parsedOfferingId)) {
    return res.status(400).json({ success: false, message: "❌ 簽到失敗：無效的課程 ID 格式" });
  }

  try {
    const [courseRows] = await db.query(`SELECT config, type FROM offerings WHERE id = ?`, [parsedOfferingId]);
    
    if (!courseRows || courseRows.length === 0) {
      return res.status(444).json({ 
        success: false, 
        message: `❌ 簽到失敗：找不到課程期次 (收到 ID: ${parsedOfferingId})` 
      });
    }
    
    const c = courseRows[0];

    const [userRows] = await db.query('SELECT name, user_type FROM users WHERE id = ?', [parsedUserId]);
    if (!userRows || userRows.length === 0) {
      return res.status(444).json({ success: false, message: "❌ 簽到失敗：找不到此成員資料" });
    }
    const currentUser = userRows[0];
    const studentName = currentUser.name || "未知成員";
    const userType = currentUser.user_type || "Visitor";

    if (c.type === 'service' || userType !== 'Student') {
      const [existing] = await db.query(
        'SELECT id FROM attendance_records WHERE user_id = ? AND offering_id = ? AND checkin_date = ?',
        [parsedUserId, parsedOfferingId, todayStr]
      );
      
      if (existing.length > 0) {
        return res.json({ success: false, message: `【${studentName}】今日已完成簽到囉！` });
      }
      
      await db.query(
        'INSERT INTO attendance_records (user_id, offering_id, checkin_date, day_number, slot_type, created_at) VALUES (?, ?, ?, 0, "regular", ?)',
        [parsedUserId, parsedOfferingId, todayStr, fullDateTimeStr]
      );
      
      const roleLabel = userType === 'Volunteer' ? '義工' : userType === 'Venerable' ? '法師' : '訪客';
      return res.json({ 
        success: true, 
        message: `✅ 【${studentName}】${roleLabel}簽到成功！` 
      });
    }

    const config = safeParseJSON(c.config);
    const { slot: matchedSlot, label: slotLabel } = matchCourseSlot(nowTime, config);

    if (!matchedSlot) {
      return res.status(400).json({ 
        success: false, 
        message: `❌ 【${studentName}】目前非開放點名時間。當前時間：${nowTime.slice(0, 5)}` 
      });
    }

    const dayNumber = parseInt(todayStr.split('-')[2], 10) || 1;

    const [slotExisting] = await db.query(
      `SELECT id FROM attendance_records 
       WHERE user_id = ? AND offering_id = ? AND checkin_date = ? AND slot_type = ?`,
      [parsedUserId, parsedOfferingId, todayStr, matchedSlot]
    );

    if (slotExisting.length > 0) {
      return res.json({ success: false, message: `❌ 【${studentName}】的【${slotLabel}】已完成點名，請勿重複掃描` });
    }

    await db.query(
      `INSERT INTO attendance_records (user_id, offering_id, checkin_date, day_number, slot_type, created_at) 
       VALUES (?, ?, ?, ?, ?, ?) 
       ON DUPLICATE KEY UPDATE created_at = ?`, 
      [parsedUserId, parsedOfferingId, todayStr, dayNumber, matchedSlot, fullDateTimeStr, fullDateTimeStr]
    );
    
    await refreshAttendanceRate(parsedUserId, parsedOfferingId);
    res.json({ success: true, message: `✅ 【${studentName}】的【${slotLabel}】成功！` });

  } catch (err) {
    console.error("❌ 後端新簽到路由出錯:", err);
    res.status(500).json({ success: false, message: `伺服器資料庫發生異常: ${err.message}` });
  }
});

app.get("/admin/course-attendance/:offeringId", async (req, res) => {
  const { offeringId } = req.params;
  try {
    const sqlEnrollments = `SELECT u.id AS user_id, u.name, u.phone, u.user_type, u.status, ce.attendance_rate, ce.certificate_no FROM course_enrollments ce JOIN users u ON ce.user_id = u.id WHERE ce.offering_id = ? ORDER BY u.name ASC`;
    const [students] = await db.query(sqlEnrollments, [offeringId]);
    const [records] = await db.query("SELECT user_id, day_number, slot_type FROM attendance_records WHERE offering_id = ?", [offeringId]);
    const formattedData = students.map(student => {
      const studentRecords = records.filter(r => r.user_id === student.user_id);
      return { ...student, records: studentRecords };
    });
    res.json(formattedData);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/admin/toggle-attendance", async (req, res) => {
  const { userId, offeringId, dayNumber, slotType, status } = req.body;
  const { todayStr, fullDateTimeStr } = getLAFormattedDateTime();
  try {
    if (status === true) {
      await db.query(`INSERT INTO attendance_records (user_id, offering_id, checkin_date, day_number, slot_type, created_at) VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE created_at = ?`, [userId, offeringId, todayStr, dayNumber, slotType, fullDateTimeStr, fullDateTimeStr]);
    } else {
      await db.query("DELETE FROM attendance_records WHERE user_id = ? AND offering_id = ? AND day_number = ? AND slot_type = ?", [userId, offeringId, dayNumber, slotType]);
    }
    await refreshAttendanceRate(userId, offeringId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/admin/evaluate-graduation", async (req, res) => {
  const { userId, offeringId } = req.body;
  try {
    const [enrollment] = await db.query("SELECT attendance_rate, certificate_no FROM course_enrollments WHERE user_id = ? AND offering_id = ?", [userId, offeringId]);
    if (enrollment.length === 0) return res.status(444).json({ error: "找不到該選課紀錄" });
    const rate = parseFloat(enrollment[0].attendance_rate || 0);

    if (rate < 85.00) return res.status(400).json({ success: false, message: `未達畢業標準！目前出勤率為 ${rate}%` });
    if (enrollment[0].certificate_no) return res.json({ success: true, certificate_no: enrollment[0].certificate_no });

    const { todayStr } = getLAFormattedDateTime(); 
    const datePart = todayStr.slice(0, 7).replace('-', ''); 
    
    const uniquePart = Date.now().toString().slice(-4);
    const newCertificateNo = `BODHI-${datePart}-${uniquePart}`;

    await db.query("UPDATE course_enrollments SET status = 'graduated', certificate_no = ? WHERE user_id = ? AND offering_id = ?", [newCertificateNo, userId, offeringId]);
    res.json({ success: true, certificate_no: newCertificateNo });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => console.log(`✅ 伺服器已啟動: ${PORT}`));

process.on('SIGTERM', async () => {
  await db.end();
  process.exit(0);
});