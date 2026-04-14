const express = require('express');
const { ImapFlow } = require('imapflow');
const app = express();
app.use(express.json());

const API_SECRET = process.env.API_SECRET || 'invoicechaser_imap_2026';

app.post('/check-inbox', async (req, res) => {
  const { host, user, pass, sinceMinutes, secret } = req.body;

  if (secret !== API_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  if (!host || !user || !pass) return res.status(400).json({ error: 'Missing credentials' });

  // Auto-convert smtp host to imap host
  const imapHost = host
    .replace(/^smtp\./, 'imap.')
    .replace(/^mail\./, 'imap.')
    .replace(/^out\./, 'imap.');

  const client = new ImapFlow({
    host: imapHost,
    port: 993,
    secure: true,
    auth: { user, pass },
    logger: false,
    tls: { rejectUnauthorized: false }
  });

  const emails = [];
  const since = new Date(Date.now() - (sinceMinutes || 16) * 60 * 1000);

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
        
        // Strip quoted replies, get only the fresh reply text
        let body = source
          .replace(/.*Content-Type: text\/plain[\s\S]*?\r\n\r\n/, '')
          .replace(/<[^>]+>/g, '')
          .replace(/\r\n/g, '\n')
          .trim()
          .slice(0, 1000);

        emails.push({
          uid: msg.uid,
          subject: msg.envelope?.subject || '',
          from: msg.envelope?.from?.[0]?.address || '',
          fromName: msg.envelope?.from?.[0]?.name || '',
          date: msg.envelope?.date || new Date().toISOString(),
          body
        });
      }
    }

    await client.logout();
    return res.json({ success: true, count: emails.length, emails });

  } catch (err) {
    try { await client.logout(); } catch(e) {}
    // Return empty instead of crashing — WF3 handles gracefully
    return res.status(200).json({ 
      success: false, 
      error: err.message, 
      count: 0, 
      emails: [] 
    });
  }
});

app.get('/health', (_, res) => res.json({ status: 'ok', service: 'IC IMAP Service' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`IC IMAP Service running on port ${PORT}`));
