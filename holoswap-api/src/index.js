require('dotenv').config();
const express = require('express');
const cors = require('cors');

const waitlistRoutes = require('./routes/waitlist');
const authRoutes = require('./routes/auth');
const cardsRoutes = require('./routes/cards');
const wantsRoutes = require('./routes/wants');
const profileRoutes = require('./routes/profile');
const searchRoutes = require('./routes/search');
const adminRoutes = require('./routes/admin');
const tradesRoutes = require('./routes/trades');
const shippingRoutes = require('./routes/shipping');
const bindersRoutes = require('./routes/binders');
const pricingRoutes = require('./routes/pricing');
const vendingRoutes = require('./routes/vending');
const watchlistRoutes = require('./routes/watchlist');
const sellerRoutes = require('./routes/seller-submissions');
const { startPriceMonitor } = require('./jobs/price-monitor');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
}));

app.set('trust proxy', true);

app.use('/api/waitlist', waitlistRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/cards', cardsRoutes);
app.use('/api/wants', wantsRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/trades', tradesRoutes);
app.use('/api/shipping', shippingRoutes);
app.use('/api/binders', bindersRoutes);
app.use('/api/pricing', pricingRoutes);
app.use('/api/vending', vendingRoutes);
app.use('/api/watchlist', watchlistRoutes);
app.use('/api/seller', sellerRoutes);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'holoswap-api', timestamp: new Date().toISOString() });
});

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('HoloSwap API running on port ' + PORT);
  startPriceMonitor();
});
