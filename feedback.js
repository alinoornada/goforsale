const screenContent = require('./moderation');

module.exports = function setupFeedback(app,db,requireUser) {
 db.exec(`
 CREATE TABLE IF NOT EXISTS feedback (
  order_id INTEGER NOT NULL REFERENCES orders(id),
  seller_id INTEGER NOT NULL REFERENCES users(id),
  author_id INTEGER NOT NULL REFERENCES users(id),
  rating INTEGER NOT NULL CHECK(rating IN (-1,1)),
  comment TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(order_id,seller_id,author_id)
 );
 CREATE INDEX IF NOT EXISTS feedback_seller ON feedback(seller_id,author_id);
 `);

 app.get('/api/feedback', requireUser, (req,res) => {
  const user = req.session.userId;
  res.json(db.prepare(`
   SELECT o.id AS order_id, oi.seller_id,
    CASE WHEN o.buyer_id=@user THEN seller.name ELSE buyer.name END AS participant,
    CASE WHEN o.buyer_id=@user THEN 'seller' ELSE 'buyer' END AS recipient_role,
    GROUP_CONCAT(oi.title_snapshot,' · ') AS items, given.rating, given.comment,
    received.rating AS received_rating, received.comment AS received_comment
   FROM orders o JOIN order_items oi ON oi.order_id=o.id
   JOIN users seller ON seller.id=oi.seller_id JOIN users buyer ON buyer.id=o.buyer_id
   LEFT JOIN feedback given ON given.order_id=o.id AND given.seller_id=oi.seller_id AND given.author_id=@user
   LEFT JOIN feedback received ON received.order_id=o.id AND received.seller_id=oi.seller_id
    AND received.author_id=CASE WHEN o.buyer_id=@user THEN oi.seller_id ELSE o.buyer_id END
   WHERE o.status='paid' AND (o.buyer_id=@user OR oi.seller_id=@user) AND o.buyer_id!=oi.seller_id
   GROUP BY o.id,oi.seller_id ORDER BY o.id DESC
  `).all({user}));
 });

 app.post('/api/feedback', requireUser, screenContent(['comment']), (req,res) => {
  const user = req.session.userId;
  const {orderId,sellerId,rating,comment} = req.body || {};
  if(!Number.isSafeInteger(orderId) || !Number.isSafeInteger(sellerId) ||
     ![-1,1].includes(rating) || typeof comment!=='string' || comment.trim().length>500) {
   return res.status(400).json({error:'Choose positive or negative feedback and enter up to 500 characters.'});
  }
  const inserted = db.prepare(`
   INSERT INTO feedback (order_id,seller_id,author_id,rating,comment)
   SELECT o.id, @seller, @user, @rating, @comment FROM orders o
   WHERE o.id=@order AND o.status='paid' AND o.buyer_id!=@seller
    AND (@user=o.buyer_id OR @user=@seller)
    AND EXISTS (SELECT 1 FROM order_items WHERE order_id=o.id AND seller_id=@seller)
   ON CONFLICT(order_id,seller_id,author_id) DO NOTHING
  `).run({order:orderId,seller:sellerId,user,rating,comment:comment.trim()});
  if(!inserted.changes) return res.status(409).json({error:'Feedback was already submitted or this order is not eligible.'});
  res.status(201).json({ok:true});
 });

 app.get('/api/sellers/:id/feedback', (req,res) => {
  res.json(db.prepare(`
   SELECT f.rating,f.comment,f.created_at, u.name AS author
   FROM feedback f JOIN orders o ON o.id=f.order_id JOIN users u ON u.id=f.author_id
   WHERE f.seller_id=? AND f.author_id=o.buyer_id AND o.status='paid'
   ORDER BY f.created_at DESC, f.order_id DESC LIMIT 50
  `).all(req.params.id));
 });
};
