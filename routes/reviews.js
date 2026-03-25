/**
 * routes/reviews.js
 * -----------------
 * REST API routes for the Amazon review + VADER sentiment workflow.
 *
 * Endpoints:
 *  POST /api/reviews/fetch/:productId          → trigger review fetch for one product
 *  POST /api/reviews/fetch-batch               → trigger review fetch for many products
 *  GET  /api/reviews/:productId                → list saved reviews for a product
 *  GET  /api/reviews/:productId/summary        → get saved sentiment summary for a product
 *  DELETE /api/reviews/:productId              → delete all reviews for a product
 */

const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const auth = require('../middleware/auth');
const {
    fetchAndSaveReviews,
    fetchAndSaveReviewsBatch,
} = require('../services/reviewService');


// ─── POST /api/reviews/fetch/:productId ──────────────────────────────────────
/**
 * Trigger the Amazon review scraping + VADER pipeline for a single product.
 *
 * Body params (optional):
 *  - maxReviews {number}  default: 20
 *  - asin       {string}  skip Amazon search, use this ASIN directly
 */
router.post('/fetch/:productId', auth, async (req, res) => {
    const { productId } = req.params;
    const { maxReviews = 20, asin = null } = req.body;

    // Verify the product belongs to the requesting user
    const product = await prisma.product.findUnique({
        where: { id: productId },
        select: { id: true, userId: true, name: true, reference: true },
    });

    if (!product) {
        return res.status(404).json({ error: 'Product not found' });
    }

    if (product.userId && product.userId !== req.user.id) {
        return res.status(403).json({ error: 'Access denied' });
    }

    console.log(
        `[Reviews API] User ${req.user.id} triggered review fetch for product ${productId}`
    );

    try {
        const result = await fetchAndSaveReviews(productId, {
            maxReviews: parseInt(maxReviews) || 20,
            asin,
        });

        return res.json({
            success: true,
            productId,
            asin: result.asin,
            savedCount: result.savedCount,
            summary: result.summary,
        });
    } catch (err) {
        console.error('[Reviews API] fetch error:', err.message);
        return res.status(500).json({
            error: 'Review fetch failed',
            details: err.message,
        });
    }
});


// ─── POST /api/reviews/fetch-batch ───────────────────────────────────────────
/**
 * Trigger review fetching for multiple products.
 *
 * Body:
 *  {
 *    productIds: ["uuid1", "uuid2", ...],
 *    maxReviews: 10   // optional, default 20
 *  }
 */
router.post('/fetch-batch', auth, async (req, res) => {
    const { productIds, maxReviews = 10 } = req.body;

    if (!Array.isArray(productIds) || productIds.length === 0) {
        return res.status(400).json({ error: 'productIds must be a non-empty array' });
    }

    // Verify ownership – filter to only products that belong to the user
    const ownedProducts = await prisma.product.findMany({
        where: {
            id: { in: productIds },
            userId: req.user.id,
        },
        select: { id: true },
    });

    const allowedIds = ownedProducts.map((p) => p.id);

    if (allowedIds.length === 0) {
        return res.status(403).json({ error: 'None of the provided products belong to you' });
    }

    console.log(
        `[Reviews API] Batch fetch for ${allowedIds.length} products by user ${req.user.id}`
    );

    try {
        const results = await fetchAndSaveReviewsBatch(allowedIds, {
            maxReviews: parseInt(maxReviews) || 10,
        });

        const succeeded = results.filter((r) => r.status === 'success').length;
        const failed = results.filter((r) => r.status === 'error').length;

        return res.json({
            success: true,
            total: allowedIds.length,
            succeeded,
            failed,
            results,
        });
    } catch (err) {
        console.error('[Reviews API] batch fetch error:', err.message);
        return res.status(500).json({
            error: 'Batch review fetch failed',
            details: err.message,
        });
    }
});


// ─── GET /api/reviews/:productId ─────────────────────────────────────────────
/**
 * Return paginated list of saved reviews for a product.
 * Query params: page, limit, sentiment (positive|neutral|negative)
 */
router.get('/:productId', auth, async (req, res) => {
    const { productId } = req.params;
    const {
        page = 1,
        limit = 20,
        sentiment = null,
    } = req.query;

    // Ownership check
    const product = await prisma.product.findUnique({
        where: { id: productId },
        select: { userId: true },
    });

    if (!product) return res.status(404).json({ error: 'Product not found' });

    if (product.userId && product.userId !== req.user.id) {
        return res.status(403).json({ error: 'Access denied' });
    }

    const pLimit = parseInt(limit) || 20;
    const pPage = parseInt(page) || 1;
    const skip = (pPage - 1) * pLimit;

    const where = { productId };
    if (sentiment && ['positive', 'neutral', 'negative'].includes(sentiment)) {
        where.sentiment = sentiment;
    }

    try {
        const [reviews, total] = await prisma.$transaction([
            prisma.review.findMany({
                where,
                take: pLimit,
                skip,
                orderBy: { createdAt: 'desc' },
            }),
            prisma.review.count({ where }),
        ]);

        return res.json({
            reviews,
            pagination: {
                total,
                page: pPage,
                limit: pLimit,
                totalPages: Math.ceil(total / pLimit),
            },
        });
    } catch (err) {
        console.error('[Reviews API] list error:', err.message);
        return res.status(500).json({ error: 'Database error', details: err.message });
    }
});


