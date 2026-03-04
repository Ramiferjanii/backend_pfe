const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { scrapeWebsiteTask } = require('../services/scraperService');
const auth = require('../middleware/auth');

// Helper to format website for frontend
const formatWebsite = (site) => ({
    id: site.id,
    name: site.name,
    url: site.url,
    description: site.description,
    category: site.category,
    scrapeFrequency: site.scrapeFrequency,
    isActive: site.isActive,
    status: site.lastScraped ? 'Active' : 'Pending',
    lastScraped: site.lastScraped,
    scrapedData: site.scrapedData || {},
    productCount: site.scrapedData && site.scrapedData.count ? site.scrapedData.count : 0,
    userId: site.userId,
    createdAt: site.createdAt,
    updatedAt: site.updatedAt
});

// GET: List all websites (Scoped to User)
router.get('/', auth, async (req, res) => {
    try {
        const { category, isActive, page, limit } = req.query;

        const pLimit = parseInt(limit) || 10;
        const pPage = parseInt(page) || 1;
        const skip = (pPage - 1) * pLimit;

        const where = {
            userId: req.user.id
        };

        if (category && category.trim()) where.category = category.trim();
        if (isActive !== undefined) where.isActive = isActive === 'true';

        console.log(`DEBUG - Prisma Websites Query: User=${req.user.id}`);

        const [websites, total] = await prisma.$transaction([
            prisma.website.findMany({
                where,
                skip,
                take: pLimit,
                orderBy: { createdAt: 'desc' }
            }),
            prisma.website.count({ where })
        ]);

        res.json({
            websites: websites.map(formatWebsite),
            pagination: {
                total,
                page: pPage,
                limit: pLimit,
                totalPages: Math.ceil(total / pLimit)
            }
        });
    } catch (error) {
        console.error('--- PRISMA WEBSITES ERROR ---');
        console.error('Message:', error.message);
        res.status(500).json({ error: "Database Error", details: error.message });
    }
});

// GET: Get single website
router.get('/:id', auth, async (req, res) => {
    try {
        const website = await prisma.website.findUnique({
            where: { id: req.params.id }
        });

        if (!website) return res.status(404).json({ error: 'Website not found' });

        // Check ownership
        if (website.userId && website.userId !== req.user.id) {
            return res.status(403).json({ error: 'Access denied' });
        }

        res.json({ website: formatWebsite(website) });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// POST: Add a new website
router.post('/', auth, async (req, res) => {
    try {
        const { name, url, description, category, scrapeFrequency, isActive } = req.body;

        if (!name || !url) {
            return res.status(400).json({ error: 'Name and URL are required fields' });
        }

        // duplicate check by URL (scoped to USER)
        const existing = await prisma.website.findFirst({
            where: {
                url,
                userId: req.user.id
            }
        });

        if (existing) {
            return res.status(409).json({ error: 'Website with this URL already exists' });
        }

        const newWebsite = await prisma.website.create({
            data: {
                name,
                url,
                description,
                category: category || 'general',
                scrapeFrequency: scrapeFrequency || 'on-demand',
                isActive: isActive !== undefined ? isActive : true,
                userId: req.user.id,
                scrapedData: {}
            }
        });

        res.status(201).json({
            message: 'Website created successfully',
            website: formatWebsite(newWebsite)
        });
    } catch (error) {
        console.error('Error creating website:', error);
        res.status(500).json({ error: error.message });
    }
});

// PUT: Update a website
router.put('/:id', auth, async (req, res) => {
    try {
        // Verify ownership first
        const existing = await prisma.website.findUnique({
            where: { id: req.params.id }
        });

        if (!existing) return res.status(404).json({ error: 'Website not found' });
        if (existing.userId && existing.userId !== req.user.id) {
            return res.status(403).json({ error: 'Access denied' });
        }

        const { name, url, description, category, scrapeFrequency, isActive } = req.body;

        const updatedWebsite = await prisma.website.update({
            where: { id: req.params.id },
            data: {
                name,
                url,
                description,
                category,
                scrapeFrequency,
                isActive
            }
        });

        res.json({
            message: 'Website updated successfully',
            website: formatWebsite(updatedWebsite)
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// DELETE: Delete a website
router.delete('/:id', auth, async (req, res) => {
    try {
        // Verify ownership
        const existing = await prisma.website.findUnique({
            where: { id: req.params.id }
        });

        if (!existing) return res.status(404).json({ error: 'Website not found' });
        if (existing.userId && existing.userId !== req.user.id) {
            return res.status(403).json({ error: 'Access denied' });
        }

        await prisma.website.delete({
            where: { id: req.params.id }
        });
        res.json({ message: 'Website deleted successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// POST: Trigger manual scrape
router.post('/:id/scrape-trigger', auth, async (req, res) => {
    try {
        const websiteId = req.params.id;
        const { mode = 'static', url, filters } = req.body;

        // Verify existence and ownership
        const website = await prisma.website.findUnique({
            where: { id: websiteId }
        });

        if (!website) return res.status(404).json({ error: 'Website not found' });
        if (website.userId && website.userId !== req.user.id) {
            return res.status(403).json({ error: 'Access denied' });
        }

        // Determine target URL: Custom URL > Website Default URL
        const targetUrl = url && url.trim() ? url.trim() : website.url;

        if (!targetUrl || !targetUrl.trim()) {
            return res.status(400).json({ error: 'Website URL is missing or invalid' });
        }

        console.log(`Triggering Scrape for ${website.name}. URL: ${targetUrl}, Mode: ${mode}`);

        // Run Task Asynchronously
        scrapeWebsiteTask(websiteId, mode, targetUrl.trim(), filters, req.user.id)
            .then(() => console.log(`Scraping task for ${websiteId} completed.`))
            .catch(err => console.error(`Scraping task for ${websiteId} failed:`, err));

        res.status(202).json({
            message: `Scraping started in background. Status will update shortly.`,
            status: 'in-progress',
            filters: filters || null
        });
    } catch (error) {
        console.error('Scrape trigger error:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
