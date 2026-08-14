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
const CONTACT_TO_EMAIL = process.env.CONTACT_TO_EMAIL || 'admin@getwebsiteonline.com';

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
  console.log('Notification email sent to', CONTACT_TO_EMAIL, 'for submission from', submission.email);
}

// Auto-reply to the person who submitted. Replying to it is how they send us
// their logo and photos, so we don't need file uploads on the form.
async function sendClientConfirmationEmail(submission) {
  if (!mailTransporter) return;

  const firstName = submission.name.split(' ')[0];
  const lines = [
    `Hi ${firstName},`,
    '',
    `Thanks for reaching out about a website for ${submission.business}. We've got your request and we'll follow up personally within one business day with next steps and a timeline.`,
    '',
    'To get started faster, just reply to this email with anything you already have:',
    '',
    '  - Your logo (any format is fine)',
    '  - Photos of your business, work, team, or products',
    '  - Business hours and address, if they should appear on the site',
    '  - Links to your social media or online ordering/booking pages',
    '  - Any websites whose look you like',
    '',
    "Don't have some of that? No problem — we can start without it.",
    '',
    'No payment is due to get started.',
    '',
    'Talk soon,',
    'Get Website Online',
    '(908) 342-0521',
    'https://getwebsiteonline.com',
  ];

  await mailTransporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: sanitizeHeaderValue(submission.email),
    replyTo: CONTACT_TO_EMAIL,
    subject: `Thanks! We've got your website request`,
    text: lines.join('\n'),
    html: `
      <div style="font-family: Arial, Helvetica, sans-serif; font-size: 15px; line-height: 1.6; color: #1a2430;">
        <p>Hi ${escapeHtml(firstName)},</p>
        <p>Thanks for reaching out about a website for <strong>${escapeHtml(submission.business)}</strong>.
        We've got your request and we'll follow up personally within one business day with next steps and a timeline.</p>
        <p><strong>To get started faster, just reply to this email with anything you already have:</strong></p>
        <ul>
          <li>Your logo (any format is fine)</li>
          <li>Photos of your business, work, team, or products</li>
          <li>Business hours and address, if they should appear on the site</li>
          <li>Links to your social media or online ordering/booking pages</li>
          <li>Any websites whose look you like</li>
        </ul>
        <p>Don't have some of that? No problem &mdash; we can start without it.</p>
        <p>No payment is due to get started.</p>
        <p>Talk soon,<br />
        <strong>Get Website Online</strong><br />
        <a href="tel:+19083420521">(908) 342-0521</a><br />
        <a href="https://getwebsiteonline.com">getwebsiteonline.com</a></p>
      </div>
    `,
  });
  console.log('Confirmation email sent to', submission.email);
}

// The site is hosted on Netlify; this server only serves the API. Allow the
// production frontend origins plus anything set via ALLOWED_ORIGINS env var.
const DEFAULT_ALLOWED_ORIGINS = [
  'https://getwebsiteonline.com',
  'https://www.getwebsiteonline.com',
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
        scriptSrc: ["'self'", 'https://www.googletagmanager.com'],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'https://www.google-analytics.com', 'https://www.googletagmanager.com'],
        connectSrc: ["'self'", 'https://www.google-analytics.com', 'https://analytics.google.com', 'https://region1.google-analytics.com'],
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

  // Email failures must not fail the request: the submission is already saved.
  const mail = {
    name: body.name.trim(),
    email: body.email.trim(),
    business: body.business.trim(),
    phone: body.phone ? body.phone.trim() : '',
    pages: (body.pages || '').toString().trim(),
    details: body.details.trim(),
  };

  const [notification, confirmation] = await Promise.allSettled([
    sendNotificationEmail(mail),
    sendClientConfirmationEmail(mail),
  ]);

  if (notification.status === 'rejected') {
    console.error('Failed to send notification email:', notification.reason.message);
  }
  if (confirmation.status === 'rejected') {
    console.error('Failed to send confirmation email:', confirmation.reason.message);
  }

  return res.status(200).json({ ok: true });
});

app.use((req, res) => {
  res.status(404).sendFile(path.join(PUBLIC_DIR, '404.html'));
});

app.listen(PORT, () => {
  console.log(`GetWebsiteOnline site running on port ${PORT}`);
});
