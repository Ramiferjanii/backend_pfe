const { Groq } = require('groq-sdk');
const prisma = require('../lib/prisma');

// Initialize Groq only if the API key is present
const groq = process.env.GROQ_API_KEY ? new Groq({ apiKey: process.env.GROQ_API_KEY }) : null;

/**
 * Fetches all reviews for a product and asks Groq's Llama-3 to generate a summary.
 * Returns a structured JSON with pros, cons, and a final verdict.
 */
async function generateReviewSummary(productId) {
    if (!groq) {
        throw new Error("Groq API Key is missing in .env");
    }

    // 1. Fetch all existing reviews for this product from the database
    const reviews = await prisma.review.findMany({
        where: { productId },
        select: { title: true, body: true, rating: true },
        take: 30 // process max 30 reviews to avoid context limits
    });

    if (reviews.length === 0) {
        return {
            pros: [],
            cons: [],
            verdict: "Not enough reviews available to generate an AI verdict yet.",
            hasData: false
        };
    }

    // 2. Format the reviews into a single string for the AI
    const reviewsText = reviews.map(r => `[Rating: ${r.rating} Stars, Title: "${r.title || 'No Title'}"] Review: ${r.body}`).join('\n\n');

    // 3. Prompt the Groq AI
    const systemPrompt = `You are a helpful e-commerce AI shopping assistant. 
Your goal is to read a list of customer reviews and summarize them into a highly concise, objective format.
Do NOT output markdown code blocks. Output ONLY a raw JSON object string with this exact structure, nothing else:
{
  "pros": ["3 short bullet points of things people liked"],
  "cons": ["3 short bullet points of things people disliked"],
  "verdict": "A 2-sentence final conclusion summarizing the overall customer sentiment."
}`;

    try {
        const chatCompletion = await groq.chat.completions.create({
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: `Here are the reviews:\n\n${reviewsText}` }
            ],
            model: 'llama-3.3-70b-versatile', // Extremely fast Llama 3.3 model on Groq
            temperature: 0.3, // keep the AI focused
            response_format: { type: "json_object" }, // Ensures output is strictly JSON
        });

        const resultJson = chatCompletion.choices[0]?.message?.content;
        const parsed = JSON.parse(resultJson);

        return {
            pros: parsed.pros || [],
            cons: parsed.cons || [],
            verdict: parsed.verdict || "Unable to determine verdict.",
            hasData: true
        };
    } catch (err) {
        console.error('[AI Service] Failed to generate summary from Groq:', err);
        throw new Error('Groq AI generation failed');
    }
}

/**
 * Fetches product details and asks Groq to analyze if the current price is a good deal.
 */
async function analyzeDeal(productId) {
    if (!groq) {
        throw new Error("Groq API Key is missing in .env");
    }

    const product = await prisma.product.findUnique({
        where: { id: productId },
    });

    if (!product) {
        throw new Error("Product not found");
    }

    const systemPrompt = `You are an expert hardware and e-commerce deal analyst.
I will give you a product's name, price, and specs. 
You must determine if this is a "Good Deal", "Normal Price", or "Overpriced" based on general tech market knowledge.
Assume the price is in Tunisian Dinars (TND) unless specified otherwise (1 USD ≈ 3.1 TND).
If you are unsure of the exact market value, make an educated guess based on the specs (e.g., Celeron is budget, i7 is premium).

Output ONLY a raw JSON object string with this exact structure:
{
  "rating": "Good Deal" | "Normal Price" | "Overpriced",
  "explanation": "A 2-sentence explanation of why, referencing the processor, RAM, or specific specs vs the price."
}`;

    const userPrompt = `Product Name/Specs: ${product.name}
Reference: ${product.reference || 'N/A'}
Store: ${product.domain}
Current Listed Price: ${product.price}
Overview/Details: ${product.overview}`;

    try {
        const chatCompletion = await groq.chat.completions.create({
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ],
            model: 'llama-3.3-70b-versatile',
            temperature: 0.2, // very analytical
            response_format: { type: "json_object" }, 
        });

        const resultJson = chatCompletion.choices[0]?.message?.content;
        const parsed = JSON.parse(resultJson);

        return {
            rating: parsed.rating || "Unknown",
            explanation: parsed.explanation || "Could not analyze this deal.",
        };
    } catch (err) {
        console.error('[AI Service] Failed to analyze deal from Groq:', err);
        throw new Error('Groq AI deal analysis failed');
    }
}

/**
 * Handles a multi-turn conversation for the floating Shopping Assistant.
 */
