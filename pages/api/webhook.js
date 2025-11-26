// pages/api/webhook.js

export default async function handler(req, res) {
  console.log("🔔 Webhook llamado - método:", req.method);

  if (req.method !== "POST") {
    // Para que puedas probar en el navegador con GET y ver algo
    return res.status(200).json({ ok: true, message: "Ruta /api/webhook existe (GET)" });
  }

  // Si llega un POST (Fillout, curl, etc)
  console.log("📥 Body recibido:", req.body);

  return res.status(200).json({ ok: true, message: "Webhook recibido (POST)" });
}
