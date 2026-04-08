const express = require('express');
const crypto = require('crypto');
const fetch = require('node-fetch');
const { URLSearchParams } = require('url');

const router = express.Router();

const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || '';
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || '';
const DISCORD_REDIRECT_URI = process.env.DISCORD_REDIRECT_URI || 'http://localhost:8000/auth/callback';
const DISCORD_OAUTH_URL = 'https://discord.com/api/oauth2/authorize';
const DISCORD_TOKEN_URL = 'https://discord.com/api/oauth2/token';
const DISCORD_USER_URL = 'https://discord.com/api/users/@me';

router.get('/login', (req, res) => {
  const state = crypto.randomBytes(32).toString('hex');
  req.session.oauth_state = state;

  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: DISCORD_REDIRECT_URI,
    response_type: 'code',
    scope: 'identify',
    state,
  });

  res.redirect(`${DISCORD_OAUTH_URL}?${params.toString()}`);
});

router.get('/callback', async (req, res) => {
  const { code, state } = req.query;

  if (!code) return res.redirect('/auth/login');

  const expectedState = req.session.oauth_state;
  delete req.session.oauth_state;

  if (!expectedState || state !== expectedState) return res.redirect('/auth/login');

  try {
    const tokenRes = await fetch(DISCORD_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: DISCORD_REDIRECT_URI,
      }),
    });

    if (!tokenRes.ok) return res.redirect('/auth/login');
    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;

    const userRes = await fetch(DISCORD_USER_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!userRes.ok) return res.redirect('/auth/login');
    const userData = await userRes.json();

    req.session.user_id = userData.id;
    req.session.username = userData.username;
    req.session.avatar = userData.avatar || null;
    req.session.flash = `Welcome, ${userData.username}!`;

    res.redirect('/raids');
  } catch (_err) {
    res.redirect('/auth/login');
  }
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/auth/login');
  });
});

module.exports = router;
