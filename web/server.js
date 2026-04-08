require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const express = require('express');
const session = require('express-session');
const nunjucks = require('nunjucks');
const path = require('path');

const authRouter = require('./routes/auth');
const raidsRouter = require('./routes/raids');
const charactersRouter = require('./routes/characters');

const app = express();

// Session
app.use(
  session({
    secret: process.env.WEB_SECRET_KEY || 'change_this_to_a_random_string',
    resave: false,
    saveUninitialized: false,
  })
);

// Nunjucks
const templateDir = path.join(__dirname, 'templates');
const njkEnv = nunjucks.configure(templateDir, {
  autoescape: true,
  express: app,
});

// dateformat filter: supports "%Y-%m-%d %H:%M", "%A, %d %B %Y %H:%M UTC", "%Y-%m-%d"
njkEnv.addFilter('dateformat', (value, fmt) => {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return String(value);

  const pad = n => String(n).padStart(2, '0');
  const year = d.getUTCFullYear();
  const month = pad(d.getUTCMonth() + 1);
  const day = pad(d.getUTCDate());
  const hours = pad(d.getUTCHours());
  const minutes = pad(d.getUTCMinutes());

  if (fmt === '%Y-%m-%d %H:%M') {
    return `${year}-${month}-${day} ${hours}:${minutes}`;
  }

  if (fmt === '%Y-%m-%d') {
    return `${year}-${month}-${day}`;
  }

  if (fmt === '%A, %d %B %Y %H:%M UTC') {
    const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const months = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December',
    ];
    const weekday = weekdays[d.getUTCDay()];
    const monthName = months[d.getUTCMonth()];
    return `${weekday}, ${day} ${monthName} ${year} ${hours}:${minutes} UTC`;
  }

  // Fallback: ISO
  return d.toISOString();
});

// int filter
njkEnv.addFilter('int', val => Math.floor(Number(val)) || 0);

// Routes
app.use('/auth', authRouter);
app.use('/raids', raidsRouter);
app.use('/', charactersRouter);

// Root redirect
app.get('/', (req, res) => {
  if (req.session.user_id) {
    res.redirect('/raids');
  } else {
    res.redirect('/auth/login');
  }
});

const PORT = 8000;
app.listen(PORT, () => {
  console.log(`Web server listening on port ${PORT}`);
});
