require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const QRCode = require('qrcode');
const CryptoJS = require('crypto-js');
const { Pool } = require('pg');
const path = require('path');

const app = express();
app.use(bodyParser.json());
app.use(express.static('public'));

// --- إعداد اتصال PostgreSQL ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// --- دوال التشفير ---
function encrypt(text) {
  return CryptoJS.AES.encrypt(text, process.env.ENCRYPTION_KEY).toString();
}
function decrypt(ciphertext) {
  const bytes = CryptoJS.AES.decrypt(ciphertext, process.env.ENCRYPTION_KEY);
  return bytes.toString(CryptoJS.enc.Utf8);
}

// --- دوال قاعدة البيانات: إنشاء الجداول إذا لم تكن موجودة ---
async function initializeDatabase() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS registrations (
        id TEXT PRIMARY KEY,
        nom TEXT NOT NULL,
        prenom TEXT NOT NULL,
        cin_encrypted TEXT NOT NULL,
        telephone TEXT NOT NULL,
        email TEXT,
        hopital TEXT NOT NULL,
        departement TEXT NOT NULL,
        paye BOOLEAN DEFAULT true,
        date_creation TIMESTAMPTZ DEFAULT NOW(),
        rendez_vous TIMESTAMPTZ,
        sms_envoye BOOLEAN DEFAULT false,
        email_envoye BOOLEAN DEFAULT false
      );
    `);
    console.log('✅ قاعدة البيانات جاهزة');
  } finally {
    client.release();
  }
}

// --- إرسال بريد تأكيد (تم تعطيله مؤقتاً) ---
async function sendConfirmationEmail(patient) {
  // حالياً البريد معطل للتجربة، عند التفعيل نزيل التعليق
  console.log(`📧 [محاكاة] بريد تأكيد كان سيُرسل إلى ${patient.email} للمريض ${patient.nom} ${patient.prenom}`);
  return true; // نفترض النجاح
}

// --- نقطة النهاية: تسجيل المريض ---
app.post('/api/register', async (req, res) => {
  try {
    const { nom, prenom, cin, telephone, email, hopital, departement } = req.body;
    if (!nom || !prenom || !cin || !telephone || !email || !hopital || !departement) {
      return res.status(400).json({ error: 'جميع الحقول مطلوبة (بما في ذلك البريد الإلكتروني)' });
    }

    const id = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
    const encryptedCIN = encrypt(cin);

    const client = await pool.connect();
    try {
      await client.query(
        `INSERT INTO registrations (id, nom, prenom, cin_encrypted, telephone, email, hopital, departement)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, nom, prenom, encryptedCIN, telephone, email, hopital, departement]
      );
    } finally {
      client.release();
    }

    // محاكاة إرسال بريد تأكيد (لن يفشل أبداً)
    await sendConfirmationEmail({ id, nom, prenom, email, hopital, departement });

    const qrData = JSON.stringify({ id, nom, prenom, telephone, date: new Date().toISOString() });
    const qrBuffer = await QRCode.toBuffer(qrData, { width: 300 });
    const base64QR = qrBuffer.toString('base64');

    res.json({
      success: true,
      message: 'تم التسجيل والخلاص بنجاح (البريد معطل حالياً للتجربة)',
      qrCode: `data:image/png;base64,${base64QR}`,
      id
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'حدث خطأ ما' });
  }
});

// --- لوحة الإدارة: جلب القائمة (محمية) ---
app.get('/api/admin/registrations', async (req, res) => {
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${process.env.ADMIN_PASSWORD}`) {
    return res.status(401).json({ error: 'غير مصرح' });
  }

  try {
    const client = await pool.connect();
    const result = await client.query('SELECT * FROM registrations ORDER BY date_creation DESC');
    client.release();

    const registrations = result.rows.map(r => ({
      ...r,
      cin: decrypt(r.cin_encrypted)
    }));
    res.json(registrations);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'خطأ في جلب البيانات' });
  }
});

// --- تحديد موعد ---
app.post('/api/admin/schedule', async (req, res) => {
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${process.env.ADMIN_PASSWORD}`) {
    return res.status(401).json({ error: 'غير مصرح' });
  }
  const { id, dateRdv } = req.body;
  if (!id || !dateRdv) return res.status(400).json({ error: 'المعرف والتاريخ مطلوبان' });

  try {
    const client = await pool.connect();
    await client.query('UPDATE registrations SET rendez_vous = $1 WHERE id = $2', [dateRdv, id]);
    client.release();

    // محاكاة إعلام المريض (لن نرسل بريداً فعلياً)
    console.log(`📅 [محاكاة] تم تحديد موعد للمعرف ${id} في ${dateRdv}`);

    res.json({ success: true, message: 'تم تحديد الموعد بنجاح (الإشعار معطل مؤقتاً)' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'فشل في تحديد الموعد' });
  }
});

// --- محاكاة SMS ---
app.post('/api/admin/send-sms', async (req, res) => {
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${process.env.ADMIN_PASSWORD}`) {
    return res.status(401).json({ error: 'غير مصرح' });
  }
  const { id } = req.body;
  try {
    const patient = (await pool.query('SELECT telephone, nom, prenom, rendez_vous FROM registrations WHERE id = $1', [id])).rows[0];
    const smsText = `السيد/ة ${patient.nom} ${patient.prenom}، موعدكم: ${patient.rendez_vous}. المستشفى العمومي.`;
    console.log('📱 SMS (محاكاة):', smsText);
    res.json({ success: true, sms: smsText });
  } catch (err) {
    res.status(500).json({ error: 'خطأ' });
  }
});

// --- الصفحات الثابتة ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

const PORT = process.env.PORT || 3000;
initializeDatabase().then(() => {
  app.listen(PORT, () => console.log(`✅ السيرفر يعمل على المنفذ ${PORT}`));
});
