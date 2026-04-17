const express = require('express');
const { ImapFlow } = require('imapflow');
const nodemailer = require('nodemailer');

const app = express();
app.use(express.json({ limit: '5mb' }));

const API_SECRET = process.env.API_SECRET || 'invoicechaser_imap_2026';

// ─────────────────────────────────────────────
// Helper: auth check
// ─────────────────────────────────────────────
function checkAuth(req, res) {
  const secret = req.body.secret || req.headers['x-api-secret'];
  if (secret !== API_SECRET) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

// ─────────────────────────────────────────────
// Helper: convert SMTP host → IMAP host
// ─────────────────────────────────────────────
function toImapHost(host) {
  return host
    .replace(/^smtp\./, 'imap.')
    .replace(/^mail\./, 'imap.')
    .replace(/^out\./, 'imap.')
    .replace(/^send\./, 'imap.');
}

// ─────────────────────────────────────────────
// POST /send-email
// Sends email through customer's own SMTP server
// Body: { secret, host, port, user, pass, from, to, subject, html, replyTo }
// ─────────────────────────────────────────────
app.post('/send-email', async (req, res) => {
  if (!checkAuth(req, res)) return;

  const {
    host, port, user, pass,
    from, to, subject, html, replyTo
  } = req.body;

  // Validate required fields
  if (!host || !user || !pass) {
    return res.status(400).json({ success: false, error: 'Missing SMTP credentials (host, user, pass required)' });
  }
  if (!to || !subject) {
    return res.status(400).json({ success: false, error: 'Missing to or subject' });
  }

  const smtpPort = parseInt(port || '465');
  const isSecure = smtpPort === 465;

  let transporter;
  try {
    transporter = nodemailer.createTransport({
      host: host,
      port: smtpPort,
      secure: isSecure,
      auth: { user, pass },
      tls: { rejectUnauthorized: false }
    });

    // Verify connection before sending
    await transporter.verify();
  } catch (err) {
    return res.status(400).json({
      success: false,
      error: 'SMTP connection failed: ' + err.message
    });
  }

  try {
    const mailOptions = {
      from: from || user,
      to: to,
      subject: subject,
      html: html || '',
    };

    if (replyTo) mailOptions.replyTo = replyTo;

    const info = await transporter.sendMail(mailOptions);

    return res.json({
      success: true,
      messageId: info.messageId,
      response: info.response
    });

  } catch (err) {
    return res.status(500).json({
      success: false,
      error: 'Send failed: ' + err.message
    });
  }
});

// ─────────────────────────────────────────────
// POST /check-inbox
// Reads IMAP inbox for new emails
// Body: { secret, host, user, pass, sinceMinutes }
// ─────────────────────────────────────────────
app.post('/check-inbox', async (req, res) => {
  if (!checkAuth(req, res)) return;

  const { host, user, pass, sinceMinutes } = req.body;

  if (!host || !user || !pass) {
    return res.status(400).json({ error: 'Missing credentials' });
  }

  const imapHost = toImapHost(host);
  const since = new Date(Date.now() - (sinceMinutes || 16) * 60 * 1000);

  const client = new ImapFlow({
    host: imapHost,
    port: 993,
    secure: true,
    auth: { user, pass },
    logger: false,
    tls: { rejectUnauthorized: false }
  });

  const emails = [];

  try {
    await client.connect();
    await client.mailboxOpen('INBOX');

    const uids = await client.search({ seen: false, since });

    if (uids.length > 0) {
      for await (const msg of client.fetch(uids, {
        envelope: true,
        source: true
      })) {
        const source = msg.source?.toString() || '';

        // Extract plain text body, strip quoted replies
        let body = source
          .replace(/.*Content-Type: text\/plain[\s\S]*?\r\n\r\n/, '')
          .replace(/<[^>]+>/g, '')
          .replace(/\r\n/g, '\n')
          .replace(/\n{3,}/g, '\n\n')
          .trim()
          .slice(0, 1500);

        // Extract To header to find +ic+ tagged address
        const toMatch = source.match(/^To:(.+?)(?:\r\n(?!\s)|\r\n\r\n)/ms);
        const toHeader = toMatch ? toMatch[1].trim() : '';

        emails.push({
          uid: msg.uid,
          subject: msg.envelope?.subject || '',
          from: msg.envelope?.from?.[0]?.address || '',
          fromName: msg.envelope?.from?.[0]?.name || '',
          to: toHeader,
          date: msg.envelope?.date || new Date().toISOString(),
          body
        });
      }
    }

    await client.logout();
    return res.json({ success: true, count: emails.length, emails });

  } catch (err) {
    try { await client.logout(); } catch (e) {}
    return res.status(200).json({
      success: false,
      error: err.message,
      count: 0,
      emails: []
    });
  }
});

// ─────────────────────────────────────────────
// GET /health
// ─────────────────────────────────────────────
app.get('/health', (_, res) => res.json({
  status: 'ok',
  service: 'IC IMAP + SMTP Service',
  endpoints: ['/send-email', '/check-inbox', '/health']
}));

// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`IC IMAP+SMTP Service running on port ${PORT}`));
