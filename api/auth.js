module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const sitePassword = process.env.SITE_PASSWORD;
  if (!sitePassword) {
    return res.status(500).json({ error: 'SITE_PASSWORD is not configured' });
  }

  let provided = '';
  const contentType = req.headers['content-type'] || '';
  if (contentType.includes('application/json')) {
    provided = String(req.body?.password || '');
  } else if (contentType.includes('application/x-www-form-urlencoded')) {
    provided = String(req.body?.password || '');
  } else {
    provided = String(req.body?.password || '');
  }

  if (provided !== sitePassword) {
    return res.status(401).json({ error: 'Incorrect password' });
  }

  const maxAge = 60 * 60 * 24 * 7; // 7 days
  const isProd = process.env.NODE_ENV === 'production';
  const secureFlag = isProd ? '; Secure' : '';
  res.setHeader('Set-Cookie', [
    `siop_access=${sitePassword}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureFlag}`,
    `siop_access_client=1; Path=/; SameSite=Lax; Max-Age=${maxAge}${secureFlag}`,
  ]);
  return res.status(200).json({ ok: true });
};
