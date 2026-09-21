// api/storage.js
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  return res.status(501).json({
    error: 'Storage endpoint not implemented yet'
  });
}
