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

  const prompt = `You are moderating content for the SIOP 2026 Annual Conference notes hub - a professional I-O psychology academic conference.

Legitimate topics include: workplace psychology, AI in assessment, DEI research, leadership, selection and assessment, performance management, well-being, statistics, coaching, mentoring, HR tech, and related academic/practitioner content.

Content to review:
"${text}"

Is this appropriate for a professional academic conference platform?

REJECT if it contains: profanity, sexual content, hate speech, spam, personal attacks, or content completely unrelated to work/psychology.
APPROVE if it is professional, relevant, or even tangentially related to the conference themes.

Respond ONLY with valid JSON (no markdown): {"pass": true, "reason": ""} or {"pass": false, "reason": "brief reason"}`;

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
    const raw = data?.content?.[0]?.text || '{"pass":true,"reason":""}';
    const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    return res.status(200).json({
      pass: Boolean(parsed?.pass),
      reason: parsed?.reason || '',
    });
  } catch (error) {
    return res.status(500).json({ error: 'Moderation service error' });
  }
};
