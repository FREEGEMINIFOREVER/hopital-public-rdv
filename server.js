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

// --- تهيئة الجداول (تعمل مرة واحدة) ---
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
        email_envoye BOOLEAN DEFAULT false,
        status VARCHAR(20) DEFAULT 'new'
      );
    `);
    console.log('✅ قاعدة البيانات جاهزة');
  } finally {
    client.release();
  }
}

// --- محاكاة إرسال بريد (معطل) ---
async function sendNotification(patient, subject, message) {
  console.log(`📧 [محاكاة] ${subject} إلى ${patient.email || 'بلا بريد'}: ${message}`);
  return true;
}

// --- نقطة نهاية: تسجيل المريض (بوابة الشركة) ---
app.post('/api/register', async (req, res) => {
  try {
    const { nom, prenom, cin, telephone, email, hopital, departement } = req.body;
    if (!nom || !prenom || !cin || !telephone || !email || !hopital || !departement) {
      return res.status(400).json({ error: 'جميع الحقول مطلوبة' });
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

    // إشعار ترحيب بالمريض (محاكاة)
    await sendNotification({ email, nom, prenom }, 'تأكيد استلام الطلب', 'سنقوم بحجز موعدك وإعلامك به قريباً.');

    // QR Code
    const qrData = JSON.stringify({ id, nom, prenom, telephone, date: new Date().toISOString() });
    const qrBuffer = await QRCode.toBuffer(qrData, { width: 300 });
    const base64QR = qrBuffer.toString('base64');

    res.json({
      success: true,
      message: 'تم استلام طلبك بنجاح! سيتواصل معك فريقنا قريباً لتأكيد الموعد.',
      qrCode: `data:image/png;base64,${base64QR}`,
      id
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'حدث خطأ ما' });
  }
});

// --- لوحة تحكم الموظف: جلب جميع الطلبات ---
app.get('/api/staff/requests', async (req, res) => {
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${process.env.ADMIN_PASSWORD}`) {
    return res.status(401).json({ error: 'غير مصرح' });
  }

  try {
    const client = await pool.connect();
    const result = await client.query('SELECT * FROM registrations ORDER BY date_creation DESC');
    client.release();

    const requests = result.rows.map(r => ({
      ...r,
      cin: decrypt(r.cin_encrypted)
    }));
    res.json(requests);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'خطأ في جلب البيانات' });
  }
});

// --- تحديث حالة الطلب والموعد ---
app.put('/api/staff/update/:id', async (req, res) => {
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${process.env.ADMIN_PASSWORD}`) {
    return res.status(401).json({ error: 'غير مصرح' });
  }

  const { id } = req.params;
  const { status, rendez_vous } = req.body;

  try {
    const client = await pool.connect();
    if (status) {
      await client.query('UPDATE registrations SET status = $1 WHERE id = $2', [status, id]);
    }
    if (rendez_vous) {
      await client.query('UPDATE registrations SET rendez_vous = $1 WHERE id = $2', [rendez_vous, id]);
    }
    client.release();

    // إذا اكتمل الطلب (status = 'completed') نرسل إشعاراً للمريض
    if (status === 'completed' || rendez_vous) {
      const patient = (await pool.query('SELECT email, nom, prenom FROM registrations WHERE id = $1', [id])).rows[0];
      if (patient) {
        await sendNotification(patient, 'تم تحديد موعدك', `موعدك في ${rendez_vous || 'سيتم إعلامك لاحقاً'}.`);
      }
    }

    res.json({ success: true, message: 'تم التحديث بنجاح' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'فشل التحديث' });
  }
});

// --- محاكاة SMS (تبقى كما هي) ---
app.post('/api/staff/send-sms', async (req, res) => {
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${process.env.ADMIN_PASSWORD}`) {
    return res.status(401).json({ error: 'غير مصرح' });
  }
  const { id } = req.body;
  try {
    const patient = (await pool.query('SELECT telephone, nom, prenom, rendez_vous FROM registrations WHERE id = $1', [id])).rows[0];
    const smsText = `السيد/ة ${patient.nom} ${patient.prenom}، تم تحديد موعدكم: ${patient.rendez_vous || 'لم يحدد بعد'}. شكراً لثقتكم.`;
    console.log('📱 SMS (محاكاة):', smsText);
    res.json({ success: true, sms: smsText });
  } catch (err) {
    res.status(500).json({ error: 'خطأ' });
  }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/staff', (req, res) => res.sendFile(path.join(__dirname, 'public', 'staff.html')));

const PORT = process.env.PORT || 3000;
initializeDatabase().then(() => {
  app.listen(PORT, () => console.log(`✅ منصة وسيط المواعيد تعمل على المنفذ ${PORT}`));
});
