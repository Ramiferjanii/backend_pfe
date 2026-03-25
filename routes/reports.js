const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const auth = require('../middleware/auth');
const { generateMarketReport } = require('../services/aiService');

/**
 * GET: Get available categories for report selection
 */
router.get('/categories', auth, async (req, res) => {
    try {
        const products = await prisma.product.findMany({
            where: { userId: req.user.id },
            select: { name: true, category: true }
        });
        
        const categoriesSet = new Set();
        products.forEach(p => {
            if (p.category && p.category.trim() !== "") {
                categoriesSet.add(p.category);
            } else if (p.name) {
                const name = p.name.toLowerCase();
                if (name.includes('laptop') || name.includes('portable')) categoriesSet.add('Laptop');
                else if (name.includes('casque') || name.includes('headset') || name.includes('headphones')) categoriesSet.add('Casque');
                else if (name.includes('pc') || name.includes('desktop') || name.includes('ordinateur')) categoriesSet.add('PC Desktop');
                else if (name.includes('smartphone') || name.includes('téléphone') || name.includes('phone')) categoriesSet.add('Smartphone');
                else categoriesSet.add('General');
            }
        });
        
        res.json({ categories: Array.from(categoriesSet) });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch categories' });
    }
});

/**
 * POST: Generate AI Report for a Category
 */
router.post('/generate', auth, async (req, res) => {
    let { category } = req.body;
    const userId = req.user.id;
    console.log(`[Reports API] Generating report for: ${category} (User: ${userId})`);

    let fullWhere = { userId };

    // Smart Filter based on keywords if the user picks inferred names
    if (category === 'Laptop') {
        fullWhere.AND = [
            { OR: [{ category: 'Laptop' }, { category: '' }, { category: null }] },
            { OR: [
                { name: { contains: 'laptop', mode: 'insensitive' } },
                { name: { contains: 'portable', mode: 'insensitive' } },
                { name: { contains: 'notebook', mode: 'insensitive' } }
            ]}
        ];
    } else if (category === 'Casque') {
        fullWhere.AND = [
            { OR: [{ category: 'Casque' }, { category: '' }, { category: null }] },
            { OR: [
                { name: { contains: 'casque', mode: 'insensitive' } },
                { name: { contains: 'headset', mode: 'insensitive' } },
                { name: { contains: 'headphones', mode: 'insensitive' } }
            ]}
        ];
    } else if (category === 'PC Desktop') {
        fullWhere.AND = [
            { OR: [{ category: 'PC Desktop' }, { category: '' }, { category: null }] },
            { OR: [
                { name: { contains: 'pc', mode: 'insensitive' } },
                { name: { contains: 'desktop', mode: 'insensitive' } },
                { name: { contains: 'ordinateur', mode: 'insensitive' } }
            ]}
        ];
    } else if (category === 'Smartphone') {
        fullWhere.AND = [
            { OR: [{ category: 'Smartphone' }, { category: '' }, { category: null }] },
            { OR: [
                { name: { contains: 'phone', mode: 'insensitive' } },
                { name: { contains: 'téléphone', mode: 'insensitive' } },
                { name: { contains: 'mobile', mode: 'insensitive' } }
            ]}
        ];
    } else if (category === 'General' || !category) {
        fullWhere.OR = [{ category: '' }, { category: null }];
    } else {
        fullWhere.category = category;
    }

    try {
        console.log(`[Reports API] Query:`, JSON.stringify(fullWhere, null, 2));

        // Collect stats for this category
        const productsCount = await prisma.product.count({
            where: fullWhere
        });
        
        console.log(`[Reports API] Found ${productsCount} products.`);

        if (productsCount === 0) {
            return res.status(404).json({ error: 'No products found in this category' });
        }

        const stats = await prisma.product.aggregate({
            where: { ...fullWhere, priceAmount: { not: null } },
            _avg: { priceAmount: true },
            _max: { priceAmount: true },
            _min: { priceAmount: true }
        });

        const reviews = await prisma.review.findMany({
            where: { product: fullWhere },
            select: { title: true, rating: true },
            take: 5,
            orderBy: { createdAt: 'desc' }
        });

        const avgRating = await prisma.review.aggregate({
            where: { product: fullWhere },
            _avg: { rating: true }
        });

        const formattedStats = {
            count: productsCount,
            avgPrice: stats._avg.priceAmount || 0,
            maxPrice: stats._max.priceAmount || 0,
            minPrice: stats._min.priceAmount || 0,
            avgRating: avgRating._avg.rating || 0,
            recentFeedback: reviews.map(r => `(${r.rating}*): ${r.title || 'General feedback'}`)
        };

        const report = await generateMarketReport(category, formattedStats);
        res.json({ success: true, report });

    } catch (error) {
        console.error('[Reports API] Error:', error);
        res.status(500).json({ error: 'AI report generation failed' });
    }
});

module.exports = router;
