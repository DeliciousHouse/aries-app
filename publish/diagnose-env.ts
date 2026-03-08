console.log(JSON.stringify({
  N8N_BASE_URL: process.env.N8N_BASE_URL || null,
  hasN8NApiKey: !!process.env.N8N_API_KEY,
  n8nApiKeyLength: (process.env.N8N_API_KEY || "").length
}, null, 2));
