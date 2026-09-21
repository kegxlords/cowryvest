// api/task.js
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method === 'GET') {
    return res.status(200).json({
      success: true,
      tasks: []
    });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
