/* ═══════════════════════════════════════════════════════
   AI BISNIS KONSULTAN — Netlify Function "background summarizer"
   Endpoint: POST /.netlify/functions/ai-consultant-summarize

   Dipanggil otomatis lewat navigator.sendBeacon() dari browser pas
   user pindah halaman / tutup tab (event "beforeunload"). Tugasnya:
   gabungkan ringkasan memori lama + percakapan sesi barusan jadi SATU
   ringkasan baru yang padat, disimpan permanen di
   tenants/{uid}/ai_memory/summary — biar AI Konsultan tetap "inget"
   tema yang pernah dibahas walau riwayat chat mentahnya sendiri
   nggak disimpan (cuma per sesi browser).

   Ini best-effort / background task: kalau gagal (token invalid,
   API error, dll), nggak masalah — cukup return 200 kosong, JANGAN
   bikin browser retry atau munculin error ke user (karena ini jalan
   di background pas user udah mau pindah/nutup tab).

   Pakai model Haiku (murah) karena tugasnya cuma meringkas teks,
   bukan reasoning berat.

   ENV VARS: sama persis dengan ai-consultant.js (lihat file itu).
═══════════════════════════════════════════════════════ */

const admin = require("firebase-admin");

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
    }),
  });
}
const db = admin.firestore();

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUMMARY_MODEL = "claude-haiku-4-5-20251001";
const MAX_SUMMARY_INPUT_TURNS = 20;

exports.handler = async (event) => {
  // Selalu balas 200 kosong buat apapun yang terjadi (best-effort, silent).
  const noop = { statusCode: 200, body: "" };

  if (event.httpMethod !== "POST") return noop;

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return noop;
  }

  const { idToken, history } = body;
  if (!idToken || !Array.isArray(history) || history.length === 0) return noop;

  let uid;
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    uid = decoded.uid;
  } catch (e) {
    return noop; // token expired/invalid — diamkan aja, bukan fitur kritikal
  }

  try {
    const tenantRef = db.collection("tenants").doc(uid);
    const memoryRef = tenantRef.collection("ai_memory").doc("summary");
    const memorySnap = await memoryRef.get();
    const oldSummary = memorySnap.exists ? memorySnap.data().text || "" : "";

    const transcript = history
      .slice(-MAX_SUMMARY_INPUT_TURNS)
      .map((h) => `${h.role === "user" ? "Owner" : "AI"}: ${h.content}`)
      .join("\n");

    const prompt = `Ringkasan pembahasan sebelumnya (kalau ada):
${oldSummary || "(belum ada)"}

Percakapan baru barusan:
${transcript}

Tugas: gabungkan jadi SATU ringkasan baru yang padat (maksimal 200 kata), isinya poin-poin tema/keputusan/insight penting yang pernah dibahas dengan owner toko ini. Ini akan dipakai AI Konsultan buat lanjutin pembahasan di sesi berikutnya tanpa perlu nanya ulang dari nol. Jangan tambahkan komentar/pengantar lain — langsung isi ringkasannya aja.`;

    const apiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: SUMMARY_MODEL,
        max_tokens: 400,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const data = await apiRes.json();
    const newSummary = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    if (newSummary) {
      await memoryRef.set({
        text: newSummary,
        updated_at: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
  } catch (e) {
    console.error("ai-consultant-summarize gagal (non-fatal):", e);
  }

  return noop;
};
