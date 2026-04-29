module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const anthropicKey = process.env.ANTHROPIC_KEY;
  if (!anthropicKey) {
    return res.status(500).json({ error: 'ANTHROPIC_KEY is not configured' });
  }

  const imageUrl = typeof req.body?.imageUrl === 'string' ? req.body.imageUrl : '';
  const fileName = typeof req.body?.fileName === 'string' ? req.body.fileName : 'attachment';
  if (!imageUrl) {
    return res.status(400).json({ error: 'Missing imageUrl' });
  }

  try {
    const imageRes = await fetch(imageUrl);
    if (!imageRes.ok) {
      return res.status(400).json({ error: 'Unable to fetch image' });
    }

    const contentType = imageRes.headers.get('content-type') || 'image/jpeg';
    if (!contentType.startsWith('image/')) {
      return res.status(400).json({ error: 'Attachment is not an image' });
    }

    const imageBuffer = Buffer.from(await imageRes.arrayBuffer());
    const base64Image = imageBuffer.toString('base64');

    const prompt = `Read this conference note image attachment (${fileName}) and extract the meaningful text content.
Return a concise plain-text summary in 4-8 bullet points.
If the image has little or no readable text, say that briefly.`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL_OCR || 'claude-sonnet-4-20250514',
        max_tokens: 500,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: contentType,
                  data: base64Image,
                },
              },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      const details = await response.text();
      return res.status(response.status).json({ error: details });
    }

    const data = await response.json();
    const summary = data?.content?.[0]?.text || '';
    return res.status(200).json({ summary });
  } catch (error) {
    return res.status(500).json({ error: 'Image extraction failed' });
  }
};
