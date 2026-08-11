const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const SUBMISSIONS_FILE = path.join(DATA_DIR, 'submissions.jsonl');

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

app.post('/api/contact', contactLimiter, (req, res) => {
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

  return res.status(200).json({ ok: true });
});

app.use((req, res) => {
  res.status(404).sendFile(path.join(PUBLIC_DIR, '404.html'));
});

app.listen(PORT, () => {
  console.log(`LLMdirector site running on port ${PORT}`);
});
