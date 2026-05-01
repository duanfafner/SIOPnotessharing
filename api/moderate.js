const { buildTextModerationPrompt, parseModerationResponse } = require('./moderation-shared');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const anthropicKey = process.env.ANTHROPIC_KEY;
  if (!anthropicKey) {
    return res.status(500).json({ error: 'ANTHROPIC_KEY is not configured' });
  }

  const text = typeof req.body?.text === 'string' ? req.body.text : '';
  if (!text.trim()) {
    return res.status(400).json({ error: 'Missing text' });
  }

  const prompt = buildTextModerationPrompt(text);

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL_MODERATION || 'claude-sonnet-4-20250514',
        max_tokens: 100,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      const details = await response.text();
      return res.status(response.status).json({ error: details });
    }

    const data = await response.json();
    const raw = data?.content?.[0]?.text;
    const parsed = parseModerationResponse(raw);
    return res.status(200).json({
      pass: parsed.pass,
      reason: parsed.reason,
    });
  } catch (error) {
    return res.status(500).json({ error: 'Moderation service error' });
  }
};
