import express from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';

const app = express();

const allowedOrigins = [
  'http://localhost:3000', // Docker local frontend
  'http://127.0.0.1:3000',
  process.env.FRONTEND_URL // Inject URL via hosted environment variable (e.g Render frontend URL)
].filter(Boolean);

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.error('CORS blocked origin:', origin);
      callback(null, false); // IMPORTANT: don't throw error
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
};

// MUST be first
app.use(cors(corsOptions));

// MUST explicitly handle preflight
app.options('*', cors(corsOptions));
app.use(express.json());

const PORT = process.env.PORT || 3001;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;

if (!ANTHROPIC_API_KEY) {
  console.error('❌ ANTHROPIC_API_KEY environment variable is required');
  process.exit(1);
}
if (!FINNHUB_API_KEY) {
  console.error('❌ FINNHUB_API_KEY environment variable is required');
  process.exit(1);
}

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ── Finnhub API helpers ──────────────────────────
const FINNHUB_BASE = 'https://finnhub.io/api/v1';

async function finnhubGet(endpoint) {
  const url = `${FINNHUB_BASE}${endpoint}&token=${FINNHUB_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Finnhub ${endpoint} returned ${res.status}`);
  return res.json();
}

// ── Stock Data Cache (5 min TTL) ─────────────────
const stockCache = { data: null, timestamp: 0 };
const CACHE_TTL = 5 * 60 * 1000;

const STOCKS = [
  { ticker: 'AAPL', name: 'Apple' },
  { ticker: 'NVDA', name: 'Nvidia' },
  { ticker: 'NKE', name: 'Nike' }
];

async function fetchOneStock(ticker, name) {
  try {
    // Fetch quote (price data) and basic financials in parallel
    const [quote, metrics] = await Promise.all([
      finnhubGet(`/quote?symbol=${ticker}`),
      finnhubGet(`/stock/metric?symbol=${ticker}&metric=all`)
    ]);

    const m = metrics.metric || {};

    return {
      ticker,
      name,
      price: quote.c || null,           // current price
      change: quote.d || null,           // change today
      changePercent: quote.dp || null,   // change % today
      high: quote.h || null,             // day high
      low: quote.l || null,              // day low
      peRatio: m.peBasicExclExtraTTM || m.peNormalizedAnnual || null,
      marketCap: m.marketCapitalization ? m.marketCapitalization * 1e6 : null,
      dividendYield: m.dividendYieldIndicatedAnnual || null,
      eps: m.epsBasicExclExtraItemsTTM || null,
      beta: m.beta || null,
      fiftyTwoWeekHigh: m['52WeekHigh'] || null,
      fiftyTwoWeekLow: m['52WeekLow'] || null,
      revenueGrowth: m.revenueGrowthQuarterlyYoy || null
    };
  } catch (err) {
    console.error(`⚠️ Failed to fetch ${ticker}:`, err.message);
    return { ticker, name, error: 'Data unavailable' };
  }
}

async function fetchStockData() {
  const now = Date.now();
  if (stockCache.data && (now - stockCache.timestamp) < CACHE_TTL) {
    console.log('📦 Using cached stock data');
    return stockCache.data;
  }

  console.log('📊 Fetching fresh stock data from Finnhub...');
  const results = {};

  // Fetch sequentially to respect rate limits (30/sec free tier)
  for (const { ticker, name } of STOCKS) {
    results[ticker] = await fetchOneStock(ticker, name);
  }

  stockCache.data = results;
  stockCache.timestamp = now;
  return results;
}

