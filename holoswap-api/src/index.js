require('dotenv').config();
const express = require('express');
const cors = require('cors');

const waitlistRoutes = require('./routes/waitlist');
const authRoutes = require('./routes/auth');
const cardsRoutes = require('./routes/cards');
const wantsRoutes = require('./routes/wants');
const profileRoutes = require('./routes/profile');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
}));

// Trust proxy for correct IP logging (behind Coolify/nginx)
app.set('trust proxy', true);

// Routes
app.use('/api/waitlist', waitlistRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/cards', cardsRoutes);
app.use('/api/wants', wantsRoutes);
app.use('/api/profile', profileRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'holoswap-api', timestamp: new Date().toISOString() });
});

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Start
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 HoloSwap API running on port ${PORT}`);
  console.log(`   Health:   GET  /health`);
  console.log(`   Waitlist: POST /api/waitlist`);
  console.log(`   Auth:     POST /api/auth/register`);
  console.log(`             POST /api/auth/login`);
  console.log(`   Profile:  GET  /api/profile`);
  console.log(`             PUT  /api/profile`);
  console.log(`   Cards:    GET  /api/cards`);
  console.log(`             POST /api/cards`);
  console.log(`   Wants:    GET  /api/wants`);
  console.log(`             POST /api/wants\n`);
});
