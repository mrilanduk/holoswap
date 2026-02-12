const jwt = require('jsonwebtoken');

function auth(req, res, next) {
  let token = null;

  // Check Authorization header first
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    token = header.split(' ')[1];
  }

  // Fallback: check query param (for window.open downloads like label PDFs)
  if (!token && req.query.token) {
    token = req.query.token;
  }

  if (!token) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

module.exports = auth;
