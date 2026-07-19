/* ═══════════════════════════════════════════════════════
   AI BISNIS KONSULTAN — Netlify Function (backend)
   Endpoint: POST /.netlify/functions/ai-consultant

   Tugas:
   1. Verifikasi Firebase ID Token (pastikan yang manggil emang
      user yang login, bukan orang random yang nembak endpoint ini)
   2. Cek tenant.tier === "pro" (gating fitur PRO)
   3. Cek & potong kuota chat bulanan (tenants/{uid}.ai_quota)
   4. Susun "ringkasan data bisnis" toko dari daily_summary
      (BUKAN kirim semua raw order — biar hemat token & cepat)
   5. Ambil ringkasan memori percakapan sebelumnya (ai_memory)
   6. Panggil Anthropic API (Claude Sonnet 5) dengan tool web_search
      aktif, biar AI bisa cari referensi luar kalau perlu
   7. Balikin jawaban + update kuota

   ENV VARS yang WAJIB diset di Netlify (Site settings > Environment variables):
   - ANTHROPIC_API_KEY       -> API key dari console.anthropic.com
   - FIREBASE_PROJECT_ID     -> dari Firebase service account JSON
   - FIREBASE_CLIENT_EMAIL   -> dari Firebase service account JSON
   - FIREBASE_PRIVATE_KEY    -> dari Firebase service account JSON
                                (paste APA ADANYA termasuk \n literal,
                                 kode di bawah otomatis convert jadi newline asli)
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
const MODEL = "claude-sonnet-5";
const DEFAULT_QUOTA_LIMIT = 100;
const SNAPSHOT_DAYS = 60;

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return json(405, { error: "Method not allowed" });
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return json(400, { error: "Body bukan JSON yang valid" });
  }

  const message = body.message;
  const history = Array.isArray(body.history) ? body.history : [];

  if (!message || typeof message !== "string" || !message.trim()) {
    return json(400, { error: "Pesan kosong" });
  }

  // ── 1. Verifikasi Firebase ID Token ──────────────────────────
  const authHeader = event.headers.authorization || event.headers.Authorization || "";
  const idToken = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!idToken) {
    return json(401, { error: "Token tidak ada" });
  }

  let uid;
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    uid = decoded.uid;
  } catch (e) {
    console.error("verifyIdToken gagal:", e.message);
    return json(401, { error: "Token tidak valid / kadaluarsa" });
  }

  const tenantRef = db.collection("tenants").doc(uid);
  const tenantSnap = await tenantRef.get();
  if (!tenantSnap.exists) {
    return json(403, { error: "Akun/toko tidak ditemukan" });
  }
  const tenantData = tenantSnap.data();

  // ── 2. Gating fitur PRO ──────────────────────────────────────
  if (tenantData.tier !== "pro") {
    return json(403, { error: "Fitur ini khusus akun PRO" });
  }

  // ── 3. Cek & reset kuota bulanan ─────────────────────────────
  const nowMonth = new Date().toISOString().slice(0, 7); // "2026-07"
  let quota = tenantData.ai_quota || {};
  if (quota.month !== nowMonth) {
    quota = { count: 0, month: nowMonth, limit: quota.limit || DEFAULT_QUOTA_LIMIT };
  }
  const limit = quota.limit || DEFAULT_QUOTA_LIMIT;
  if ((quota.count || 0) >= limit) {
    return json(429, {
      message: `Kuota chat bulan ini (${limit}) sudah habis. Kuota reset otomatis tanggal 1 bulan depan.`,
    });
  }

  // ── 4. Susun ringkasan data bisnis ───────────────────────────
  let businessSnapshot;
  try {
    businessSnapshot = await buildBusinessSnapshot(tenantRef);
  } catch (e) {
    console.error("buildBusinessSnapshot gagal:", e);
    businessSnapshot = "(gagal memuat data toko — jawab pakai pengetahuan umum aja dulu)";
  }

  // ── 5. Ambil ringkasan memori percakapan sebelumnya ──────────
  let memoryText = "";
  try {
    const memorySnap = await tenantRef.collection("ai_memory").doc("summary").get();
    memoryText = memorySnap.exists ? memorySnap.data().text || "" : "";
  } catch (e) {
    console.error("Gagal ambil ai_memory:", e);
  }

  const namaToko = tenantData.nama_toko || "toko ini";
  const systemPrompt = `Kamu adalah AI Konsultan Bisnis untuk pemilik toko Shopee "${namaToko}", bagian dari aplikasi Sellvix AI.

Tugasmu: bantu owner memahami performa bisnisnya dan kasih saran strategi yang konkret & actionable, berdasarkan data toko di bawah ini. Kalau pertanyaannya butuh info di luar data toko (tren pasar, kompetitor, harga bahan baku, dsb), gunakan tool pencarian web yang tersedia.

Gaya bicara: Bahasa Indonesia, santai tapi profesional, to the point, jangan bertele-tele. Kalau ngasih saran, jelasin alasannya berbasis angka yang ada.

═══ RINGKASAN DATA TOKO (${SNAPSHOT_DAYS} hari terakhir) ═══
${businessSnapshot}

═══ RINGKASAN PEMBAHASAN SEBELUMNYA (dari sesi-sesi chat sebelumnya) ═══
${memoryText || "(belum ada riwayat pembahasan sebelumnya)"}`;

  // ── 6. Panggil Anthropic API ─────────────────────────────────
  const messages = [...history, { role: "user", content: message }];
  let replyText;
  try {
    const apiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1200,
        system: systemPrompt,
        messages,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
      }),
    });
    const apiData = await apiRes.json();
    if (!apiRes.ok) {
      console.error("Anthropic API error:", JSON.stringify(apiData));
      return json(502, { error: "AI provider lagi bermasalah, coba lagi sebentar." });
    }
    replyText = (apiData.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n\n")
      .trim();
    if (!replyText) replyText = "Maaf, saya belum bisa kasih jawaban yang pas buat ini. Coba tanya dengan cara lain?";
  } catch (e) {
    console.error("Fetch ke Anthropic gagal:", e);
    return json(502, { error: "Gagal menghubungi AI. Coba lagi sebentar." });
  }

  // ── 7. Update kuota ───────────────────────────────────────────
  quota.count = (quota.count || 0) + 1;
  try {
    await tenantRef.set({ ai_quota: quota }, { merge: true });
  } catch (e) {
    console.error("Gagal update kuota:", e); // nggak fatal, tetap balikin jawaban
  }

  return json(200, {
    reply: replyText,
    quota_used: quota.count,
    quota_limit: limit,
  });
};

// Ambil daily_summary SNAPSHOT_DAYS hari terakhir, rangkum jadi teks padat
// (bukan kirim raw order — supaya token yang dipakai kecil & konsisten).
async function buildBusinessSnapshot(tenantRef) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - SNAPSHOT_DAYS);
  const cutoffStr = fmtLocalDate(cutoff); // format "YYYYMMDD", sama dgn ID dokumen daily_summary

  const snap = await tenantRef
    .collection("daily_summary")
    .where(admin.firestore.FieldPath.documentId(), ">=", cutoffStr)
    .get();

  if (snap.empty) return "(belum ada data Data Penjualan yang diupload)";

  let totalGmv = 0, totalOrder = 0, totalSelesai = 0, totalBatal = 0, totalProdukTerjual = 0;
  const seriesAgg = {};
  let dayCount = 0;

  snap.forEach((doc) => {
    const d = doc.data();
    dayCount++;
    totalGmv += d.gmv || 0;
    totalOrder += d.total_order || 0;
    totalSelesai += d.order_selesai || 0;
    totalBatal += d.order_batal || 0;
    totalProdukTerjual += d.total_produk_terjual || 0;
    Object.entries(d.by_series || {}).forEach(([code, s]) => {
      if (!seriesAgg[code]) seriesAgg[code] = { qty: 0, revenue: 0 };
      seriesAgg[code].qty += s.qty || 0;
      seriesAgg[code].revenue += s.revenue || 0;
    });
  });

  const topSeries = Object.entries(seriesAgg)
    .sort((a, b) => b[1].revenue - a[1].revenue)
    .slice(0, 5)
    .map(([code, s]) => `${code} (qty ${s.qty}, revenue Rp${Math.round(s.revenue).toLocaleString("id-ID")})`)
    .join("; ");

  const cancelRate = totalOrder ? ((totalBatal / totalOrder) * 100).toFixed(1) : "0";

  return [
    `Periode: ${dayCount} hari data (sejak ${cutoffStr})`,
    `GMV total: Rp${Math.round(totalGmv).toLocaleString("id-ID")}`,
    `Total Order: ${totalOrder} (Selesai: ${totalSelesai}, Batal: ${totalBatal}, Cancel Rate: ${cancelRate}%)`,
    `Total Produk Terjual: ${totalProdukTerjual} unit`,
    `Top 5 Series (berdasarkan revenue): ${topSeries || "-"}`,
  ].join("\n");
}

function fmtLocalDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  };
}
