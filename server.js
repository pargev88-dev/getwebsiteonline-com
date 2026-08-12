const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const SUBMISSIONS_FILE = path.join(DATA_DIR, 'submissions.jsonl');

// Where new site requests get emailed. Not shown anywhere on the site itself.
const CONTACT_TO_EMAIL = process.env.CONTACT_TO_EMAIL || 'support@exceluserform.com';

// SMTP is optional: if unset, the form still works and submissions are still
// saved to disk, but no notification email is sent.
let mailTransporter = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  mailTransporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
} else {
  console.warn('SMTP not configured; contact form notification emails will not be sent.');
}

// Strips CR/LF so untrusted input can't be used to inject extra email headers.
function sanitizeHeaderValue(str) {
  return String(str).replace(/[\r\n]+/g, ' ').trim();
}

async function sendNotificationEmail(submission) {
  if (!mailTransporter) return;
  await mailTransporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: CONTACT_TO_EMAIL,
    replyTo: submission.email,
    subject: `New website request from ${sanitizeHeaderValue(submission.business)}`,
    text: [
      `Name: ${submission.name}`,
      `Email: ${submission.email}`,
      `Business: ${submission.business}`,
      `Phone: ${submission.phone || '(not provided)'}`,
      `Pages: ${submission.pages || '(not specified)'}`,
      '',
      'Details:',
      submission.details,
    ].join('\n'),
  });
}

// The site is hosted on Netlify; this server only serves the API. Allow the
// production frontend origins plus anything set via ALLOWED_ORIGINS env var.
const DEFAULT_ALLOWED_ORIGINS = [
  'https://llmdirector.com',
  'https://www.llmdirector.com',
  'http://localhost:3000',
  'http://localhost:8888',
];
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean)
  .concat(DEFAULT_ALLOWED_ORIGINS);

function isAllowedOrigin(origin) {
  if (!origin) return true; // same-origin / non-browser requests
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  return /\.netlify\.app$/.test(new URL(origin).hostname);
}

app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
  })
);

app.use(
  cors({
    origin: (origin, callback) => {
      if (isAllowedOrigin(origin)) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    methods: ['POST'],
  })
);

app.use(express.json({ limit: '10kb' }));
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

// Throttle the contact form to reduce spam / abuse.
const contactLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many requests. Please try again later.' },
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isNonEmptyString(value, maxLen) {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= maxLen;
}

app.post('/api/contact', contactLimiter, async (req, res) => {
  const body = req.body || {};

  // Honeypot field: real users never fill this in.
  if (body.website) {
    return res.status(200).json({ ok: true });
  }

  const errors = [];
  if (!isNonEmptyString(body.name, 100)) errors.push('Name is required.');
  if (!isNonEmptyString(body.email, 200) || !EMAIL_RE.test(body.email.trim())) {
    errors.push('A valid email is required.');
  }
  if (!isNonEmptyString(body.business, 150)) errors.push('Business name is required.');
  if (body.phone && (typeof body.phone !== 'string' || body.phone.trim().length > 30)) {
    errors.push('Phone number is invalid.');
  }
  if (!isNonEmptyString(body.details, 3000)) {
    errors.push('Please tell us a bit about your business and what you need.');
  }

  if (errors.length) {
    return res.status(400).json({ ok: false, error: errors.join(' ') });
  }

  const submission = {
    name: escapeHtml(body.name.trim()),
    email: escapeHtml(body.email.trim()),
    business: escapeHtml(body.business.trim()),
    phone: body.phone ? escapeHtml(body.phone.trim()) : '',
    pages: escapeHtml((body.pages || '').toString().trim()).slice(0, 50),
    details: escapeHtml(body.details.trim()),
    receivedAt: new Date().toISOString(),
  };

  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.appendFileSync(SUBMISSIONS_FILE, JSON.stringify(submission) + '\n');
  } catch (err) {
    console.error('Failed to persist submission:', err.message);
    return res.status(500).json({ ok: false, error: 'Something went wrong. Please try again.' });
  }

  try {
    await sendNotificationEmail({
      name: body.name.trim(),
      email: body.email.trim(),
      business: body.business.trim(),
      phone: body.phone ? body.phone.trim() : '',
      pages: (body.pages || '').toString().trim(),
      details: body.details.trim(),
    });
  } catch (err) {
    console.error('Failed to send notification email:', err.message);
  }

  return res.status(200).json({ ok: true });
});

app.use((req, res) => {
  res.status(404).sendFile(path.join(PUBLIC_DIR, '404.html'));
});

app.listen(PORT, () => {
  console.log(`LLMdirector site running on port ${PORT}`);
});
