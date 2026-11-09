module.exports = function setupMessageEmail(db) {
 const { RESEND_API_KEY, MAIL_FROM, MAIL_SITE_URL } = process.env;
 db.exec(`
 CREATE TABLE IF NOT EXISTS message_email_queue (
  message_id INTEGER PRIMARY KEY REFERENCES messages(id),
  attempts INTEGER NOT NULL DEFAULT 0,
  retry_at INTEGER NOT NULL DEFAULT 0
 );
 `);
 const enqueue = db.prepare('INSERT INTO message_email_queue (message_id) VALUES (?)');
 if (!RESEND_API_KEY) return id => enqueue.run(id);
 if (!MAIL_FROM || !MAIL_SITE_URL) throw new Error('Set MAIL_FROM and MAIL_SITE_URL for message emails.');

 const site = new URL(MAIL_SITE_URL);
 if (site.protocol !== 'https:' || site.username || site.password) {
  throw new Error('MAIL_SITE_URL must be an HTTPS marketplace URL.');
 }
 const pending = db.prepare(`
  SELECT q.*, m.body, sender.name AS sender, recipient.email, l.title
  FROM message_email_queue q JOIN messages m ON m.id=q.message_id
  JOIN conversations c ON c.id=m.conversation_id JOIN listings l ON l.id=c.listing_id
  JOIN users sender ON sender.id=m.sender_id
  JOIN users recipient ON recipient.id=CASE WHEN m.sender_id=c.buyer_id THEN c.seller_id ELSE c.buyer_id END
  WHERE q.retry_at<=? ORDER BY q.message_id LIMIT 20
 `);
 const remove = db.prepare('DELETE FROM message_email_queue WHERE message_id=?');
 const retry = db.prepare('UPDATE message_email_queue SET attempts=attempts+1,retry_at=? WHERE message_id=?');
 let running = false;
 async function deliver() {
  if (running) return;
  running = true;
  try {
   for (const item of pending.all(Date.now())) {
    try {
     const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json',
       'Idempotency-Key': site.hostname + '/message/' + item.message_id },
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({
       from: MAIL_FROM,
       to: [item.email],
       subject: 'New marketplace message on goforsale.co.uk',
       text: `New message from ${item.sender} about ${item.title}:\n\n${item.body}\n\nSign in and open Messages to reply: ${site.origin}/`
      })
     });
     if (!response.ok) throw Object.assign(new Error('Email request failed'), {code:response.status});
     remove.run(item.message_id);
    } catch (error) {
     const delay = Math.min(86400000, 60000 * 2 ** Math.min(item.attempts, 11));
     retry.run(Date.now() + delay, item.message_id);
     console.error('Marketplace message email delivery failed', error.code || 'UNKNOWN');
    }
   }
  } finally {
   running = false;
  }
 }
 setInterval(() => deliver().catch(() => console.error('Marketplace email queue processing failed')), 5000).unref();
 return id => enqueue.run(id);
};
