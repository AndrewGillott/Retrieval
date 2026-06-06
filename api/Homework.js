export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
 
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    if (!token) return res.status(401).json({ error: 'Not authenticated' });
 
    const userResp = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
      headers: { 'Authorization': `Bearer ${token}`, 'apikey': process.env.SUPABASE_PUBLISHABLE_KEY }
    });
    if (!userResp.ok) return res.status(401).json({ error: 'Invalid session' });
    const userData = await userResp.json();
    if (!userData.id) return res.status(401).json({ error: 'Could not verify user' });
 
    const { topics, tier, spec_label, class_id } = req.body;
    if (!topics || !topics.length) return res.status(400).json({ error: 'No topics provided' });
 
    // Spaced repetition weighting
    const now = Date.now();
    const DAY = 86400000;
    const weighted = topics.map(t => {
      const taught = t.taught_date ? new Date(t.taught_date).getTime() : now;
      const daysAgo = Math.max(1, (now - taught) / DAY);
      let weight = Math.log(daysAgo + 1);
      if (t.avg_pct !== null && t.avg_pct !== undefined && t.avg_pct < 60) weight *= 1.8;
      if (daysAgo < 3) weight *= 0.3;
      return { ...t, weight };
    });
 
    const total = Math.min(15, Math.max(10, Math.floor(topics.length * 0.5)));
    const recall = Math.round(total * 0.4);
    const apply = Math.round(total * 0.35);
    const extend = total - recall - apply;
    const mcCount = Math.round(recall * 0.5);
 
    const selected = weightedSample(weighted, Math.min(weighted.length, total));
    const specList = selected.map(t => t.text).join('\n');
    const specName = spec_label || 'AQA GCSE Combined Science: Trilogy';
 
    // Helper to call Claude
    async function callClaude(prompt, maxTokens = 3000) {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: maxTokens,
          system: `You are an expert teacher for ${specName}. Return ONLY valid JSON arrays — no markdown, no preamble, no extra text.`,
          messages: [{ role: 'user', content: prompt }]
        })
      });
      if (!r.ok) throw new Error(`API error ${r.status}`);
      const d = await r.json();
      let txt = d.content.filter(c => c.type === 'text').map(c => c.text).join('');
      txt = txt.replace(/```json|```/g, '').trim();
      // Repair if truncated
      if (!txt.endsWith(']')) {
        const last = txt.lastIndexOf('}');
        if (last > -1) txt = txt.substring(0, last + 1) + ']';
      }
      return JSON.parse(txt);
    }
 
    // Call 1: Recall questions
    const recallPrompt = `Generate exactly ${recall} recall questions for ${specName} (${tier} tier).
Spec points: ${specList}
- ${mcCount} must be multiple choice (type "mc"), ${recall - mcCount} must be short answer (type "short")
- Test direct recall: definitions, facts, equations, named examples
- Model answers should be 1-2 sentences using spec language
- Keep questions and answers concise
 
Return a JSON array only:
[{"type":"mc","difficulty":"recall","spec_id":"6.2.2a","topic":"topic","question":"...","options":["A) ...","B) ...","C) ...","D) ..."],"answer":"B","model_answer":"..."},{"type":"short","difficulty":"recall","spec_id":"6.1.1","topic":"topic","question":"...","model_answer":"..."}]`;
 
    // Call 2: Application + Explanation questions
    const applyCount = apply + extend;
    const applyPrompt = `Generate exactly ${applyCount} questions for ${specName} (${tier} tier) — split ${apply} application and ${extend} explanation/analysis.
Spec points: ${specList}
- All short answer (type "short")
- Application: calculations, and short explain questions (difficulty "application")
- Explanation/analysis: extended explain, evaluate or compare questions (difficulty "explanation")
- Model answers: 2-4 sentences, use spec language
- Keep answers concise but complete
 
Return a JSON array only:
[{"type":"short","difficulty":"application","spec_id":"6.1.2a","topic":"topic","question":"...","model_answer":"..."},{"type":"short","difficulty":"explanation","spec_id":"6.2.7","topic":"topic","question":"...","model_answer":"..."}]`;
 
    let recallQs, applyQs;
    try {
      [recallQs, applyQs] = await Promise.all([
        callClaude(recallPrompt, 2500),
        callClaude(applyPrompt, 3000)
      ]);
    } catch (e) {
      return res.status(500).json({ error: 'Could not generate questions. Please try again. (' + e.message + ')' });
    }
 
    const allQuestions = [...recallQs, ...applyQs];
    if (!allQuestions.length) return res.status(500).json({ error: 'No questions returned' });
 
    // Save to homework table
    const saveResp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/homework`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'apikey': process.env.SUPABASE_PUBLISHABLE_KEY,
        'Prefer': 'return=representation'
      },
      body: JSON.stringify({ class_id, questions: allQuestions, tier })
    });
 
    const saved = await saveResp.json();
    const homework_id = Array.isArray(saved) ? saved[0]?.id : saved?.id;
 
    return res.status(200).json({ questions: allQuestions, homework_id });
 
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
 
function weightedSample(items, n) {
  const result = [];
  const pool = [...items];
  for (let i = 0; i < Math.min(n, pool.length); i++) {
    const totalWeight = pool.reduce((s, x) => s + x.weight, 0);
    let rand = Math.random() * totalWeight;
    for (let j = 0; j < pool.length; j++) {
      rand -= pool[j].weight;
      if (rand <= 0) {
        result.push(pool[j]);
        pool.splice(j, 1);
        break;
      }
    }
  }
  return result;
}
 
