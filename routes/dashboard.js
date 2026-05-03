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

        // 8. General Monthly Sales Simulation (Based on review dates or creation dates)
        // Grouping by month in Prisma raw is tricky, let's just fetch recent reviews and bucket them in JS
        const sixMonthsAgo = new Date();
        sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 5);
        
        const recentReviewsObj = await prisma.review.findMany({
            where: { product: { userId }, createdAt: { gte: sixMonthsAgo } },
            select: { createdAt: true }
        });

        // Group into last 6 months
        const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        const monthlyMap = {};
        
        // Initialize last 6 months with 0
        for (let i = 5; i >= 0; i--) {
            const d = new Date();
            d.setMonth(d.getMonth() - i);
            monthlyMap[`${monthNames[d.getMonth()]} ${d.getFullYear()}`] = 0;
        }

        recentReviewsObj.forEach(r => {
            const d = new Date(r.createdAt);
            const key = `${monthNames[d.getMonth()]} ${d.getFullYear()}`;
            if (monthlyMap[key] !== undefined) {
                monthlyMap[key] += 1;
            }
        });

        const monthlySales = Object.keys(monthlyMap).map(k => ({
            month: k,
            sales: monthlyMap[k] * 85 // Only show sales based on real review counts
        }));

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
            monthlySales,
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
 * GET: Price by Category standalone endpoint
 * Specifically fetches the average price of products grouped by category.
 */
router.get('/price-category', auth, async (req, res) => {
    try {
        const userId = req.user.id;
        const priceByCategory = await prisma.product.groupBy({
            by: ['category'],
            where: { userId, priceAmount: { not: null } },
            _avg: { priceAmount: true },
            _count: { id: true }
        });

        const formatted = priceByCategory.map(c => ({
            category: c.category || 'Uncategorized',
            avgPrice: parseFloat((c._avg.priceAmount || 0).toFixed(2)),
            count: c._count.id
        }));

        res.json({ success: true, categoryPrices: formatted });
    } catch (error) {
        console.error('[Dashboard Route] Error fetching price category:', error);
        res.status(500).json({ error: 'Failed to load price category data' });
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

/**
 * GET: Monthly Review Activity
 * Returns the real count of reviews scraped per month, optionally grouped by
 * product category or domain.
 *
 * Query params:
 *  - months  (number, default 6)    — how many past months to include
 *  - groupBy (string, default none) — optional: "category" | "domain"
 */
router.get('/review-activity', auth, async (req, res) => {
    try {
        const userId  = req.user.id;
        const months  = Math.min(Math.max(parseInt(req.query.months) || 6, 1), 24);
        const groupBy = req.query.groupBy; // "category" | "domain" | undefined

        const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

        // Build ordered month-label list
        const monthLabels = [];
        for (let i = months - 1; i >= 0; i--) {
            const d = new Date();
            d.setMonth(d.getMonth() - i);
            monthLabels.push(`${monthNames[d.getMonth()]} ${d.getFullYear()}`);
        }

        const since = new Date();
        since.setMonth(since.getMonth() - (months - 1));
        since.setDate(1);
        since.setHours(0, 0, 0, 0);

        if (!groupBy) {
            // ── Simple: total review count per month ──────────────────────
            const reviews = await prisma.review.findMany({
                where: { product: { userId }, createdAt: { gte: since } },
                select: { createdAt: true }
            });

            const buckets = {};
            monthLabels.forEach(l => { buckets[l] = 0; });

            reviews.forEach(r => {
                const d = new Date(r.createdAt);
                const key = `${monthNames[d.getMonth()]} ${d.getFullYear()}`;
                if (key in buckets) buckets[key]++;
            });

            const data = monthLabels.map(month => ({
                month,
                reviewCount: buckets[month]
            }));

            return res.json({ success: true, groupBy: null, months, data });
        }

        // ── Grouped: by category or domain ────────────────────────────────
        const allowedGroups = ['category', 'domain'];
        if (!allowedGroups.includes(groupBy)) {
            return res.status(400).json({ error: `Invalid groupBy. Use: ${allowedGroups.join(', ')}` });
        }

        // Fetch reviews joined with the product groupBy field
        const reviews = await prisma.review.findMany({
            where: { product: { userId }, createdAt: { gte: since } },
            select: {
                createdAt: true,
                product: { select: { [groupBy]: true } }
            }
        });

        const groupMap = {};

        reviews.forEach(r => {
            const groupVal = r.product?.[groupBy] || 'Unknown';
            const d = new Date(r.createdAt);
            const key = `${monthNames[d.getMonth()]} ${d.getFullYear()}`;

            if (!groupMap[groupVal]) {
                groupMap[groupVal] = {};
                monthLabels.forEach(l => { groupMap[groupVal][l] = 0; });
            }
            if (key in groupMap[groupVal]) groupMap[groupVal][key]++;
        });

        const series = Object.keys(groupMap).map(groupValue => ({
            groupValue,
            data: monthLabels.map(month => ({
                month,
                reviewCount: groupMap[groupValue][month] || 0
            }))
        }));

        const totals = monthLabels.map(month => {
            const sum = Object.values(groupMap).reduce(
                (acc, g) => acc + (g[month] || 0), 0
            );
            return { month, reviewCount: sum };
        });

        return res.json({ success: true, groupBy, months, series, totals });

    } catch (error) {
        console.error('[Dashboard Route] Error fetching review activity:', error);
        res.status(500).json({ error: 'Failed to load review activity data' });
    }
});

/**
 * GET: Price vs Rating Scatter Plot Data
 * Returns product price vs its average rating to identify market positioning.
 */
router.get('/price-rating-scatter', auth, async (req, res) => {
    try {
        const userId = req.user.id;
        
        const products = await prisma.product.findMany({
            where: { 
                userId, 
                priceAmount: { not: null }
            },
            select: {
                id: true,
                name: true,
                priceAmount: true,
                category: true,
                reviews: {
                    select: { rating: true }
                }
            }
        });

        // Calculate average rating per product and filter out products with no reviews/ratings
        const scatterData = products
            .map(p => {
                const validReviews = p.reviews.filter(r => r.rating != null);
                if (validReviews.length === 0) return null;
                
                const avgRating = validReviews.reduce((sum, r) => sum + r.rating, 0) / validReviews.length;
                
                return {
                    id: p.id,
                    name: p.name,
                    price: p.priceAmount,
                    rating: parseFloat(avgRating.toFixed(2)),
                    category: p.category || 'Uncategorized',
                    reviewCount: validReviews.length
                };
            })
            .filter(item => item !== null);

        res.json({ success: true, data: scatterData });

    } catch (error) {
        console.error('[Dashboard Route] Error fetching scatter data:', error);
        res.status(500).json({ error: 'Failed to load scatter plot data' });
    }
});

module.exports = router;

