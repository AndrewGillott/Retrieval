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
 
    async function callClaude(systemMsg, userMsg) {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 3000,
          system: systemMsg,
          messages: [{ role: 'user', content: userMsg }]
        })
      });
      if (!r.ok) {
        const errText = await r.text();
        throw new Error(`API ${r.status}: ${errText.slice(0, 200)}`);
      }
      const d = await r.json();
      // Check stop reason
      if (d.stop_reason === 'max_tokens') {
        throw new Error('Response was cut off — too many tokens. Try with fewer spec points.');
      }
      let txt = d.content.filter(c => c.type === 'text').map(c => c.text).join('');
      txt = txt.replace(/```json|```/g, '').trim();
      try {
        return JSON.parse(txt);
      } catch(e) {
        throw new Error('JSON parse failed. Raw: ' + txt.slice(0, 300));
      }
    }
 
    const sysMsg = `You are an expert ${specName} teacher. Return ONLY a valid JSON array — no markdown fences, no explanation, no text before or after the array. Start your response with [ and end with ].`;
 
    const recallPrompt = `Generate exactly ${recall} recall questions for ${specName} (${tier} tier).
Spec points to use: ${specList}
 
Requirements:
- ${mcCount} multiple choice (type "mc"), ${recall - mcCount} short answer (type "short")  
- Test direct recall: definitions, facts, equations only
- Keep model answers to 1 sentence maximum
- difficulty field must be "recall"
 
JSON array format (return ONLY the array, nothing else):
[{"type":"mc","difficulty":"recall","spec_id":"6.2.2a","topic":"Resistance","question":"What is the unit of resistance?","options":["A) Volt","B) Ampere","C) Ohm","D) Watt"],"answer":"C","model_answer":"The unit of resistance is the ohm (Ω)."},{"type":"short","difficulty":"recall","spec_id":"6.1.1","topic":"Energy stores","question":"State two examples of energy stores.","model_answer":"Kinetic energy store and gravitational potential energy store."}]`;
 
    const applyExtendPrompt = `Generate exactly ${apply + extend} questions for ${specName} (${tier} tier).
Spec points to use: ${specList}
 
Requirements:
- ${apply} application questions (difficulty "application"): calculations or short explanations, 1-2 sentence answers
- ${extend} explanation questions (difficulty "explanation"): extended explain/evaluate, 2-3 sentence answers
- All short answer (type "short")
 
JSON array format (return ONLY the array, nothing else):
[{"type":"short","difficulty":"application","spec_id":"6.1.2a","topic":"Kinetic energy","question":"Calculate the kinetic energy of a 2 kg object moving at 3 m/s.","model_answer":"Ek = ½mv² = ½ × 2 × 3² = 9 J."},{"type":"short","difficulty":"explanation","spec_id":"6.2.7","topic":"National Grid","question":"Explain why the National Grid uses a high voltage for transmission.","model_answer":"A high voltage means a low current flows. A lower current reduces energy dissipated in the cables as heat, making transmission more efficient."}]`;
 
    let recallQs, applyQs;
    try {
      [recallQs, applyQs] = await Promise.all([
        callClaude(sysMsg, recallPrompt),
        callClaude(sysMsg, applyExtendPrompt)
      ]);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
 
    const allQuestions = [...(Array.isArray(recallQs) ? recallQs : []), ...(Array.isArray(applyQs) ? applyQs : [])];
    if (!allQuestions.length) return res.status(500).json({ error: 'No questions generated. Please try again.' });
 
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
