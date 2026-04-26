require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const QRCode = require('qrcode');
const CryptoJS = require('crypto-js');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(bodyParser.json());
app.use(express.static('public'));

// --- قاعدة بيانات بسيطة (ملف JSON) ---
const DB_PATH = path.join(__dirname, 'database.json');
function readDB() {
  if (!fs.existsSync(DB_PATH)) return { registrations: [] };
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}
function writeDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

// --- تشفير رقم البطاقة ---
function encrypt(text) {
  return CryptoJS.AES.encrypt(text, process.env.ENCRYPTION_KEY).toString();
}
function decrypt(ciphertext) {
  const bytes = CryptoJS.AES.decrypt(ciphertext, process.env.ENCRYPTION_KEY);
  return bytes.toString(CryptoJS.enc.Utf8);
}

// --- توليد كود QR صورة ---
async function generateQRBuffer(text) {
  return await QRCode.toBuffer(text, { width: 300, margin: 2 });
}

// --- نقطة النهاية: تسجيل المريض ومحاكاة الدفع ---
app.post('/api/register', async (req, res) => {
  try {
    const { nom, prenom, cin, telephone } = req.body;
    if (!nom || !prenom || !cin || !telephone) {
      return res.status(400).json({ error: 'جميع الحقول مطلوبة' });
    }

    const db = readDB();
    const id = Date.now().toString(36) + Math.random().toString(36).substr(2, 5); // معرف فريد
    const encryptedCIN = encrypt(cin);

    const newReg = {
      id,
      nom,
      prenom,
      cin: encryptedCIN,      // مشفر
      telephone,
      paye: true,            // محاكاة دفع ناجح
      dateCreation: new Date().toISOString(),
      rendezVous: null,      // سيحدد لاحقاً
      smsEnvoye: false
    };

    db.registrations.push(newReg);
    writeDB(db);

    // محتوى QR (معلومات يمكن قراءتها لاحقاً)
    const qrData = JSON.stringify({ id, nom, prenom, telephone, date: newReg.dateCreation });
    const qrBuffer = await generateQRBuffer(qrData);

    // نرسل الصورة Base64
    const base64QR = qrBuffer.toString('base64');
    res.json({
      success: true,
      message: 'تم التسجيل والخلاص بنجاح',
      qrCode: `data:image/png;base64,${base64QR}`,
      id
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'حدث خطأ ما' });
  }
});

// --- لوحة الإدارة: جلب كل التسجيلات (محمية بكلمة سر) ---
app.get('/api/admin/registrations', (req, res) => {
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${process.env.ADMIN_PASSWORD}`) {
    return res.status(401).json({ error: 'غير مصرح' });
  }
  const db = readDB();
  // نرسل البيانات مع فك تشفير CIN للأدمن فقط
  const safeData = db.registrations.map(r => ({
    ...r,
    cin: decrypt(r.cin)   // نفك التشفير هنا للأدمن الموثوق
  }));
  res.json(safeData);
});

// --- لوحة الإدارة: تحديد موعد ---
app.post('/api/admin/schedule', (req, res) => {
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${process.env.ADMIN_PASSWORD}`) {
    return res.status(401).json({ error: 'غير مصرح' });
  }
  const { id, dateRdv } = req.body; // dateRdv: "2025-05-15 10:00"
  const db = readDB();
  const reg = db.registrations.find(r => r.id === id);
  if (!reg) return res.status(404).json({ error: 'تسجيل غير موجود' });

  reg.rendezVous = dateRdv;
  reg.smsEnvoye = false; // نعيد للإرسال
  writeDB(db);
  res.json({ success: true, message: 'تم تحديد الموعد' });
});

// --- لوحة الإدارة: محاكاة إرسال SMS (تظهر الرسالة فقط) ---
app.post('/api/admin/send-sms', (req, res) => {
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${process.env.ADMIN_PASSWORD}`) {
    return res.status(401).json({ error: 'غير مصرح' });
  }
  const { id } = req.body;
  const db = readDB();
  const reg = db.registrations.find(r => r.id === id);
  if (!reg) return res.status(404).json({ error: 'غير موجود' });
  if (!reg.rendezVous) return res.status(400).json({ error: 'الموعد غير محدد بعد' });

  // محاكاة إرسال
  const smsText = `السيد/ة ${reg.nom} ${reg.prenom}، تم تحديد موعدكم: ${reg.rendezVous}. المستشفى العمومي. شكراً لثقتكم.`;
  reg.smsEnvoye = true;
  writeDB(db);

  console.log('📱 SMS (محاكاة):', smsText);
  res.json({ success: true, sms: smsText });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ السيرفر يعمل على المنفذ ${PORT}`));