// ── Format stock data for Claude prompt ──────────
function formatStockDataForPrompt(stockData) {
  return Object.values(stockData).map(s => {
    if (s.error) return `- ${s.name} (${s.ticker}): Data currently unavailable`;

    const parts = [`- ${s.name} (${s.ticker}):`];
    if (s.price != null) parts.push(`Price $${s.price.toFixed(2)}`);
    if (s.changePercent != null) {
      const sign = s.changePercent >= 0 ? '+' : '';
      parts.push(`Today ${sign}${s.changePercent.toFixed(2)}%`);
    }
    if (s.peRatio != null) parts.push(`P/E ${s.peRatio.toFixed(1)}`);
    if (s.marketCap != null) {
      const cap = s.marketCap >= 1e12
        ? `$${(s.marketCap / 1e12).toFixed(2)}T`
        : `$${(s.marketCap / 1e9).toFixed(0)}B`;
      parts.push(`Market Cap ${cap}`);
    }
    if (s.dividendYield != null) parts.push(`Dividend Yield ${s.dividendYield.toFixed(2)}%`);
    if (s.eps != null) parts.push(`EPS $${s.eps.toFixed(2)}`);
    if (s.beta != null) parts.push(`Beta ${s.beta.toFixed(2)}`);
    if (s.fiftyTwoWeekHigh != null && s.fiftyTwoWeekLow != null) {
      parts.push(`52-Week Range $${s.fiftyTwoWeekLow.toFixed(2)}–$${s.fiftyTwoWeekHigh.toFixed(2)}`);
    }

    return parts.join(', ');
  }).join('\n');
}

// ── Claude System Prompt ─────────────────────────
const SYSTEM_PROMPT = `You are InvestorDict, a friendly investing teacher who uses REAL current stock data to explain concepts.

You will receive an investing term AND real current stock data for Apple, Nvidia, and Nike. Use the ACTUAL numbers provided to explain the concept.

Respond in EXACTLY this JSON format:

{
  "term": "the term",
  "explanation": "2-3 sentence plain English explanation using the real numbers provided. Reference actual stock prices and metrics. Explain it like the reader is 15 years old.",
  "example": "A specific comparison using the real data. For example: 'Apple\\'s P/E is 28.4 while Nvidia\\'s is 64.2 — this means investors pay $64.20 for every $1 Nvidia earns, vs $28.40 for Apple.'",
  "why_it_matters": "One sentence on why this matters for investors."
}

IMPORTANT RULES:
- Use the REAL numbers from the stock data provided — never make up numbers
- If the term is conceptual with no directly relevant metric (e.g. 'bull market', 'diversification'), explain it normally and mention the stocks as examples where natural, but don't force irrelevant metrics
- If the term is NOT investment-related, respond with:
  { "term": "...", "not_investment_related": true, "message": "..." }
- Always respond with valid JSON only. No markdown, no code fences, no extra text.`;

// ── API Endpoint ─────────────────────────────────
app.post('/api/explain', async (req, res) => {
  const { term, profile } = req.body;

  if (!term || typeof term !== 'string' || term.trim().length === 0) {
    return res.status(400).json({ error: 'Please provide a term to explain.' });
  }

  try {
    // 1. Fetch stock data
    const stockData = await fetchStockData();
    const stockDataText = formatStockDataForPrompt(stockData);

    let dynamicSystemPrompt = SYSTEM_PROMPT;
    if (profile) {
      const goalStr = Array.isArray(profile.goal) ? profile.goal.join(', ') : profile.goal;
      dynamicSystemPrompt += `\n\nUSER PROFILE:\nKnowledge Level: "${profile.knowledge}"\nGoal: "${goalStr}"\nWatched Stocks: "${profile.stocks}"\n\nTAILORING INSTRUCTIONS: You MUST adapt your tone and complexity to their knowledge level! A beginner needs analogies, while a serious investor needs mechanics. Use their watched stocks as examples if possible, though you can rely on the provided live numbers if they don't have relevant ones. Make the explanation feel highly personalized.`;
    }

    // 2. Call Claude
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 600,
      system: dynamicSystemPrompt,
      messages: [
        {
          role: 'user',
          content: `Term: ${term.trim()}\n\nCurrent stock data:\n${stockDataText}`
        }
      ]
    });

    const responseText = message.content[0].text;

    // 3. Parse Claude's JSON
    let parsed;
    try {
      parsed = JSON.parse(responseText);
    } catch {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('Failed to parse Claude response');
      }
    }

    // 4. Return result + stock data
    res.json({
      ...parsed,
      stock_data: stockData
    });

  } catch (err) {
    console.error('❌ Error handling /api/explain:', err.message);

    if (err.status === 401) {
      return res.status(500).json({ error: 'Invalid Anthropic API key. Check your ANTHROPIC_API_KEY.' });
    }
    if (err.status === 429) {
      return res.status(429).json({ error: 'Rate limited. Please wait a moment and try again.' });
    }

    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ── Daily Learning Endpoint ───────────────────────
app.post('/api/learn/daily', async (req, res) => {
  const { profile, seenConcepts } = req.body;
  const p = profile || { knowledge: 'Beginner', goal: 'Learn the basics', stocks: 'None' };
  const seen = Array.isArray(seenConcepts) ? seenConcepts : [];

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      system: `You are InvestorDict, an investing teacher. Select ONE foundational investing concept that this user MUST learn today.
      
      Do NOT select any concept in this list: [${seen.join(', ')}].
      The concept must be appropriate for their level: "${p.knowledge}".
      Their goal: "${Array.isArray(p.goal) ? p.goal.join(', ') : p.goal}".
      They follow these stocks/companies: "${p.stocks}".

      Respond in EXACTLY this JSON format:
      {
        "term": "The concept name",
        "explanation": "A simple 2-sentence plain English explanation, specifically tailored for their knowledge level.",
        "example": "A 1-sentence example using one of their watched stocks: ${p.stocks}"
      }
      
      Always respond with valid JSON only.`,
      messages: [{ role: 'user', content: 'Give me my daily concept.' }]
    });

    const responseText = message.content[0].text;
    let parsed;
    try {
      parsed = JSON.parse(responseText);
    } catch {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
      else throw new Error('Failed to parse Claude learning response');
    }

    res.json(parsed);
  } catch (err) {
    console.error('❌ Error handling /api/learn/daily:', err.message);
    res.status(500).json({ error: 'Failed to generate daily learning.' });
  }
});