async function chatWithAssistant(messages, userId) {
    if (!groq) {
        throw new Error("Groq API Key is missing in .env");
    }

    try {
        // Find recent relevant products for context
        const userProducts = await prisma.product.findMany({
            where: { userId },
            select: { name: true, price: true, domain: true },
            take: 10,
            orderBy: { createdAt: 'desc' }
        });

        const contextItems = userProducts.map(p => `- ${p.name} from ${p.domain} for ${p.price}`).join('\n');
        
        const systemPrompt = `You are a helpful, enthusiastic Shopping AI expert.
Your user has scraped some products from e-commerce sites. 
Here are their recently scraped products as context:
${userProducts.length > 0 ? contextItems : 'No products scraped recently.'}

Goal: Answer their questions about these products, give recommendations, or provide general e-commerce advice. Keep answers under 3 paragraphs. Use markdown briefly for bolding or bullet points. Avoid JSON output, just speak conversationally.`;

        // ── KEY FIX: Groq requires the conversation to start with a 'user' message ──
        // Drop any leading 'assistant' messages (e.g. the greeting from the frontend).
        const filtered = messages
            .filter(m => m.role === 'user' || m.role === 'assistant')
            .slice(messages.findIndex(m => m.role === 'user')); // trim any leading assistant messages

        // Safety: if nothing valid is left, throw early
        if (!filtered.length || filtered[0].role !== 'user') {
            throw new Error('No valid user message found in conversation');
        }

        const groqMessages = [
            { role: 'system', content: systemPrompt },
            ...filtered
        ];

        console.log('[AI Chat] Sending', groqMessages.length, 'messages to Groq...');

        const chatCompletion = await groq.chat.completions.create({
            messages: groqMessages,
            model: 'llama-3.3-70b-versatile',
            temperature: 0.6,
        });

        return chatCompletion.choices[0]?.message?.content || "I couldn't process that request.";
    } catch (err) {
        console.error('[AI Service] Chatbot failed:', err?.error || err?.message || err);
        throw new Error('Groq AI chat failed');
    }
}


/**
 * Analyzes overall dashboard statistics to provide high-level AI insights.
 */
async function generateDashboardInsights(stats) {
    if (!groq) {
        throw new Error("Groq API Key is missing in .env");
    }

    const systemPrompt = `You are a strategic business and e-commerce growth analyst.
Analyze the following user data from their product monitoring dashboard.
Identify trends, highlight "wins", and provide 2-3 actionable "Growth Tips".
Keep the output highly concise, professional, and data-driven.
Output ONLY a raw JSON object string with this exact structure:
{
  "summary": "1-2 sentences summarizing current performance.",
  "topInsight": "A single major takeaway from the data.",
  "tips": ["3 short actionable advice bullet points based on the stats"]
}`;

    const userPrompt = `Dashboard Stats:
- Total Websites Tracked: ${stats.websiteCount}
- Total Products Scraped: ${stats.productCount}
- Total Reviews Analyzed: ${stats.reviewCount}
- Average Product Rating: ${stats.avgRating.toFixed(1)} / 5
- Sentiment Breakdown: ${stats.sentimentBreakdown.positive} Positive, ${stats.sentimentBreakdown.neutral} Neutral, ${stats.sentimentBreakdown.negative} Negative
- Recent Activity: ${stats.recentScrapes} products scraped in the last 7 days.`;

    try {
        const chatCompletion = await groq.chat.completions.create({
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ],
            model: 'llama-3.3-70b-versatile',
            temperature: 0.4,
            response_format: { type: "json_object" },
        });

        const resultJson = chatCompletion.choices[0]?.message?.content;
        return JSON.parse(resultJson);
    } catch (err) {
        console.error('[AI Service] Dashboard insights failed:', err);
        throw new Error('Groq AI dashboard analysis failed');
    }
}


/**
 * Generates a full market report for a specific category based on aggregated data.
 */
async function generateMarketReport(category, stats) {
    if (!groq) {
        throw new Error("Groq API Key is missing in .env");
    }

    const systemPrompt = `You are a professional Market Research Analyst specializing in global e-commerce.
Analyze the following data for a specific product category and generate a structured Market Insight Report.
Focus on identifying current trends, pricing competitiveness, and customer satisfaction levels.
The output MUST be a JSON object with this exact structure:
{
  "marketMood": "Highly Positive | Positive | Mixed | Negative",
  "averagePricingInsight": "1 sentence on whether the average price is competitive.",
  "strengths": ["3 key strengths of items in this category"],
  "weaknesses": ["3 key weaknesses or customer complaints"],
  "growthPotential": "1 paragraph (3 sentences) on the business potential for selling in this category.",
  "conclusion": "Final summarized professional advice."
}`;

    const userPrompt = `Market Report Request:
- Category Name: ${category || 'General'}
- Total Products Analyzed: ${stats.count}
- Average Category Rating: ${stats.avgRating.toFixed(1)} / 5
- Price Range: ${stats.minPrice} TND to ${stats.maxPrice} TND (Avg: ${stats.avgPrice.toFixed(0)} TND)
- Top 3 Recent Product Feedbacks: ${stats.recentFeedback.join('; ')}`;

    try {
        const chatCompletion = await groq.chat.completions.create({
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ],
            model: 'llama-3.3-70b-versatile',
            temperature: 0.5,
            response_format: { type: "json_object" },
        });

        const resultJson = chatCompletion.choices[0]?.message?.content;
        return JSON.parse(resultJson);
    } catch (err) {
        console.error('[AI Service] Market report failed:', err);
        throw new Error('Groq AI market report generation failed');
    }
}

module.exports = {
    generateReviewSummary,
    analyzeDeal,
    chatWithAssistant,
    generateDashboardInsights,
    generateMarketReport
};
