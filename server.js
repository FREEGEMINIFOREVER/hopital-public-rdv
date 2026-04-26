require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const QRCode = require('qrcode');
const CryptoJS = require('crypto-js');
const { Pool } = require('pg');
const nodemailer = require('nodemailer');
const path = require('path');

const app = express();
app.use(bodyParser.json());
app.use(express.static('public'));

// --- إعداد اتصال PostgreSQL ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // مطلوب لـ Render
});

// --- إعداد البريد الإلكتروني باستخدام Nodemailer ---
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: false, // true لـ 465
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
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

// --- إرسال بريد إلكتروني تأكيد ---
async function sendConfirmationEmail(patient) {
  const mailOptions = {
    from: `"المستشفى العمومي" <${process.env.SMTP_USER}>`,
    to: patient.email,
    subject: 'تأكيد التسجيل والخلاص – المستشفى العمومي',
    html: `
      <div dir="rtl" style="font-family: Arial, sans-serif; background: #f0f8ff; padding: 20px; border-radius: 10px;">
        <h2 style="color: #1a73e8;">أهلاً ${patient.nom} ${patient.prenom}</h2>
        <p>تم تسجيلكم بنجاح في المستشفى العمومي – ${patient.hopital}، قسم ${patient.departement}.</p>
        <p>رقم التسجيل: <strong>${patient.id}</strong></p>
        <p>تم تأكيد الخلاص. سنرسل لكم الموعد لاحقاً.</p>
        <p style="color: gray;">يرجى الاحتفاظ بكود QR للاستخدام عند الحضور.</p>
      </div>
    `
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`📧 بريد تأكيد أُرسل إلى ${patient.email}`);
    return true;
  } catch (err) {
    console.error('❌ فشل إرسال البريد:', err.message);
    return false;
  }
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

    // حفظ في القاعدة
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

    // إرسال بريد تأكيد
    const emailSent = await sendConfirmationEmail({ id, nom, prenom, email, hopital, departement });

    // QR كما السابق
    const qrData = JSON.stringify({ id, nom, prenom, telephone, date: new Date().toISOString() });
    const qrBuffer = await QRCode.toBuffer(qrData, { width: 300 });
    const base64QR = qrBuffer.toString('base64');

    res.json({
      success: true,
      message: 'تم التسجيل والخلاص بنجاح' + (emailSent ? ' وتم إرسال بريد تأكيد' : ' (تعذر إرسال البريد)'),
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
      cin: decrypt(r.cin_encrypted) // إظهار البطاقة بشكل مقروء للأدمن
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

    // إرسال إشعار بريد بالموعد (إذا أردنا إعلام المريض)
    const patient = (await pool.query('SELECT email, nom, prenom FROM registrations WHERE id = $1', [id])).rows[0];
    if (patient && patient.email) {
      await transporter.sendMail({
        from: `"المستشفى العمومي" <${process.env.SMTP_USER}>`,
        to: patient.email,
        subject: 'تم تحديد موعدكم',
        html: `
          <div dir="rtl" style="font-family: Arial;">
            <h2>موعدك في ${dateRdv}</h2>
            <p>السيد/ة ${patient.nom} ${patient.prenom}، تم تحديد موعدكم. يرجى الحضور في التاريخ المحدد.</p>
          </div>`
      });
    }

    res.json({ success: true, message: 'تم تحديد الموعد وإرسال إشعار' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'فشل في تحديد الموعد' });
  }
});

// --- محاكاة SMS (اختياري، نبقيه) ---
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

// --- صفحة البداية والمشرف ثابتة ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

const PORT = process.env.PORT || 3000;
initializeDatabase().then(() => {
  app.listen(PORT, () => console.log(`✅ السيرفر يعمل على المنفذ ${PORT}`));
});
