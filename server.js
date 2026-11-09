const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const {createHash} = require('node:crypto');

const screenContent = require('./moderation');
const categories = require('./public/categories.json');
function validSubcategory(category,value) {
 return value===undefined || value==='' ||
  (Object.hasOwn(categories,category) && categories[category].includes(value));
}
const app = express();
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const storage = process.env.FORSALE_STORAGE_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || ROOT;
const DATA = path.join(storage, 'data');
const UPLOADS = path.join(storage, 'uploads');
const production = process.env.NODE_ENV === 'production';
if (production && (process.env.SESSION_SECRET || '').length < 32) {
 throw new Error('Set a SESSION_SECRET of at least 32 characters in production.');
}
if (process.env.TRUST_PROXY === '1' || process.env.RAILWAY_ENVIRONMENT_ID) {
 app.set('trust proxy', 1);
}
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(UPLOADS, { recursive: true });

const db = new Database(path.join(DATA, 'forsale.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
 id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
 password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'seller', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS business_accounts (
 user_id INTEGER PRIMARY KEY REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS listings (
 id INTEGER PRIMARY KEY AUTOINCREMENT, seller_id INTEGER NOT NULL REFERENCES users(id),
 title TEXT NOT NULL, description TEXT NOT NULL, category TEXT NOT NULL, condition TEXT NOT NULL,
 price_pence INTEGER NOT NULL, listing_type TEXT NOT NULL DEFAULT 'fixed',
 image TEXT, location TEXT DEFAULT 'United Kingdom', status TEXT NOT NULL DEFAULT 'active',
 ends_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS listing_photos (
 id INTEGER PRIMARY KEY, listing_id INTEGER NOT NULL REFERENCES listings(id), image TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS bids (
 id INTEGER PRIMARY KEY AUTOINCREMENT, listing_id INTEGER NOT NULL REFERENCES listings(id),
 bidder_id INTEGER NOT NULL REFERENCES users(id), amount_pence INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS orders (
 id INTEGER PRIMARY KEY AUTOINCREMENT, buyer_id INTEGER NOT NULL REFERENCES users(id),
 total_pence INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'payment_pending',
 payment_reference TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS business_shop_orders (
 order_id INTEGER PRIMARY KEY REFERENCES orders(id),
 paid_at TEXT
);
CREATE TABLE IF NOT EXISTS business_slot_orders (
 order_id INTEGER PRIMARY KEY REFERENCES orders(id),
 slots INTEGER NOT NULL CHECK(slots>0)
);
CREATE TABLE IF NOT EXISTS classified_ads (
 listing_id INTEGER PRIMARY KEY REFERENCES listings(id),
 contact_email TEXT NOT NULL,
 fee_order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id)
);
CREATE TABLE IF NOT EXISTS order_items (
 id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL REFERENCES orders(id),
 listing_id INTEGER NOT NULL REFERENCES listings(id), seller_id INTEGER NOT NULL REFERENCES users(id),
 title_snapshot TEXT NOT NULL, unit_price_pence INTEGER NOT NULL, quantity INTEGER NOT NULL DEFAULT 1
);
`);
for(const table of ['listings','order_items']){
 if(!db.pragma('table_info('+table+')').some(column=>column.name==='shipping_pence')){
  db.exec('ALTER TABLE '+table+' ADD COLUMN shipping_pence INTEGER NOT NULL DEFAULT 0 CHECK(shipping_pence>=0)');
 }
}
if(!db.pragma('table_info(listings)').some(column=>column.name==='available_quantity')){
 db.exec(`ALTER TABLE listings ADD COLUMN available_quantity INTEGER NOT NULL DEFAULT 1 CHECK(available_quantity>=0);
  UPDATE listings SET available_quantity=0 WHERE status IN ('sold','reserved');`);
}
if(!db.pragma('table_info(listings)').some(column=>column.name==='subcategory')){
 db.exec("ALTER TABLE listings ADD COLUMN subcategory TEXT NOT NULL DEFAULT ''");
}
const reserveStock = db.prepare(`UPDATE listings SET available_quantity=available_quantity-@quantity,
 status=CASE WHEN available_quantity=@quantity THEN 'reserved' ELSE 'active' END WHERE id=@id`);
function orderQuantity(quantities,id) {
 const value = quantities?.[id] ?? 1;
 return Number.isSafeInteger(value) && value>=1 && value<=9999 ? value : null;
}
function listingQuantity(value) {
 if(value===undefined)return 1;
 return typeof value==='string' && /^\d{1,4}$/.test(value) && Number(value)>0 ? Number(value) : null;
}
const count = db.prepare('SELECT COUNT(*) AS n FROM listings').get().n;
if (!count) {
 const demo = [
  ['Wireless noise-cancelling headphones','Bluetooth headphones, boxed and ready to use.','Electronics','New',4999,'🎧','Manchester'],
  ['Modern ceramic table lamp','A simple contemporary lamp for a living room or bedroom.','Home & Garden','New',2450,'💡','Leeds'],
  ['Classic leather trainers','Comfortable everyday trainers.','Fashion','New',3800,'👟','Birmingham'],
  ['Vintage film camera','Pre-loved analogue camera, sold as seen.','Collectables','Used',7200,'📷','London'],
  ['Cordless drill and tool kit','Cordless drill with useful home DIY accessories.','Home & Garden','New',5995,'🧰','Bradford'],
  ['Football training ball','Training ball suitable for weekly practice.','Sports','New',1699,'⚽','Liverpool'],
  ['Smart watch – graphite','Pre-owned smart watch in good working order.','Electronics','Used',3499,'⌚','Sheffield'],
  ['Car care cleaning bundle','A handy bundle for routine vehicle cleaning.','Motors','New',2150,'🚘','Nottingham']
 ];
 const insert = db.prepare(`INSERT INTO listings (seller_id,title,description,category,condition,price_pence,image,location)
 VALUES (1,?,?,?,?,?,?,?)`);
 const admin = db.prepare('SELECT id FROM users WHERE id=1').get();
 if (!admin) db.prepare(`INSERT INTO users (id,name,email,password_hash,role) VALUES (1,'goforsale.co.uk Demo','demo@forsale.local','not-a-login','seller')`).run();
 const tx = db.transaction(() => demo.forEach(x => insert.run(...x)));
 tx();
}

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));
app.use('/uploads', (req, res, next) => {
 const image = '/uploads/' + path.basename(decodeURIComponent(req.path));
 const publicImage = db.prepare(`SELECT 1 FROM listings
  WHERE (listing_type!='classified' OR status='active') AND
  (image=? OR id IN (SELECT listing_id FROM listing_photos WHERE image=?))`).get(image,image);
 if(!publicImage) return res.sendStatus(404);
 next();
}, express.static(UPLOADS));
app.use(session({
 name: 'forsale.sid',
 store: new SQLiteStore({ db: 'sessions.sqlite', dir: DATA }),
 secret: process.env.SESSION_SECRET || 'development-only-change-this-secret-before-launch',
 resave: false, saveUninitialized: false,
 cookie: { httpOnly: true, sameSite: 'lax', secure: production, maxAge: 1000*60*60*24*7 }
}));
const authLimiter = rateLimit({ windowMs: 15*60*1000, limit: 20, standardHeaders: true, legacyHeaders: false });
const upload = multer({
 storage: multer.diskStorage({
  destination: (_,__,cb) => cb(null, UPLOADS),
  filename: (_,file,cb) => cb(null, `${Date.now()}-${Math.random().toString(16).slice(2)}${({ 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' }[file.mimetype])}`)
 }),
 limits: { fileSize: 5*1024*1024 },
 fileFilter: (_,file,cb) => cb(null, ['image/jpeg','image/png','image/webp'].includes(file.mimetype))
});
const businessLimit = 200;
const businessAccount = db.prepare('SELECT user_id FROM business_accounts WHERE user_id=?');
const openBusiness = db.prepare('INSERT OR IGNORE INTO business_accounts (user_id) VALUES (?)');
const occupiedSlots = db.prepare(`SELECT COUNT(*) AS count FROM listings
 WHERE seller_id=? AND status IN ('active','reserved','awaiting_fee')
 AND (listing_type!='auction' OR status!='active' OR julianday(ends_at)>julianday('now')
      OR EXISTS (SELECT 1 FROM bids WHERE listing_id=listings.id))`);
const safeUser = u => u && ({id:u.id,name:u.name,email:u.email,role:u.role,
 accountType:businessAccount.get(u.id)?'business':'personal'});
const purchasedSlots = db.prepare(`SELECT COALESCE(SUM(b.slots),0) AS total
 FROM business_slot_orders b JOIN orders o ON o.id=b.order_id
 WHERE o.buyer_id=? AND o.status='paid'`);
function listingAllowance(id) {
 return businessAccount.get(id) ? {limit:businessLimit+purchasedSlots.get(id).total,used:occupiedSlots.get(id).count} : null;
}
const requireUser = (req,res,next) => req.session.userId ? next() : res.status(401).json({error:'Please sign in first.'});
const requireAdmin = (req,res,next) => {
 const u = req.session.userId && db.prepare('SELECT * FROM users WHERE id=?').get(req.session.userId);
 if (!u || u.role !== 'admin') return res.status(403).json({error:'Admin access required.'});
 next();
};
require('./messages')(app, db, requireUser);
require('./feedback')(app, db, requireUser);
const paymentsEnabled = require('./paypal')(app, db, requireUser, reserveStock, orderQuantity);
const configuredFee = Number(process.env.CLASSIFIED_FEE_PENCE);
const classifiedFee = paymentsEnabled && Number.isSafeInteger(configuredFee) && configuredFee > 0
 ? configuredFee : 0;
const slotPackSize = 50;
const slotPackFee = Number(process.env.BUSINESS_SLOT_PACK_FEE_PENCE || 300);
const shopFee = 2400;
const slotPack = paymentsEnabled && Number.isSafeInteger(slotPackFee) && slotPackFee>0
 ? {slots:slotPackSize,feePence:slotPackFee} : null;
const shopExpiry = db.prepare(`SELECT MAX(datetime(b.paid_at,'+30 days')) AS expiry
 FROM business_shop_orders b JOIN orders o ON o.id=b.order_id
 WHERE o.buyer_id=? AND o.status='paid'`);
function businessShop(id) {
 const expiry = shopExpiry.get(id).expiry;
 return {feePence:shopFee, expiresAt:expiry, active:expiry!==null && Date.parse(expiry.replace(' ','T')+'Z')>Date.now()};
}
app.post('/api/business-account/:purchase(slot-pack|shop)', requireUser, (req,res) => {
 const buyer = req.session.userId;
 const shop = req.params.purchase==='shop';
 const fee = shop?shopFee:slotPack?.feePence;
 if(!paymentsEnabled || !fee || !businessAccount.get(buyer))
  return res.status(409).json({error:'Business purchases are unavailable.'});
 if(shop && businessShop(buyer).active)
  return res.status(409).json({error:'Your Business Shop is already active.'});
 if(!shop && !businessShop(buyer).active)
  return res.status(409).json({error:'Activate your Business Shop before buying extra slots.'});
 if(req.body?.feePence!==fee)
  return res.status(409).json({error:'The pack price has changed. Refresh your account and try again.'});
 const orderId = db.transaction(()=>{
  const orderTable = shop?'business_shop_orders':'business_slot_orders';
  const existing = db.prepare(`SELECT o.id FROM orders o JOIN ${orderTable} b ON b.order_id=o.id
   WHERE o.buyer_id=? AND o.status='payment_pending' AND o.total_pence=?`).get(buyer,fee);
  if(existing) return existing.id;
  const id = Number(db.prepare('INSERT INTO orders (buyer_id,total_pence) VALUES (?,?)')
   .run(buyer,fee).lastInsertRowid);
  if(shop)db.prepare('INSERT INTO business_shop_orders (order_id) VALUES (?)').run(id);
  else db.prepare('INSERT INTO business_slot_orders (order_id,slots) VALUES (?,?)').run(id,slotPack.slots);
  db.prepare('INSERT INTO paypal_orders (order_id,request_id,merchant_id) VALUES (?,?,?)')
   .run(id,require('node:crypto').randomUUID(),process.env.PAYPAL_PARTNER_MERCHANT_ID);
  return id;
 }).immediate();
 res.json({orderId});
});
const pounds = p => Math.round(Number(p)*100);
function shippingPence(value) {
 if(value===undefined || value==='')return 0;
 if(typeof value!=='string' || !/^\d{1,7}(?:\.\d{1,2})?$/.test(value))return null;
 return pounds(value);
}
const listingQuery = `SELECT l.*, u.name AS seller_name,
 (SELECT COUNT(*) FROM feedback f JOIN orders o ON o.id=f.order_id
  WHERE f.seller_id=l.seller_id AND f.author_id=o.buyer_id AND o.status='paid') AS feedback_count,
 (SELECT COUNT(*) FROM feedback f JOIN orders o ON o.id=f.order_id
  WHERE f.seller_id=l.seller_id AND f.author_id=o.buyer_id AND o.status='paid' AND f.rating=1) AS positive_feedback,
 (SELECT COALESCE(SUM(oi.quantity),0) FROM order_items oi JOIN orders o ON o.id=oi.order_id
  WHERE oi.seller_id=l.seller_id AND o.status='paid') AS seller_sold_count,
 (SELECT MAX(amount_pence) FROM bids b WHERE b.listing_id=l.id) AS current_bid
 FROM listings l JOIN users u ON u.id=l.seller_id`;
app.get('/api/me', (req,res) => {
 const u = req.session.userId && db.prepare('SELECT * FROM users WHERE id=?').get(req.session.userId);
 res.json({user:safeUser(u), paymentsEnabled, classifiedFee, slotPack, businessShop:u&&businessAccount.get(u.id)?businessShop(u.id):null, listingAllowance:u?listingAllowance(u.id):null});
});
app.post('/api/business-account', requireUser, (req,res) => {
 openBusiness.run(req.session.userId);
 res.json({listingAllowance:listingAllowance(req.session.userId)});
});
app.post('/api/register', authLimiter, screenContent(['name']), async (req,res) => {
 const {name,email,password,accountType} = req.body || {};
 if (!name || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !password || password.length<10)
  return res.status(400).json({error:'Enter your name, a valid email and a password of at least 10 characters.'});
 try {
  const hash = await bcrypt.hash(password,12);
  req.session.userId = db.transaction(() => {
   const info = db.prepare('INSERT INTO users (name,email,password_hash) VALUES (?,?,?)').run(name.trim(),email.toLowerCase(),hash);
   const id = Number(info.lastInsertRowid);
   if(accountType==='business') openBusiness.run(id);
   return id;
  })();
  res.json({user:safeUser(db.prepare('SELECT * FROM users WHERE id=?').get(req.session.userId))});
 } catch(e) { res.status(409).json({error:'That email address may already be registered.'}); }
});
app.post('/api/login', authLimiter, async (req,res) => {
 const {email,password} = req.body || {};
 const u = db.prepare('SELECT * FROM users WHERE email=?').get(String(email||'').toLowerCase());
 if (!u || !(await bcrypt.compare(password||'',u.password_hash))) return res.status(401).json({error:'Email or password is incorrect.'});
 req.session.userId = u.id; res.json({user:safeUser(u)});
});
app.post('/api/logout', (req,res) => req.session.destroy(() => res.json({ok:true})));
app.get('/api/listings', (req,res) => {
 const {q,category,subcategory,condition,sort,type} = req.query;
 let sql = listingQuery + ` WHERE l.status='active'`;
 const args = [];
 if(q){sql += ' AND (l.title LIKE ? OR l.description LIKE ?)';args.push(`%${q}%`,`%${q}%`);}
 if(category && category!=='All'){sql += ' AND l.category=?';args.push(category);}
 if(subcategory){sql += ' AND l.subcategory=?';args.push(subcategory);}
 if(condition){sql += ' AND l.condition=?';args.push(condition);}
 if(['fixed','auction','classified'].includes(type)){sql += ' AND l.listing_type=?';args.push(type);}
 if(sort==='low') sql += ' ORDER BY l.price_pence ASC';
 else if(sort==='high') sql += ' ORDER BY l.price_pence DESC';
 else sql += ' ORDER BY l.created_at DESC,l.id DESC';
 res.json(db.prepare(sql).all(...args).map(x=>({...x,price:x.price_pence/100,current_bid:x.current_bid ? x.current_bid/100 : null})));
});
const photosFor = db.prepare('SELECT image FROM listing_photos WHERE listing_id=? ORDER BY id');
function listingPhotos(item) {
 const cover = item.image?.startsWith('/uploads/') ? [item.image] : [];
 return [...cover,...photosFor.all(item.id).map(photo=>photo.image)];
}
function listingDetails(item) {
 return {...item,can_edit:editable(item),price:item.price_pence/100,photos:listingPhotos(item),
  current_bid:item.current_bid ? item.current_bid/100 : null};
}
const normalizeDescription = value => value.normalize('NFKC').trim().replace(/\s+/g,' ').toLowerCase();
db.function('normalize_description',{deterministic:true},normalizeDescription);
const duplicateCandidates = db.prepare(`
 SELECT id,image FROM listings
 WHERE seller_id=? AND id!=? AND status IN ('active','reserved','awaiting_fee')
  AND (listing_type!='auction' OR status!='active' OR julianday(ends_at)>julianday('now')
       OR EXISTS (SELECT 1 FROM bids WHERE listing_id=listings.id))
  AND normalize_description(description)=?
`);
function photoHash(image) {
 try {
  return createHash('sha256').update(fs.readFileSync(path.join(UPLOADS,path.basename(image)))).digest('hex');
 } catch(error) {
  if(error.code!=='ENOENT')throw error;
  return null;
 }
}
function duplicateListing(seller,id,description,photos) {
 const candidates = duplicateCandidates.all(seller,id,normalizeDescription(description));
 if(!candidates.length)return false;
 const hashes = new Set(photos.map(photoHash).filter(Boolean));
 return candidates.some(candidate=>{
  const existing = listingPhotos(candidate);
  return (!photos.length && !existing.length) || existing.some(photo=>hashes.has(photoHash(photo)));
 });
}
const duplicateMessage = 'You already have a listing with this description and matching photos, or with the same description and no photos. Edit the existing listing instead.';
app.get('/api/my-listings', requireUser, (req,res) => {
 const listings = db.prepare(listingQuery+' WHERE l.seller_id=? ORDER BY l.id DESC').all(req.session.userId);
 res.json(listings.map(listingDetails));
});
const findOwned = db.prepare(listingQuery+' WHERE l.id=? AND l.seller_id=?');
function editable(item) {
 return (['active','awaiting_fee'].includes(item.status) || (item.listing_type==='fixed' && item.status==='sold')) &&
  (item.listing_type!=='auction' || (!item.current_bid && Date.parse(item.ends_at)>Date.now()));
}
const addPhotos = upload.array('photos', 8);
app.patch('/api/listings/:id', requireUser, (req,res,next) => {
 const item = findOwned.get(req.params.id,req.session.userId);
 if(!item) return res.status(404).json({error:'Listing not found.'});
 if(!editable(item)) return res.status(409).json({error:'This listing can no longer be edited.'});
 addPhotos(req,res,error=>{
  if(error) return res.status(400).json({error:'Upload up to 8 JPG, PNG or WebP photos, each under 5 MB.'});
  next();
 });
}, screenContent(['title','description','category','subcategory','location'],{listing:true}), (req,res) => {
 const files = req.files || [];
 const fail = (status,error) => {
  for(const file of files) fs.rmSync(file.path,{force:true});
  return res.status(status).json({error});
 };
 const {title,description,category,subcategory,condition,price,location} = req.body;
 if(!validSubcategory(category,subcategory))return fail(400,'Choose a subcategory from the selected department.');
 const pence = pounds(price);
 const shipping = shippingPence(req.body.shipping);
 if(shipping===null)return fail(400,'Enter a valid shipping cost in pounds.');
 if(typeof title!=='string' || !title.trim() || title.length>100 ||
    typeof description!=='string' || !description.trim() || description.length>3000 ||
    typeof category!=='string' || !category.trim() || category.length>100 ||
    !['New','Used'].includes(condition) || !Number.isSafeInteger(pence) || pence<1 ||
    typeof location!=='string' || location.length>100) {
  return fail(400,'Enter valid listing details and price.');
 }
 try {
  const updated = db.transaction(()=>{
   const item = findOwned.get(req.params.id,req.session.userId);
   if(!item || !editable(item)) return 'This listing can no longer be edited.';
   if(req.body.expected_quantity!==undefined && Number(req.body.expected_quantity)!==item.available_quantity)
    return 'Stock changed while editing. Reload your listing before updating the quantity.';
   const quantity = item.listing_type==='fixed' && req.body.quantity!==undefined
    ? listingQuantity(req.body.quantity) : item.available_quantity;
   if(quantity===null || (item.status==='sold' && quantity<1))return 'Enter an available quantity from 1 to 9,999.';
   if(item.status==='sold'){
    const allowance=listingAllowance(item.seller_id);
    if(allowance && (!businessShop(item.seller_id).active || allowance.used>=allowance.limit))
     return 'An active Business Shop and an available slot are required to restock this listing.';
   }
   const existingPhotos = listingPhotos(item);
   if(existingPhotos.length+files.length>8) return 'A listing can have up to 8 photos.';
   const paths = files.map(file=>'/uploads/'+file.filename);
   if(duplicateListing(item.seller_id,item.id,description,[...existingPhotos,...paths])) return duplicateMessage;
   const cover = item.image?.startsWith('/uploads/') ? item.image : paths.shift() || item.image;
   db.prepare('UPDATE listings SET title=?,description=?,category=?,subcategory=?,condition=?,price_pence=?,shipping_pence=?,location=?,image=?,available_quantity=?,status=? WHERE id=?')
    .run(title.trim(),description.trim(),category.trim(),subcategory??(category===item.category?item.subcategory:''),condition,pence,req.body.shipping===undefined?item.shipping_pence:shipping,location.trim()||'United Kingdom',cover,quantity,item.status==='sold'?'active':item.status,item.id);
   const add = db.prepare('INSERT INTO listing_photos (listing_id,image) VALUES (?,?)');
   for(const photo of paths) add.run(item.id,photo);
   return null;
  }).immediate();
  if(updated) return fail(409,updated);
 } catch(error) {
  console.error(error.message);
  return fail(500,'Could not save the listing.');
 }
 res.json(listingDetails(findOwned.get(req.params.id,req.session.userId)));
});
app.get('/api/listings/:id', (req,res) => {
 const item = db.prepare(listingQuery+' WHERE l.id=?').get(req.params.id);
 if(!item || (item.listing_type==='classified' && item.status!=='active'))
  return res.status(404).json({error:'Listing not found.'});
 res.json(listingDetails(item));
});
app.post('/api/listings', requireUser, upload.single('image'), screenContent(['title','description','category','subcategory','location'],{listing:true}), (req,res) => {
 const {title,description,category,subcategory,condition,price,listing_type,location,ends_at} = req.body;
 if(!validSubcategory(category,subcategory) || (subcategory!==undefined && !Object.hasOwn(categories,category))){
  if(req.file)fs.rmSync(req.file.path,{force:true});
  return res.status(400).json({error:'Choose a department and matching subcategory.'});
 }
 const p = pounds(price);
 const shipping = shippingPence(req.body.shipping);
 if(shipping===null){
  if(req.file)fs.rmSync(req.file.path,{force:true});
  return res.status(400).json({error:'Enter a valid shipping cost in pounds.'});
 }
 if(!title || title.length>100 || !description || description.length>3000 || !category || !['New','Used'].includes(condition) || !Number.isInteger(p) || p<1)
  return res.status(400).json({error:'Please complete all required listing details and enter a valid price.'});
 if(!['fixed','auction','classified'].includes(listing_type)) return res.status(400).json({error:'Choose a valid listing format.'});
 if(listing_type==='auction' && (!ends_at || new Date(ends_at)<=new Date())) return res.status(400).json({error:'Choose a future auction end date.'});
 const quantity = listing_type==='fixed' ? listingQuantity(req.body.quantity) : 1;
 if(quantity===null){
  if(req.file)fs.rmSync(req.file.path,{force:true});
  return res.status(400).json({error:'Enter an available quantity from 1 to 9,999.'});
 }
 const classified = listing_type==='classified';
 if(classified && (!classifiedFee || Number(req.body.classified_fee) !== classifiedFee)){
  return res.status(400).json({error:'Confirm the current listing fee.'});
 }
 const result = db.transaction(() => {
  const owner = req.session.userId;
  const photos = req.file?['/uploads/'+req.file.filename]:[];
  if(duplicateListing(owner,0,description,photos)) return {error:duplicateMessage};
  const allowance = listingAllowance(owner);
  if(allowance && !businessShop(owner).active) return {error:'Activate your £24 Business Shop under Your account before publishing.'};
  if(allowance && allowance.used>=allowance.limit) return {error:'Your Business listing slots are in use. Add more under Your account and try again.'};
  const info = db.prepare(`INSERT INTO listings (seller_id,title,description,category,subcategory,condition,price_pence,shipping_pence,listing_type,image,location,ends_at,status,available_quantity)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(owner,title.trim(),description.trim(),category,subcategory||'',condition,p,shipping,listing_type,
   req.file?'/uploads/'+req.file.filename:null,(location||'United Kingdom').trim(),
   listing_type==='auction'?new Date(ends_at).toISOString():null,classified?'awaiting_fee':'active',quantity);
  const id = Number(info.lastInsertRowid);
  if(!classified) return {id};
  const feeOrderId = Number(db.prepare('INSERT INTO orders (buyer_id,total_pence) VALUES (?,?)')
   .run(owner,classifiedFee).lastInsertRowid);
  db.prepare('INSERT INTO paypal_orders (order_id,request_id,merchant_id) VALUES (?,?,?)')
   .run(feeOrderId,require('node:crypto').randomUUID(),process.env.PAYPAL_PARTNER_MERCHANT_ID);
  db.prepare('INSERT INTO classified_ads (listing_id,contact_email,fee_order_id) VALUES (?,?,?)')
   .run(id,'',feeOrderId);
  return {id,feeOrderId};
 }).immediate();
 if(result.error){
  if(req.file) fs.rmSync(req.file.path,{force:true});
  return res.status(409).json({error:result.error});
 }
 res.status(201).json(result);
});
app.post('/api/listings/:id/bids', requireUser, (req,res) => {
 const item = db.prepare(`SELECT * FROM listings WHERE id=? AND status='active'`).get(req.params.id);
 const amount = pounds(req.body.amount);
 if(!item || item.listing_type!=='auction' || !item.ends_at || new Date(item.ends_at)<=new Date()) return res.status(400).json({error:'This auction is not open.'});
 if(item.seller_id===req.session.userId) return res.status(400).json({error:'You cannot bid on your own item.'});
 const top = db.prepare('SELECT MAX(amount_pence) AS amount FROM bids WHERE listing_id=?').get(item.id).amount || item.price_pence;
 if(!Number.isInteger(amount) || amount<=top) return res.status(400).json({error:`Your bid must be higher than £${(top/100).toFixed(2)}.`});
 db.prepare('INSERT INTO bids (listing_id,bidder_id,amount_pence) VALUES (?,?,?)').run(item.id,req.session.userId,amount);
 res.json({ok:true,current_bid:amount/100});
});
app.post('/api/checkout', requireUser, (req,res) => {
 if(paymentsEnabled) return res.status(409).json({error:'Use PayPal checkout.'});
 const ids = Array.isArray(req.body.listingIds) ? [...new Set(req.body.listingIds.map(Number))] : [];
 if(!ids.length || ids.length>30) return res.status(400).json({error:'Your basket is empty or too large.'});
 const order = db.transaction(()=>{
  const items = ids.map(id=>db.prepare(`SELECT * FROM listings WHERE id=? AND status='active' AND listing_type='fixed'`).get(id));
  if(items.some(x=>!x)) return {error:'One or more items are no longer available.'};
  if(items.some(x=>x.seller_id===req.session.userId)) return {error:'You cannot buy your own listing.'};
  for(const item of items){
   item.quantity=orderQuantity(req.body.quantities,item.id);
   if(!item.quantity || item.quantity>item.available_quantity)return {error:'The requested quantity is unavailable.'};
  }
  const total = items.reduce((s,x)=>s+(x.price_pence+x.shipping_pence)*x.quantity,0);
  const o = db.prepare('INSERT INTO orders (buyer_id,total_pence,status) VALUES (?,?,?)').run(req.session.userId,total,'payment_pending');
  const add = db.prepare('INSERT INTO order_items (order_id,listing_id,seller_id,title_snapshot,unit_price_pence,shipping_pence,quantity) VALUES (?,?,?,?,?,?,?)');
  items.forEach(x=>{add.run(o.lastInsertRowid,x.id,x.seller_id,x.title,x.price_pence,x.shipping_pence,x.quantity);reserveStock.run({id:x.id,quantity:x.quantity});});
  return {orderId:Number(o.lastInsertRowid),total};
 }).immediate();
 if(order.error)return res.status(400).json({error:order.error});
 res.status(202).json({orderId:order.orderId,total:order.total/100,status:'payment_pending',message:'Order prepared. Payment is not enabled in this starter build; listings are reserved for admin review.'});
});
app.get('/api/orders', requireUser, (req,res) => {
 const rows = db.prepare(`SELECT o.*, ${paymentsEnabled ? 'EXISTS(SELECT 1 FROM paypal_orders p WHERE p.order_id=o.id)' : '0'} AS paypal_order, (SELECT l.title FROM classified_ads c JOIN listings l ON l.id=c.listing_id WHERE c.fee_order_id=o.id) AS classified_title, (SELECT slots FROM business_slot_orders WHERE order_id=o.id) AS slot_pack, EXISTS(SELECT 1 FROM business_shop_orders WHERE order_id=o.id) AS shop_order, GROUP_CONCAT(oi.title_snapshot,' • ') AS items FROM orders o LEFT JOIN order_items oi ON oi.order_id=o.id WHERE o.buyer_id=? GROUP BY o.id ORDER BY o.id DESC`).all(req.session.userId);
 res.json(rows.map(x=>({...x,total:x.total_pence/100})));
});
app.get('/api/admin/summary', requireUser, requireAdmin, (req,res) => {
 res.json({
  users:db.prepare('SELECT COUNT(*) n FROM users').get().n,
  activeListings:db.prepare(`SELECT COUNT(*) n FROM listings WHERE status='active'`).get().n,
  orders:db.prepare('SELECT COUNT(*) n FROM orders').get().n,
  pendingPayments:db.prepare(`SELECT COUNT(*) n FROM orders WHERE status='payment_pending'`).get().n
 });
});
app.get('/health', (_req, res) => {
 db.prepare('SELECT 1').get();
 res.json({status:'ok'});
});
app.use(express.static(path.join(ROOT,'public')));
app.get('*', (req,res) => res.sendFile(path.join(ROOT,'public','index.html')));
app.listen(PORT,'0.0.0.0',()=>console.log(`goforsale.co.uk running at http://localhost:${PORT}`));
