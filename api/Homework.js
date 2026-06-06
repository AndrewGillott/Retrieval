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
    const shortRecall = recall - mcCount;
 
    const selected = weightedSample(weighted, Math.min(weighted.length, total));
    const specList = selected.map(t => t.text).join('\n');
    const specName = spec_label || 'AQA GCSE Combined Science: Trilogy';
 
    const apiResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 5000,
        system: `You are an expert ${specName} teacher. You write concise retrieval homework questions. Return ONLY a valid JSON array starting with [ and ending with ]. No markdown, no explanation, no other text.`,
        messages: [{
          role: 'user',
          content: `Generate exactly ${total} homework questions for ${specName} (${tier} tier) drawn from these spec points:
${specList}
 
Structure (in this order):
- ${mcCount} multiple choice recall questions (type:"mc", difficulty:"recall") — test definitions, facts, equations
- ${shortRecall} short answer recall questions (type:"short", difficulty:"recall") — 1 sentence model answers
- ${apply} short answer application questions (type:"short", difficulty:"application") — calculations or short explanations, 2 sentence max model answers  
- ${extend} short answer explanation questions (type:"short", difficulty:"explanation") — extended explanations or evaluation, 3 sentence max model answers
 
Keep ALL model answers brief. Return ONLY the JSON array:
[{"type":"mc","difficulty":"recall","spec_id":"...","topic":"...","question":"...","options":["A) ...","B) ...","C) ...","D) ..."],"answer":"A","model_answer":"..."},{"type":"short","difficulty":"recall","spec_id":"...","topic":"...","question":"...","model_answer":"..."}]`
        }]
      })
    });
 
    if (!apiResponse.ok) {
      const errBody = await apiResponse.text();
      return res.status(500).json({ error: `Anthropic API error ${apiResponse.status}: ${errBody.slice(0,200)}` });
    }
 
    const apiData = await apiResponse.json();
 
    if (apiData.stop_reason === 'max_tokens') {
      return res.status(500).json({ error: 'Response too long — try with fewer spec points covered.' });
    }
 
    let txt = apiData.content.filter(c => c.type === 'text').map(c => c.text).join('').trim();
    txt = txt.replace(/```json|```/g, '').trim();
 
    let questions;
    try {
      questions = JSON.parse(txt);
    } catch (e) {
      // Try to find array within response
      const start = txt.indexOf('[');
      const end = txt.lastIndexOf(']');
      if (start !== -1 && end !== -1 && end > start) {
        try {
          questions = JSON.parse(txt.slice(start, end + 1));
        } catch (e2) {
          return res.status(500).json({ error: 'Failed to parse response. Raw: ' + txt.slice(0, 200) });
        }
      } else {
        return res.status(500).json({ error: 'Invalid response format. Raw: ' + txt.slice(0, 200) });
      }
    }
 
    if (!Array.isArray(questions) || !questions.length) {
      return res.status(500).json({ error: 'No questions in response' });
    }
 
    // Save to homework table
    const saveResp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/homework`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'apikey': process.env.SUPABASE_PUBLISHABLE_KEY,
        'Prefer': 'return=representation'
      },
      body: JSON.stringify({ class_id, questions, tier })
    });
 
    const saved = await saveResp.json();
    const homework_id = Array.isArray(saved) ? saved[0]?.id : saved?.id;
 
    return res.status(200).json({ questions, homework_id });
 
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