// ─── GET /api/reviews/:productId/summary ─────────────────────────────────────
/**
 * Return a live sentiment summary computed from saved reviews in the DB.
 */
router.get('/:productId/summary', auth, async (req, res) => {
    const { productId } = req.params;

    // Ownership check
    const product = await prisma.product.findUnique({
        where: { id: productId },
        select: { userId: true, name: true },
    });

    if (!product) return res.status(404).json({ error: 'Product not found' });

    if (product.userId && product.userId !== req.user.id) {
        return res.status(403).json({ error: 'Access denied' });
    }

    try {
        const [total, positive, neutral, negative, aggResult] = await prisma.$transaction([
            prisma.review.count({ where: { productId } }),
            prisma.review.count({ where: { productId, sentiment: 'positive' } }),
            prisma.review.count({ where: { productId, sentiment: 'neutral' } }),
            prisma.review.count({ where: { productId, sentiment: 'negative' } }),
            prisma.review.aggregate({
                where: { productId },
                _avg: { compound: true, rating: true },
            }),
        ]);

        const averageCompound = aggResult._avg.compound ?? 0;
        const averageRating = aggResult._avg.rating ?? 0;

        let overallSentiment = 'neutral';
        if (averageCompound >= 0.05) overallSentiment = 'positive';
        if (averageCompound <= -0.05) overallSentiment = 'negative';

        return res.json({
            productId,
            productName: product.name,
            summary: {
                total,
                positive,
                neutral,
                negative,
                averageRating: parseFloat(averageRating.toFixed(2)),
                averageCompound: parseFloat(averageCompound.toFixed(4)),
                overallSentiment,
            },
        });
    } catch (err) {
        console.error('[Reviews API] summary error:', err.message);
        return res.status(500).json({ error: 'Database error', details: err.message });
    }
});


// ─── DELETE /api/reviews/:productId ──────────────────────────────────────────
/**
 * Delete all reviews for a product (ownership required).
 */
router.delete('/:productId', auth, async (req, res) => {
    const { productId } = req.params;

    const product = await prisma.product.findUnique({
        where: { id: productId },
        select: { userId: true },
    });

    if (!product) return res.status(404).json({ error: 'Product not found' });

    if (product.userId && product.userId !== req.user.id) {
        return res.status(403).json({ error: 'Access denied' });
    }

    try {
        const { count } = await prisma.review.deleteMany({ where: { productId } });
        return res.json({ success: true, deleted: count });
    } catch (err) {
        console.error('[Reviews API] delete error:', err.message);
        return res.status(500).json({ error: 'Database error', details: err.message });
    }
});


// ─── GET /api/reviews/:productId/ai-summary ──────────────────────────────────
/**
 * Uses Groq to read all stored reviews for a product and return a Pros, Cons, and Verdict JSON.
 */
router.get('/:productId/ai-summary', auth, async (req, res) => {
    const { productId } = req.params;

    // Verify ownership
    const product = await prisma.product.findUnique({
        where: { id: productId },
        select: { userId: true },
    });

    if (!product) return res.status(404).json({ error: 'Product not found' });
    if (product.userId && product.userId !== req.user.id) {
        return res.status(403).json({ error: 'Access denied' });
    }

    try {
        const { generateReviewSummary } = require('../services/aiService');
        const summary = await generateReviewSummary(productId);
        return res.json({ success: true, aiVerdict: summary });
    } catch (err) {
        console.error('[Reviews API] AI summary error:', err.message);
        return res.status(500).json({ error: 'Failed to generate AI verdict', details: err.message });
    }
});


// ─── GET /api/reviews/:productId/trends ────────────────────────────────────
/**
 * Returns review volume over time (grouped by year).
 */
router.get('/:productId/trends', auth, async (req, res) => {
    const { productId } = req.params;

    try {
        const reviews = await prisma.review.findMany({
            where: { productId },
            select: { reviewDate: true },
        });

        // Simple year extraction from string (e.g., "January 1, 2024")
        const yearCounts = {};
        reviews.forEach(r => {
            if (r.reviewDate) {
                const match = r.reviewDate.match(/\d{4}/); // find 4 consecutive digits
                if (match) {
                    const year = match[0];
                    yearCounts[year] = (yearCounts[year] || 0) + 1;
                }
            }
        });

        // Convert to sorted array for chart
        const sortedYears = Object.keys(yearCounts).sort();
        const trends = sortedYears.map(year => ({
            year,
            count: yearCounts[year]
        }));

        return res.json({ success: true, trends });
    } catch (err) {
        console.error('[Reviews API] Trends error:', err.message);
        return res.status(500).json({ error: 'Database error', details: err.message });
    }
});


module.exports = router;
