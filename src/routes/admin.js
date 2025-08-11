// src/routes/admin.js
import express from 'express';
import passport from 'passport';
import Driver from '../models/Driver.js';
import Rider from '../models/Rider.js';
import { sendApprovalNotice } from '../bots/driverBot.js';

const router = express.Router();

/* ------------ helpers ------------ */
const ensureAdmin = (req, res, next) => {
  if (req.isAuthenticated && req.isAuthenticated()) {
    if (req.user?.constructor?.modelName === 'Admin') return next();
  }
  return res.redirect('/admin/login');
};
const ensureGuest = (req, res, next) => {
  if (req.isAuthenticated && req.isAuthenticated()) {
    if (req.user?.constructor?.modelName === 'Admin') return res.redirect('/admin');
  }
  return next();
};

/* ------------ auth screens ------------ */
router.get('/login', ensureGuest, (req, res) => {
  res.render('admin/login', { err: req.query.err || '' });
});
router.post(
  '/login',
  ensureGuest,
  passport.authenticate('local-admin', { failureRedirect: '/admin/login?err=Invalid%20credentials' }),
  (req, res) => res.redirect('/admin')
);
router.post('/logout', ensureAdmin, (req, res, next) => {
  req.logout(err => {
    if (err) return next(err);
    req.session?.destroy(() => res.redirect('/admin/login'));
  });
});

/* ------------ dashboard ------------ */
router.get('/', ensureAdmin, async (req, res) => {
  const [driverCounts, riderCount, drivers] = await Promise.all([
    Driver.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    Rider.countDocuments(),
    Driver.find().sort({ createdAt: -1 }).limit(10).lean()
  ]);

  const counts = { totalDrivers: 0, pending: 0, approved: 0, rejected: 0 };
  driverCounts.forEach(x => {
    counts.totalDrivers += x.count;
    counts[x._id] = x.count;
  });

  res.render('admin/dashboard', { admin: req.user, counts, riderCount, recentDrivers: drivers });
});

/* ------------ drivers list ------------ */
router.get('/drivers', ensureAdmin, async (req, res) => {
  const q = {};
  if (req.query.status) q.status = req.query.status;
  const drivers = await Driver.find(q).sort({ createdAt: -1 }).lean();
  res.render('admin/drivers', { admin: req.user, drivers });
});

/* ------------ single driver ------------ */
router.get('/drivers/:id', ensureAdmin, async (req, res) => {
  const d = await Driver.findById(req.params.id).lean();
  if (!d) return res.redirect('/admin/drivers');
  res.render('admin/driver', { admin: req.user, d });
});

/* ------------ approve / reject ------------ */
router.post('/drivers/:id/approve', ensureAdmin, async (req, res) => {
  const d = await Driver.findById(req.params.id);
  if (!d) return res.redirect('/admin/drivers');

  d.status = 'approved';
  d.approvedAt = new Date();
  // no more botPin
  await d.save();

  // Socket broadcast (optional UI update)
  const io = req.app.get('io');
  io?.emit('driver:approved', {
    driverId: String(d._id),
    chatId: d.chatId ?? null,
    name: d.name || ''
  });

  // Telegram DM — tell the driver they’re approved
  if (typeof d.chatId === 'number') {
    try {
      await sendApprovalNotice(d.chatId);
    } catch (e) {
      console.error('Failed to DM approval notice:', e?.message || e);
    }
  } else {
    console.warn(`⚠️ Approved driver ${d._id} has no chatId; cannot DM approval notice`);
  }

  return res.redirect(`/admin/drivers/${d._id}?ok=Approved`);
});

router.post('/drivers/:id/reject', ensureAdmin, async (req, res) => {
  const d = await Driver.findById(req.params.id);
  if (!d) return res.redirect('/admin/drivers');

  d.status = 'rejected';
  await d.save();

  const io = req.app.get('io');
  io?.emit('driver:rejected', { driverId: String(d._id), name: d.name || '' });

  return res.redirect(`/admin/drivers/${d._id}?ok=Rejected`);
});

export default router;
