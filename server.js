app.post("/register", (req, res) => {
  const { name, phone, user_type } = req.body;
  
  if (!name || !phone) {
    return res.status(400).json({ error: "姓名與電話為必填" });
  }

  // 生成唯一碼（這裡建議加上時間戳避免重複）
  const qr_code = `QR_${phone}_${Date.now()}`;

  // SQL 語句：status 會自動使用資料庫設定的 'active'
  const sql = "INSERT INTO users (name, phone, user_type, qr_code) VALUES (?, ?, ?, ?)";
  
  db.query(sql, [name, phone, user_type, qr_code], (err, result) => {
    if (err) {
      console.error("Database Error:", err);
      // 如果電話設定了 UNIQUE 索引，這裡會報錯
      return res.status(500).json({ error: "登記失敗，該電話可能已註冊過" });
    }
    
    res.json({ 
      success: true, 
      qr_code: qr_code,
      message: "登記成功" 
    });
  });
});