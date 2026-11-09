const { randomUUID } = require('node:crypto');

module.exports = function setupPayPal(app, db, requireUser, reserveStock, orderQuantity) {
 const { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_PARTNER_MERCHANT_ID,
  PAYPAL_BN_CODE, PAYPAL_RETURN_ORIGIN } = process.env;
 const enabled = Boolean(PAYPAL_CLIENT_ID && PAYPAL_CLIENT_SECRET &&
  PAYPAL_PARTNER_MERCHANT_ID && PAYPAL_BN_CODE && PAYPAL_RETURN_ORIGIN);
 if (!enabled) return false;

 const origin = new URL(PAYPAL_RETURN_ORIGIN).origin;
 const base = 'https://api-m.sandbox.paypal.com';
 db.exec(`
 CREATE TABLE IF NOT EXISTS paypal_sellers (
  user_id INTEGER PRIMARY KEY REFERENCES users(id), tracking_id TEXT NOT NULL UNIQUE, merchant_id TEXT UNIQUE
 );
 CREATE TABLE IF NOT EXISTS paypal_orders (
  order_id INTEGER PRIMARY KEY REFERENCES orders(id), request_id TEXT NOT NULL UNIQUE,
  merchant_id TEXT NOT NULL, remote_id TEXT UNIQUE
 );
 `);

 async function json(url, options) {
  const response = await fetch(base + url, { ...options, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`PayPal request failed (${response.status})`);
  return response.json();
 }

 async function paypal(path, { body, merchant, requestId } = {}) {
  const basic = Buffer.from(PAYPAL_CLIENT_ID + ':' + PAYPAL_CLIENT_SECRET).toString('base64');
  const token = await json('/v1/oauth2/token', {
   method: 'POST', headers: { Authorization: 'Basic ' + basic,
    'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials'
  });
  const headers = { Authorization: 'Bearer ' + token.access_token,
   'Content-Type': 'application/json', 'PayPal-Partner-Attribution-Id': PAYPAL_BN_CODE };
  if (requestId) headers['PayPal-Request-Id'] = requestId;
  if (merchant) {
   const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
   headers['PayPal-Auth-Assertion'] = encode({ alg: 'none' }) + '.' +
    encode({ iss: PAYPAL_CLIENT_ID, payer_id: merchant }) + '.';
  }
  return json(path, { headers, method: body === undefined ? 'GET' : 'POST',
   body: body === undefined ? undefined : JSON.stringify(body) });
 }

 function route(handler) {
  return async (req, res) => {
   try {
    await handler(req, res);
   } catch (error) {
    if (!error.status) console.error(error.message);
    res.status(error.status || 502).json({ error: error.status ? error.message : 'PayPal could not complete the request. Try again from Your orders.' });
   }
  };
 }
 const check = (condition, message, status = 400) => {
  if (!condition) throw Object.assign(new Error(message), { status });
 };
 const seller = db.prepare('SELECT * FROM paypal_sellers WHERE user_id=?');
 const orders = db.prepare(`
  SELECT o.*, p.request_id, p.merchant_id, p.remote_id, c.listing_id AS classified_id, b.slots AS slot_pack, shop.order_id AS shop_order
  FROM orders o JOIN paypal_orders p ON p.order_id=o.id LEFT JOIN classified_ads c ON c.fee_order_id=o.id LEFT JOIN business_slot_orders b ON b.order_id=o.id LEFT JOIN business_shop_orders shop ON shop.order_id=o.id WHERE o.id=? AND o.buyer_id=?
 `);
 const amount = pence => (pence / 100).toFixed(2);

 app.post('/api/paypal/connect', requireUser, route(async (req, res) => {
  const id = req.session.userId;
  db.prepare('INSERT OR IGNORE INTO paypal_sellers (user_id,tracking_id) VALUES (?,?)').run(id, randomUUID());
  const result = await paypal('/v2/customer/partner-referrals', { body: {
   tracking_id: seller.get(id).tracking_id,
   partner_config_override: { return_url: origin + '/?paypalSeller=1' },
   operations: [{ operation: 'API_INTEGRATION', api_integration_preference: { rest_api_integration: {
    integration_method: 'PAYPAL', integration_type: 'THIRD_PARTY',
    third_party_details: { features: ['PAYMENT', 'REFUND'] }
   } } }],
   products: ['EXPRESS_CHECKOUT'],
   legal_consents: [{ type: 'SHARE_DATA_CONSENT', granted: true }]
  } });
  res.json({ url: result.links.find(link => link.rel === 'action_url').href });
 }));

 app.post('/api/paypal/verify-seller', requireUser, route(async (req, res) => {
  const record = seller.get(req.session.userId);
  check(record, 'Start PayPal setup first.');
  const path = '/v1/customer/partners/' + encodeURIComponent(PAYPAL_PARTNER_MERCHANT_ID) + '/merchant-integrations';
  const match = await paypal(path + '?tracking_id=' + encodeURIComponent(record.tracking_id));
  check(match.merchant_id, 'PayPal is still setting up this seller.');
  const details = await paypal(path + '/' + encodeURIComponent(match.merchant_id));
  check(details.payments_receivable && details.primary_email_confirmed,
   'Complete PayPal setup and confirm your PayPal email first.');
  db.prepare('UPDATE paypal_sellers SET merchant_id=? WHERE user_id=?').run(match.merchant_id, record.user_id);
  res.json({ connected: true });
 }));

 const listing = db.prepare('SELECT * FROM listings WHERE id=? AND status=\'active\'');
 const winningBid = db.prepare('SELECT * FROM bids WHERE listing_id=? ORDER BY amount_pence DESC,id ASC LIMIT 1');
 const reserve = db.transaction((buyer, ids, auctionId, quantities) => {
  const items = ids.map(id => listing.get(id));
  check(items.every(item => item && item.seller_id !== buyer), 'One or more listings are unavailable.');
  check(items.every(item => item.seller_id === items[0].seller_id), 'Check out separately for each seller.');
  const merchant = seller.get(items[0].seller_id)?.merchant_id;
  check(merchant, 'This seller has not completed PayPal setup.');
  if (auctionId) {
   const item = items[0];
   const winner = winningBid.get(item.id);
   check(item.listing_type === 'auction' && Date.parse(item.ends_at) <= Date.now() &&
    winner?.bidder_id === buyer, 'Only the winning bidder can pay after the auction ends.');
   item.price_pence = winner.amount_pence;
  } else {
   check(items.every(item => item.listing_type === 'fixed'), 'Use the auction payment button for a winning bid.');
  }
  for(const item of items){
   item.quantity=auctionId?1:orderQuantity(quantities,item.id);
   check(item.quantity && item.quantity<=item.available_quantity,'The requested quantity is unavailable.');
  }
  const total = items.reduce((sum, item) => sum + (item.price_pence + item.shipping_pence)*item.quantity, 0);
  const orderId = Number(db.prepare('INSERT INTO orders (buyer_id,total_pence) VALUES (?,?)').run(buyer,total).lastInsertRowid);
  db.prepare('INSERT INTO paypal_orders (order_id,request_id,merchant_id) VALUES (?,?,?)').run(orderId,randomUUID(),merchant);
  for (const item of items) {
   db.prepare('INSERT INTO order_items (order_id,listing_id,seller_id,title_snapshot,unit_price_pence,shipping_pence,quantity) VALUES (?,?,?,?,?,?,?)')
    .run(orderId,item.id,item.seller_id,item.title,item.price_pence,item.shipping_pence,item.quantity);
   reserveStock.run({id:item.id,quantity:item.quantity});
  }
  return orderId;
 });

 app.post('/api/paypal/orders', requireUser, route((req, res) => {
  const auctionId = req.body.auctionId;
  const ids = auctionId ? [auctionId] : Array.isArray(req.body.listingIds) ? [...new Set(req.body.listingIds)] : [];
  check(ids.length && ids.length <= 30 && ids.every(id => Number.isSafeInteger(id) && id > 0), 'Choose valid listings.');
  res.json({ orderId: reserve.immediate(req.session.userId, ids, auctionId, req.body.quantities) });
 }));

 app.post('/api/paypal/orders/:id/approve', requireUser, route(async (req, res) => {
  const order = orders.get(req.params.id, req.session.userId);
  check(order?.status === 'payment_pending', 'This order is unavailable.', 404);
  const merchant = (order.classified_id || order.slot_pack || order.shop_order) ? undefined : order.merchant_id;
  const result = order.remote_id
   ? await paypal('/v2/checkout/orders/' + order.remote_id, { merchant })
   : await paypal('/v2/checkout/orders', { merchant, requestId: order.request_id, body: {
    intent: 'CAPTURE',
    purchase_units: [{ reference_id: String(order.id), payee: { merchant_id: order.merchant_id },
     amount: { currency_code: 'GBP', value: amount(order.total_pence) } }],
    payment_source: { paypal: { experience_context: {
     user_action: 'PAY_NOW', ...((order.classified_id || order.slot_pack || order.shop_order) ? { shipping_preference: 'NO_SHIPPING' } : {}), return_url: origin + '/?paypalOrder=' + order.id,
     cancel_url: origin + '/?paypalCancelled=1'
    } } }
   } });
  db.prepare('UPDATE paypal_orders SET remote_id=? WHERE order_id=?').run(result.id, order.id);
  const approval = result.links.find(link => ['payer-action','approve'].includes(link.rel));
  res.json({ url: approval?.href || origin + '/?paypalOrder=' + order.id });
 }));

 app.post('/api/paypal/orders/:id/capture', requireUser, route(async (req, res) => {
  const order = orders.get(req.params.id, req.session.userId);
  check(order?.remote_id, 'This order is unavailable.', 404);
  if (order.status === 'paid') return res.json({ paid: true, ...(order.classified_id ? { published: true } : {}), ...(order.slot_pack ? { slotsAdded: order.slot_pack } : {}), ...(order.shop_order ? { shopActivated: true } : {}) });
  const path = '/v2/checkout/orders/' + order.remote_id;
  const merchant = (order.classified_id || order.slot_pack || order.shop_order) ? undefined : order.merchant_id;
  let result = await paypal(path, { merchant });
  if (result.status === 'APPROVED') {
   result = await paypal(path + '/capture', { merchant, requestId: order.request_id + '-cap', body: {} });
  }
  const unit = result.purchase_units?.[0];
  const capture = unit?.payments?.captures?.[0];
  check(capture?.status === 'COMPLETED', 'PayPal has not completed this payment. Check again from Your orders.', 409);
  check(unit.reference_id === String(order.id) && unit.payee?.merchant_id === order.merchant_id &&
   capture.amount?.currency_code === 'GBP' && capture.amount.value === amount(order.total_pence),
   'PayPal payment details did not match the order.', 409);
  db.transaction(() => {
   db.prepare("UPDATE orders SET status='paid',payment_reference=? WHERE id=?").run(capture.id, order.id);
   if(order.classified_id){
    db.prepare("UPDATE listings SET status='active' WHERE id=? AND status='awaiting_fee'").run(order.classified_id);
    return;
   }
   if(order.shop_order){
    db.prepare('UPDATE business_shop_orders SET paid_at=CURRENT_TIMESTAMP WHERE order_id=? AND paid_at IS NULL').run(order.id);
    return;
   }
   if(order.slot_pack)return;
   db.prepare(`UPDATE listings SET status='sold' WHERE status='reserved' AND available_quantity=0
    AND id IN (SELECT listing_id FROM order_items WHERE order_id=?)
    AND NOT EXISTS (SELECT 1 FROM order_items oi JOIN orders o ON o.id=oi.order_id
     WHERE oi.listing_id=listings.id AND o.status='payment_pending')`).run(order.id);
  })();
  res.json({ paid: true, ...(order.classified_id ? { published: true } : {}), ...(order.slot_pack ? { slotsAdded: order.slot_pack } : {}), ...(order.shop_order ? { shopActivated: true } : {}) });
 }));
 return true;
};
