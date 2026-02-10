require('dotenv').config();
const express = require('express');
const cors = require('cors');

const waitlistRoutes = require('./routes/waitlist');
const authRoutes = require('./routes/auth');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST'],
}));

// Trust proxy for correct IP logging (behind Coolify/nginx)
app.set('trust proxy', true);

// Routes
app.use('/api/waitlist', waitlistRoutes);
app.use('/api/auth', authRoutes);

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
  console.log(`   Health: http://localhost:${PORT}/health`);
  console.log(`   Waitlist: POST http://localhost:${PORT}/api/waitlist`);
  console.log(`   Register: POST http://localhost:${PORT}/api/auth/register`);
  console.log(`   Login: POST http://localhost:${PORT}/api/auth/login\n`);
});
