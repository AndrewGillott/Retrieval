import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // Verify user is logged in
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Not authenticated' });
    
    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) return res.status(401).json({ error: 'Invalid session' });

    const { topics, tier, total, mc, flagged, class_id } = req.body;

    let flagCtx = '';
    if (flagged && flagged.length) {
      flagCtx = '\n\nAlso rephrase and include at least one of these previously-weak questions:\n' + flagged.map(f => f.q).join('\n');
    }

    const specList = topics.map(t => t.text).join('\n');

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2500,
        system: `You are an expert AQA GCSE Combined Science: Trilogy teacher and examiner. You write precise retrieval practice questions that test exactly what the AQA specification states. You never go beyond the specification. Model answers use AQA specification language and definitions exactly. Return ONLY valid JSON with no markdown fences, no preamble, no commentary.`,
        messages: [{
          role: 'user',
          content: `Generate exactly ${total} retrieval practice questions for AQA GCSE Combined Science: Trilogy (${tier} tier).

The questions must be drawn from ONLY these specific AQA specification points:
${specList}

Rules:
- Questions must be directly tied to one of the above spec points
- ${mc} question(s) must be multiple choice (type: "mc"); ${total - mc} must be short answer (type: "short")
- Mix simple recall with conceptual questions
- ${tier === 'Higher' ? 'Include some application and explanation questions appropriate for Higher tier' : 'Keep questions accessible for Foundation tier'}
- Model answers must use exact AQA specification language and definitions
- Each question must include the specific spec point ID it comes from
- Do not repeat questions${flagCtx}

Return this exact JSON structure:
{"questions":[{"type":"mc","spec_id":"6.4.2a","topic":"short topic name","question":"...","options":["A) ...","B) ...","C) ...","D) ..."],"answer":"A","model_answer":"..."},{"type":"short","spec_id":"4.1.3b","topic":"short topic name","question":"...","model_answer":"..."}]}`
        }]
      })
    });

    if (!response.ok) {
      const err = await response.json();
      return res.status(500).json({ error: err.error?.message || 'API error' });
    }

    const data = await response.json();
    let txt = data.content.filter(c => c.type === 'text').map(c => c.text).join('');
    txt = txt.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(txt);

    // Save quiz to database
    if (class_id) {
      await supabase.from('quiz_history').insert({
        class_id,
        questions: parsed.questions,
        tier,
        quiz_type: 'classwork'
      });
    }

    return res.status(200).json(parsed);

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
