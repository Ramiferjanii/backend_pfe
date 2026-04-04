const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const auth = require('../middleware/auth');

const { Parser } = require('json2csv');

// Helper to format Prisma product to API format (if needed, but Prisma returns objects already)
const formatProduct = (product) => ({
    ...product,
    priceAmount: product.priceAmount ? parseFloat(product.priceAmount) : 0,
});

// GET: Export products for a website as CSV (Protected)
router.get('/export/:websiteId', auth, async (req, res) => {
    try {
        const websiteId = req.params.websiteId;

        // Fetch products for user and website
        const products = await prisma.product.findMany({
            where: {
                websiteId: websiteId,
                userId: req.user.id
            },
            orderBy: { createdAt: 'desc' }
        });

        if (!products || products.length === 0) {
            return res.status(404).json({ error: 'No products found to export' });
        }

        // Convert to CSV
        const fields = ['name', 'price', 'reference', 'category', 'url', 'domain', 'image', 'createdAt'];
        const json2csvParser = new Parser({ fields });
        const csv = json2csvParser.parse(products);

        // Send as file download
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename=products_export_${websiteId}.csv`);
        res.status(200).send(csv);

    } catch (error) {
        console.error('--- EXPORT ERROR ---', error.message);
        res.status(500).json({ error: "Export Error", details: error.message });
    }
});

// GET: List products with filtering (Protected)
router.get('/', auth, async (req, res) => {
    try {
        const {
            minPrice,
            maxPrice,
            name,
            category,
            websiteId,
            domain,
            page,
            limit
        } = req.query;

        // Ensure we have numbers for pagination
        const pLimit = parseInt(limit) || 20;
        const pPage = parseInt(page) || 1;
        const skipping = (pPage - 1) * pLimit;

        const where = {
            userId: req.user.id
        };

        // Price range filtering
        if (minPrice || maxPrice) {
            where.priceAmount = {};
            if (minPrice && !isNaN(parseFloat(minPrice))) {
                where.priceAmount.gte = parseFloat(minPrice);
            }
            if (maxPrice && !isNaN(parseFloat(maxPrice))) {
                where.priceAmount.lte = parseFloat(maxPrice);
            }
        }

        // Name search (partial match)
        if (name && name.trim()) {
            where.name = {
                contains: name.trim(),
                mode: 'insensitive' // specific to Postgres
            };
        }

        // Category filter
        if (category && category.trim()) {
            where.category = category.trim();
        }

        // Website filter
        if (websiteId && websiteId.trim()) {
            where.websiteId = websiteId.trim();
        }

        // Domain filter
        if (domain && domain.trim()) {
            where.domain = domain.trim();
        }

        console.log(`DEBUG - Prisma Products Query: User=${req.user.id} Limit=${pLimit} Offset=${skipping}`);

        const [products, total] = await prisma.$transaction([
            prisma.product.findMany({
                where,
                take: pLimit,
                skip: skipping,
                orderBy: {
                    createdAt: 'desc'
                }
            }),
            prisma.product.count({ where })
        ]);

        res.json({
            products: products.map(formatProduct),
            pagination: {
                total,
                page: pPage,
                limit: pLimit,
                totalPages: Math.ceil(total / pLimit)
            }
        });
    } catch (error) {
        console.error('--- PRISMA QUERY ERROR ---');
        console.error('Message:', error.message);
        res.status(500).json({
            error: "Database Error",
            details: error.message
        });
    }
});

// GET: Use Groq AI to analyze if the product's price is a good deal
router.get('/:id/deal-analysis', auth, async (req, res) => {
    try {
        const product = await prisma.product.findUnique({ where: { id: req.params.id } });
        if (!product) return res.status(404).json({ error: 'Product not found' });
        if (product.userId && product.userId !== req.user.id) return res.status(403).json({ error: 'Access denied' });

        const { analyzeDeal } = require('../services/aiService');
        const dealAnalysis = await analyzeDeal(req.params.id);
        res.json({ success: true, analysis: dealAnalysis });
    } catch (error) {
        console.error('Deal analysis error:', error);
        res.status(500).json({ error: 'Failed to analyze deal', details: error.message });
    }
});

// GET: Get single product by ID (Protected)
router.get('/:id', auth, async (req, res) => {
    try {
        const product = await prisma.product.findUnique({
            where: { id: req.params.id }
        });

        if (!product) {
            return res.status(404).json({ error: 'Product not found' });
        }

        // Ownership check
        if (product.userId && product.userId !== req.user.id) {
            return res.status(403).json({ error: 'Access denied' });
        }

        res.json({ product: formatProduct(product) });
    } catch (error) {
        console.error('Error fetching product:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST: Categorize uncategorized products using AI
router.post('/categorize-all', auth, async (req, res) => {
    try {
        const uncategorizedProducts = await prisma.product.findMany({
            where: {
                userId: req.user.id,
                OR: [
                    { category: null },
                    { category: '' },
                    { category: 'Uncategorized' }
                ]
            },
            take: 20 // limit to 20 to avoid rate limits
        });

        if (uncategorizedProducts.length === 0) {
            return res.json({ success: true, message: 'All products are already categorized!' });
        }

        const { generateCategoryForProduct } = require('../services/aiService');
        let updatedCount = 0;

        for (const product of uncategorizedProducts) {
            const aiCategory = await generateCategoryForProduct(product.name, product.overview);
            
            if (aiCategory && aiCategory !== "Unknown") {
                await prisma.product.update({
                    where: { id: product.id },
                    data: { category: aiCategory }
                });
                updatedCount++;
            }
        }

        res.json({ success: true, message: `Successfully categorized ${updatedCount} products.` });
    } catch (error) {
        console.error('Categorize error:', error);
        res.status(500).json({ error: 'Failed to categorize products' });
    }
});

module.exports = router;