// ── Game Mode Logic ────────────────────────────────
const GAME_POOL = [
  { ticker: 'AAPL', name: 'Apple' },
  { ticker: 'NKE', name: 'Nike' },
  { ticker: 'TSLA', name: 'Tesla' },
  { ticker: 'NVDA', name: 'Nvidia' },
  { ticker: 'MCD', name: 'McDonalds' },
  { ticker: 'KO', name: 'Coca-Cola' },
  { ticker: 'AMZN', name: 'Amazon' },
  { ticker: 'MSFT', name: 'Microsoft' },
  { ticker: 'BMW.DE', name: 'BMW' },
  { ticker: 'SIE.DE', name: 'Siemens' }
];

const gameCache = { data: null, dateStr: null };

async function fetchGameStock(ticker) {
  const [quote, metrics, profile] = await Promise.all([
    finnhubGet(`/quote?symbol=${ticker}`),
    finnhubGet(`/stock/metric?symbol=${ticker}&metric=all`),
    finnhubGet(`/stock/profile2?symbol=${ticker}`)
  ]);
  const m = metrics.metric || {};
  return {
    ticker,
    price: quote.c || null,
    peRatio: m.peBasicExclExtraTTM || m.peNormalizedAnnual || null,
    marketCap: m.marketCapitalization ? m.marketCapitalization * 1e6 : null,
    dividendYield: m.dividendYieldIndicatedAnnual || null,
    revenueGrowth: m.revenueGrowthQuarterlyYoy || null,
    sector: profile.finnhubIndustry || profile.industry || 'Unknown'
  };
}

const GAME_SYSTEM_PROMPT = `You are creating a 'Guess the Company' investing game. I will give you a company name and its current financial metrics.

Output EXACTLY this JSON structure:
{
  "hint2": "A one-sentence clue mentioning their broad sector and a behavioral clue about how consumers interact with them. Do NOT name the company or its specific products.",
  "hint3": "A very obvious one-sentence clue about their most famous product or their presence in everyday life. Do NOT name the company.",
  "reveal_explanation": "A 3-sentence plain English explanation of what the provided financial numbers (P/E, Market Cap, Growth, Dividend) say about this company as an investment. Reference the actual numbers."
}

Always respond with valid JSON only. No markdown, no code fences.`;

