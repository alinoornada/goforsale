const screenContent = require('./moderation');

module.exports = function setupMessages(app, db, requireUser) {
 db.exec(`
 CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY, listing_id INTEGER NOT NULL REFERENCES listings(id),
  buyer_id INTEGER NOT NULL REFERENCES users(id), seller_id INTEGER NOT NULL REFERENCES users(id),
  UNIQUE(listing_id,buyer_id)
 );
 CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  sender_id INTEGER NOT NULL REFERENCES users(id), body TEXT NOT NULL,
  sent_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, read_at TEXT
 );
 CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id,id);
 `);

 const conversation = db.prepare(`
  SELECT c.*, l.title, buyer.name AS buyer_name, seller.name AS seller_name
  FROM conversations c JOIN listings l ON l.id=c.listing_id
  JOIN users buyer ON buyer.id=c.buyer_id JOIN users seller ON seller.id=c.seller_id
  WHERE c.id=? AND (c.buyer_id=? OR c.seller_id=?)
 `);
 const enqueueEmail = require('./message-email')(db);
 const insertMessage = db.prepare('INSERT INTO messages (conversation_id,sender_id,body) VALUES (?,?,?)');
 const send = db.transaction((id,user,body) => {
  const result = insertMessage.run(id,user,body);
  enqueueEmail(result.lastInsertRowid);
 });
 const messageText = req => typeof req.body?.body === 'string' ? req.body.body.trim() : '';
 const valid = text => text.length > 0 && text.length <= 2000;

 app.get('/api/messages', requireUser, (req,res) => {
  const user = req.session.userId;
  res.json(db.prepare(`
   SELECT c.id, l.title, u.name AS participant,
    (SELECT body FROM messages WHERE conversation_id=c.id ORDER BY id DESC LIMIT 1) AS latest,
    (SELECT COUNT(*) FROM messages WHERE conversation_id=c.id AND sender_id!=@user AND read_at IS NULL) AS unread
   FROM conversations c JOIN listings l ON l.id=c.listing_id
   JOIN users u ON u.id=CASE WHEN c.buyer_id=@user THEN c.seller_id ELSE c.buyer_id END
   WHERE c.buyer_id=@user OR c.seller_id=@user
   ORDER BY (SELECT MAX(id) FROM messages WHERE conversation_id=c.id) DESC
  `).all({user}));
 });

 app.post('/api/messages', requireUser, screenContent(['body']), (req,res) => {
  const user = req.session.userId;
  const body = messageText(req);
  if(!valid(body)) return res.status(400).json({error:'Enter a message of 1 to 2,000 characters.'});
  const id = db.transaction(() => {
   const listing = db.prepare("SELECT * FROM listings WHERE id=? AND status='active'").get(Number(req.body.listingId));
   if(!listing || listing.seller_id===user) return null;
   db.prepare('INSERT INTO conversations (listing_id,buyer_id,seller_id) VALUES (?,?,?) ON CONFLICT(listing_id,buyer_id) DO NOTHING')
    .run(listing.id,user,listing.seller_id);
   const {id} = db.prepare('SELECT id FROM conversations WHERE listing_id=? AND buyer_id=?').get(listing.id,user);
   send.run(id,user,body);
   return id;
  }).immediate();
  if(!id) return res.status(400).json({error:'You can only contact another seller about a public listing.'});
  res.status(201).json({id});
 });

 app.get('/api/messages/:id', requireUser, (req,res) => {
  const user = req.session.userId;
  const thread = conversation.get(req.params.id,user,user);
  if(!thread) return res.status(404).json({error:'Conversation unavailable.'});
  const history = db.prepare('SELECT id,sender_id,body,sent_at FROM messages WHERE conversation_id=? ORDER BY id').all(thread.id);
  res.json({thread,history});
 });

 app.post('/api/messages/:id/read', requireUser, (req,res) => {
  const user = req.session.userId;
  const thread = conversation.get(req.params.id,user,user);
  if(!thread) return res.status(404).json({error:'Conversation unavailable.'});
  const through = req.body?.through;
  if(!Number.isSafeInteger(through)) return res.status(400).json({error:'Invalid message ID.'});
  db.prepare('UPDATE messages SET read_at=CURRENT_TIMESTAMP WHERE conversation_id=? AND id<=? AND sender_id!=? AND read_at IS NULL')
   .run(thread.id,through,user);
  res.json({ok:true});
 });

 app.post('/api/messages/:id', requireUser, screenContent(['body']), (req,res) => {
  const user = req.session.userId;
  const thread = conversation.get(req.params.id,user,user);
  if(!thread) return res.status(404).json({error:'Conversation unavailable.'});
  const body = messageText(req);
  if(!valid(body)) return res.status(400).json({error:'Enter a message of 1 to 2,000 characters.'});
  send.run(thread.id,user,body);
  res.status(201).json({id:thread.id});
 });
};
