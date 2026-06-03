import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) return res.status(401).json({ error: 'Not authenticated' });

    if (req.method === 'GET') {
      const { data, error } = await supabase
        .from('classes')
        .select(`*, taught_topics(*), flagged_questions(*), quiz_history(*)`)
        .eq('teacher_id', user.id)
        .order('created_at', { ascending: true });
      if (error) throw error;
      return res.status(200).json(data);
    }

    if (req.method === 'POST') {
      const { name, tier } = req.body;
      const { data, error } = await supabase
        .from('classes')
        .insert({ name, tier: tier || 'Higher', teacher_id: user.id })
        .select().single();
      if (error) throw error;
      return res.status(200).json(data);
    }

    if (req.method === 'PUT') {
      const { id, topics } = req.body;
      // Upsert taught topics
      if (topics) {
        await supabase.from('taught_topics').delete().eq('class_id', id);
        if (topics.length) {
          await supabase.from('taught_topics').insert(
            topics.map(t => ({ class_id: id, spec_id: t.id, spec_text: t.text, taught_date: new Date().toISOString().split('T')[0] }))
          );
        }
      }
      return res.status(200).json({ success: true });
    }

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