async function getDailyGameData() {
  const todayDateStr = new Date().toISOString().split('T')[0];

  if (gameCache.dateStr === todayDateStr && gameCache.data) {
    console.log('📦 Using cached game data for today');
    return gameCache.data;
  }

  console.log('🎮 Generating fresh game data for today...');
  const epochDays = Math.floor(Date.now() / (1000 * 60 * 60 * 24));
  const dailyIndex = epochDays % GAME_POOL.length;
  const company = GAME_POOL[dailyIndex];

  const stockData = await fetchGameStock(company.ticker);

  // Format data for Claude
  const capStr = stockData.marketCap
    ? (stockData.marketCap >= 1e12 ? `$${(stockData.marketCap / 1e12).toFixed(2)}T` : `$${(stockData.marketCap / 1e9).toFixed(0)}B`)
    : 'Unknown';

  const dataText = `
Company: ${company.name}
Sector: ${stockData.sector}
P/E Ratio: ${stockData.peRatio ? stockData.peRatio.toFixed(1) : 'N/A'}
Market Cap: ${capStr}
Revenue Growth: ${stockData.revenueGrowth ? stockData.revenueGrowth.toFixed(1) + '%' : 'N/A'}
Dividend Yield: ${stockData.dividendYield ? stockData.dividendYield.toFixed(2) + '%' : 'N/A'}
`;

  // Call Claude
  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 400,
    system: GAME_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: dataText }]
  });

  const responseText = message.content[0].text;
  let parsed;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
    else throw new Error('Failed to parse Claude game response');
  }

  const payload = {
    date: todayDateStr,
    metrics: {
      peRatio: stockData.peRatio ? stockData.peRatio.toFixed(1) : 'N/A',
      marketCap: capStr,
      revenueGrowth: stockData.revenueGrowth ? stockData.revenueGrowth.toFixed(1) + '%' : 'N/A',
      dividendYield: stockData.dividendYield ? stockData.dividendYield.toFixed(2) + '%' : 'N/A'
    },
    hints: {
      hint2: parsed.hint2,
      hint3: parsed.hint3
    },
    reveal: {
      explanation: parsed.reveal_explanation,
      name: company.name,
      ticker: company.ticker
    }
  };

  gameCache.data = payload;
  gameCache.dateStr = todayDateStr;
  return payload;
}

app.get('/api/game/today', async (req, res) => {
  try {
    const gameData = await getDailyGameData();
    // Return everything except the reveal to prevent cheating in the Network tab
    res.json({
      date: gameData.date,
      metrics: gameData.metrics,
      hints: gameData.hints
    });
  } catch (err) {
    console.error('❌ Error handling /api/game/today:', err.message);
    res.status(500).json({ error: 'Failed to generate game data.' });
  }
});

app.post('/api/game/guess', async (req, res) => {
  const { guess } = req.body;

  if (!guess || typeof guess !== 'string') {
    return res.status(400).json({ error: 'Please provide a guess.' });
  }

  try {
    const gameData = await getDailyGameData();
    const actualName = gameData.reveal.name.toLowerCase();
    const userGuess = guess.toLowerCase().trim();

    // Simple matching (e.g. "Coca-Cola" matches "coca cola", "mcdonalds" matches "McDonalds")
    const isCorrect = userGuess === actualName ||
      actualName.includes(userGuess) && userGuess.length > 3 ||
      actualName.replace(/[^a-z]/g, '') === userGuess.replace(/[^a-z]/g, '');

    if (isCorrect) {
      res.json({ correct: true, reveal: gameData.reveal });
    } else {
      res.json({ correct: false });
    }
  } catch (err) {
    console.error('❌ Error handling /api/game/guess:', err.message);
    res.status(500).json({ error: 'Failed to process guess.' });
  }
});

app.post('/api/game/reveal', async (req, res) => {
  // Used when out of guesses
  try {
    const gameData = await getDailyGameData();
    res.json({ reveal: gameData.reveal });
  } catch (err) {
    res.status(500).json({ error: 'Failed' });
  }
});

// ── Health check ─────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', cached: !!stockCache.data });
});

// ── Start ────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 InvestorDict backend running on port ${PORT}`);
});
