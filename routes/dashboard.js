const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const auth = require('../middleware/auth');
const { generateDashboardInsights } = require('../services/aiService');

/**
 * GET: Dashboard Statistics
 * Aggregates site-wide stats for this specific user.
 */
router.get('/stats', auth, async (req, res) => {
    try {
        const userId = req.user.id;
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

        // 1. Core Counts
        const websiteCount = await prisma.website.count({ where: { userId } });
        const productCount = await prisma.product.count({ where: { userId } });
        
        // 2. Reviews Summary
        const reviewsCount = await prisma.review.count({
            where: { product: { userId } }
        });

        const avgRatingObj = await prisma.review.aggregate({
            _avg: { rating: true },
            where: { product: { userId } }
        });

        const sentimentCounts = await prisma.review.groupBy({
            by: ['sentiment'],
            where: { product: { userId } },
            _count: { id: true }
        });

        // 3. Recent Activity (Last 7 Days)
        const recentScrapes = await prisma.product.count({
            where: {
                userId,
                createdAt: { gte: sevenDaysAgo }
            }
        });

        // 4. Products by Domain (for chart)
        const productsByDomain = await prisma.product.groupBy({
            by: ['domain'],
            where: { userId },
            _count: { id: true }
        });

        // 5. Price Analysis by Category
        const priceByCategory = await prisma.product.groupBy({
            by: ['category'],
            where: { userId, priceAmount: { not: null } },
            _avg: { priceAmount: true },
            _count: { id: true }
        });

        // 6. Review Volume by Domain (Manual aggregate since Prisma doesn't support relation count in groupBy)
        const productReviews = await prisma.product.findMany({
            where: { userId },
            select: { 
                domain: true, 
                _count: { select: { reviews: true } } 
            }
        });

        const domainReviewsMap = {};
        productReviews.forEach(p => {
            const domain = p.domain || 'Unknown';
            domainReviewsMap[domain] = (domainReviewsMap[domain] || 0) + p._count.reviews;
        });

        const domainReviews = Object.keys(domainReviewsMap).map(domain => ({
            domain,
            count: domainReviewsMap[domain]
        }));

        // 7. Overall Rating Distribution (1-5)
        const ratingDist = await prisma.review.groupBy({
            by: ['rating'],
            where: { product: { userId } },
            _count: { id: true }
        });

        // Format sentiment breakdown
        const sentimentMap = { positive: 0, neutral: 0, negative: 0 };
        sentimentCounts.forEach(s => {
            if (s.sentiment) sentimentMap[s.sentiment] = s._count.id;
        });

        res.json({
            websiteCount,
            productCount,
            reviewCount: reviewsCount,
            avgRating: avgRatingObj._avg.rating || 0,
            sentimentBreakdown: sentimentMap,
            recentScrapes,
            domainDistribution: productsByDomain.map(d => ({
                domain: d.domain,
                count: d._count.id
            })),
            categoryPrices: priceByCategory.map(c => ({
                category: c.category || 'Uncategorized',
                avgPrice: parseFloat((c._avg.priceAmount || 0).toFixed(2)),
                count: c._count.id
            })),
            domainReviews: domainReviews,
            ratingDistribution: [1, 2, 3, 4, 5].map(r => ({
                rating: r,
                count: ratingDist.find(d => Math.floor(d.rating || 0) === r)?._count.id || 0
            }))
        });
    } catch (error) {
        console.error('[Dashboard Route] Error:', error);
        res.status(500).json({ error: 'Failed to load dashboard statistics' });
    }
});

/**
 * GET: AI Dashboard Insights
 * Uses Groq to analyze the aggregated statistics.
 */
router.get('/insights', auth, async (req, res) => {
    try {
        const userId = req.user.id;
        
        // Fetch stats first (dry re-run or shared function)
        // Here we'll just re-fetch briefly for simplicity
        const websiteCount = await prisma.website.count({ where: { userId } });
        const productCount = await prisma.product.count({ where: { userId } });
        const reviewsCount = await prisma.review.count({ where: { product: { userId } } });
        const avgRatingObj = await prisma.review.aggregate({
            _avg: { rating: true },
            where: { product: { userId } }
        });
        const sentimentCounts = await prisma.review.groupBy({
            by: ['sentiment'],
            where: { product: { userId } },
            _count: { id: true }
        });
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
        const recentScrapes = await prisma.product.count({
            where: { userId, createdAt: { gte: sevenDaysAgo } }
        });

        const sentimentMap = { positive: 0, neutral: 0, negative: 0 };
        sentimentCounts.forEach(s => {
            if (s.sentiment) sentimentMap[s.sentiment] = s._count.id;
        });

        const stats = {
            websiteCount,
            productCount,
            reviewCount: reviewsCount,
            avgRating: avgRatingObj._avg.rating || 0,
            sentimentBreakdown: sentimentMap,
            recentScrapes
        };

        const insights = await generateDashboardInsights(stats);
        res.json({ success: true, insights });
    } catch (error) {
        console.error('[Dashboard Route] AI error:', error);
        res.status(500).json({ error: 'Failed to generate AI insights' });
    }
});

module.exports = router;
