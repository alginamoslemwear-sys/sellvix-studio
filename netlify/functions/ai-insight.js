// netlify/functions/ai-insight.js
// Fungsi server-side: terima data campaign dari browser, minta Claude API
// bikin ringkasan poin-poin penting, kirim balik teksnya ke browser.
// API key TIDAK PERNAH dikirim ke browser — aman dari pencurian.

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  try {
    const { periodeLabel, summary, ads } = JSON.parse(event.body);

    if (!ads || !Array.isArray(ads) || ads.length === 0) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Data campaign kosong." }),
      };
    }

    const topAds = [...ads].sort((a, b) => b.omzet - a.omzet).slice(0, 5);
    const worstAds = [...ads]
      .filter((a) => a.biaya > 0)
      .sort((a, b) => a.omzet / a.biaya - b.omzet / b.biaya)
      .slice(0, 5);

    const fmtRp = (n) => "Rp " + Math.round(n).toLocaleString("id-ID");

    const prompt = `Kamu adalah asisten bisnis yang membantu owner toko Shopee memahami performa iklannya tanpa perlu membaca tabel angka mentah satu-satu.

RINGKASAN PERIODE: ${periodeLabel}
- Total Biaya Iklan: ${fmtRp(summary.total_biaya)}
- Total Omzet dari Iklan: ${fmtRp(summary.total_omzet)}
- ROAS keseluruhan: ${summary.roas.toFixed(2)}x
- ACOS keseluruhan: ${summary.acos.toFixed(1)}%

TOP 5 CAMPAIGN BY OMZET:
${topAds.map((a) => `- ${a.nama_iklan}: biaya ${fmtRp(a.biaya)}, omzet ${fmtRp(a.omzet)}, ROAS ${(a.biaya ? a.omzet / a.biaya : 0).toFixed(2)}x`).join("\n")}

5 CAMPAIGN DENGAN ROAS TERENDAH:
${worstAds.map((a) => `- ${a.nama_iklan}: biaya ${fmtRp(a.biaya)}, omzet ${fmtRp(a.omzet)}, ROAS ${(a.biaya ? a.omzet / a.biaya : 0).toFixed(2)}x`).join("\n")}

Tulis ringkasan SINGKAT (maksimal 5 poin, bentuk bullet point) dalam Bahasa Indonesia yang mudah dipahami owner toko awam — tanpa jargon marketing berlebihan. Fokus ke:
1. Campaign mana yang paling menguntungkan (dan kenapa layak dilanjutkan/ditambah budget)
2. Campaign mana yang boros/merugi (ROAS rendah) dan perlu dievaluasi atau dihentikan
3. 1 rekomendasi aksi paling konkret yang bisa langsung dilakukan owner

Langsung ke poin-poinnya, tidak perlu pembuka atau penutup basa-basi.`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 600,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      return {
        statusCode: 502,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: `Claude API error: ${errText}` }),
      };
    }

    const data = await response.json();
    const textBlock = (data.content || []).find((b) => b.type === "text");
    const summaryText = textBlock ? textBlock.text : "Tidak bisa membuat ringkasan saat ini.";

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ summary: summaryText }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
