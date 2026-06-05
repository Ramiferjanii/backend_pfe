const { spawn } = require('child_process');
const path = require('path');
const prisma = require('../lib/prisma');

/**
 * Scrapes a website using the Python scraper script.
 * @param {string} websiteId - The ID of the website
 * @param {string} mode - 'static' or 'selenium'
 * @returns {Promise<Object>} - The updated data
 */
async function scrapeWebsiteTask(websiteId, mode = 'auto', url, filters = {}, userId = null) {
    if (!url) {
        console.error(`ERROR: URL is missing for website task: ID=${websiteId}`);
        throw new Error("URL is required for scraping");
    }
    console.log(`Starting scrapeWebsiteTask for ID: ${websiteId}, Mode: ${mode}, URL: ${url}`);

    return new Promise((resolve, reject) => {
        // ... (lines 24-110 omitted for brevity, logic remains same)
        const fs = require('fs');
        let pythonPath = 'python'; // Default system fallback

        // Potential paths for virtual environment python
        const venvPath = path.join(__dirname, '../../.venv/Scripts/python.exe');
        const venvPathUnix = path.join(__dirname, '../../.venv/bin/python');

        if (fs.existsSync(venvPath)) {
            pythonPath = venvPath;
        } else if (fs.existsSync(venvPathUnix)) {
            pythonPath = venvPathUnix;
        } else {
            // Check for python3 first (common in Linux/Render)
            pythonPath = 'python3';
        }

        const scriptPath = path.join(__dirname, '../python_scraper/scraper.py');

        console.log(`Executing Python scraper using: ${pythonPath} for ID: ${websiteId}`);

        // Build arguments with filters
        const args = [scriptPath, websiteId, mode, url || ''];

        // Add filter arguments if provided
        if (filters?.minPrice) args.push('--minPrice', String(filters.minPrice));
        if (filters?.maxPrice) args.push('--maxPrice', String(filters.maxPrice));
        if (filters?.name) args.push('--nameFilter', String(filters.name));
        if (filters?.reference) args.push('--referenceFilter', String(filters.reference));

        console.log(`Python args: ${args.join(' ')}`);
        console.log(`[SCRAPER] Spawning: ${pythonPath} with URL=${url}, Mode=${mode}`);
        const pythonProcess = spawn(pythonPath, args);

        pythonProcess.on('error', async (err) => {
            console.error('Failed to start Python process:', err);
            reject(new Error(`Failed to start Python process: ${err.message}`));
        });

        let output = '';
        let errorOutput = '';

        pythonProcess.stdout.on('data', (data) => {
            const str = data.toString();
            output += str;
            console.log(`Python stdout: ${str}`);
        });

        pythonProcess.stderr.on('data', (data) => {
            const txt = data.toString();
            errorOutput += txt;
            console.log(`[PY STDERR] ${txt.trim()}`);
        });

        pythonProcess.on('close', async (code) => {
            console.log(`Python process for ${websiteId} exited with code ${code}`);

            if (code !== 0) {
                console.error(`Python stderr for ${websiteId}: ${errorOutput}`);
                return reject(new Error(`Python process exited with code ${code}. Error: ${errorOutput}`));
            }

            try {
                // More robust JSON detection: Find the last line that looks like a JSON object
                const lines = output.trim().split('\n');
                let result = null;

                for (let i = lines.length - 1; i >= 0; i--) {
                    const line = lines[i].trim();
                    if (line.startsWith('{') && line.endsWith('}')) {
                        try {
                            result = JSON.parse(line);
                            if (result.data || result.error || result.success) break;
                        } catch (e) { continue; }
                    }
                }

                if (!result) {
                    console.error(`Full Python Output for ${websiteId}:\n${output}`);
                    throw new Error('No valid JSON output found from Python script');
                }

                if (result.error) {
                    return reject(new Error(result.error));
                }

                const data = result.data || result; // Handle {success: true, data: ...} or just data

                // Extract items
                let items = [];
                if (data.type === 'list' && Array.isArray(data.data)) {
                    items = data.data;
                } else if (Array.isArray(data)) {
                    items = data;
                } else {
                    items = [data];
                }

                // Add count to the data for website summary
                if (data.type === 'list') {
                    data.count = items.length;
                }

                console.log(`[SCRAPER] ${websiteId}: Found ${items.length} items to save.`);

                // 2. Update Website Document using Prisma (Success) - scoped by userId
                const now = new Date();
                const currentWebsite = await prisma.website.findUnique({
                    where: { id: websiteId },
                    select: { scrapedData: true }
                });

                let updatedScrapedData = currentWebsite?.scrapedData || {};
                
                // If it is already a flat legacy scrape result, reset to map
                if (updatedScrapedData.type) {
                    updatedScrapedData = {};
                }

                if (userId) {
                    updatedScrapedData[userId] = {
                        data: data,
                        lastScraped: now
                    };
                }

                await prisma.website.update({
                    where: { id: websiteId },
                    data: {
                        scrapedData: updatedScrapedData,
                        lastScraped: now
                    }
                });

                // 3. Create/Update Product using Prisma
                let savedCount = 0;
                const { generateCategoryForProduct } = require('./aiService');
                const standardCategories = [
                    'Phones & Tablets', 'Computers & Laptops', 'TV & Audio', 
                    'Home Appliances', 'Gaming', 'Networking', 
                    'Accessories', 'Office Supplies', 'Other'
                ];
                const sleep = (ms) => new Promise(r => setTimeout(r, ms));
                const savedProductIds = []; // Track saved IDs for post-pass

                for (const item of items) {
                    try {
                        let itemUrl = item.url || url;
                        if (!itemUrl || typeof itemUrl !== 'string') continue;

                        // Manual upsert logic
                        const existingProduct = await prisma.product.findFirst({
                            where: {
                                url: itemUrl,
                                userId: userId || undefined
                            }
                        });

                        // Auto-Categorize with AI — add delay to avoid Groq rate limits
                        let finalCategory = item.category || '';
                        if (!standardCategories.includes(finalCategory)) {
                            try {
                                await sleep(150); // prevent rate-limit on batch scrapes
                                const aiCat = await generateCategoryForProduct(
                                    item.name || 'Unknown',
                                    `${item.overview || ''} ${item.category || ''}`
                                );
                                if (aiCat && aiCat !== "Unknown") {
                                    finalCategory = aiCat;
                                    console.log(`[SCRAPER] AI categorized "${item.name?.substring(0, 40)}" => ${finalCategory}`);
                                }
                            } catch (e) {
                                console.error('[SCRAPER] AI categorization failed (will retry in post-pass):', e.message);
                            }
                        }

                        const productData = {
                            name: item.name || 'Unknown',
                            price: item.price || 'Not found',
                            priceAmount: parseFloat(item.priceAmount || 0.0),
                            oldPrice: item.oldPrice || '',
                            reference: item.reference || '',
                            overview: item.overview || '',
                            category: finalCategory,
                            image: item.image || '',
                            websiteId: websiteId,
                            scrapedAt: now,
                            userId: userId,
                            domain: item.domain || data.domain
                        };

                        let savedId = null;
                        if (existingProduct) {
                            await prisma.product.update({
                                where: { id: existingProduct.id },
                                data: productData
                            });
                            savedId = existingProduct.id;
                        } else {
                            const created = await prisma.product.create({
                                data: { ...productData, url: itemUrl }
                            });
                            savedId = created.id;
                        }
                        if (savedId) savedProductIds.push({ id: savedId, name: item.name, overview: item.overview, category: finalCategory });
                        savedCount++;
                    } catch (err) {
                        console.error(`[SCRAPER] Failed to save item "${item.name}":`, err.message);
                    }
                }

                // Post-scrape pass: fix any products that still have empty categories
                const uncategorized = savedProductIds.filter(p => !standardCategories.includes(p.category));
                if (uncategorized.length > 0) {
                    console.log(`[SCRAPER] Post-pass: re-categorizing ${uncategorized.length} products...`);
                    for (const p of uncategorized) {
                        try {
                            await sleep(200);
                            const aiCat = await generateCategoryForProduct(p.name || 'Unknown', p.overview || '');
                            if (aiCat && aiCat !== 'Unknown') {
                                await prisma.product.update({ where: { id: p.id }, data: { category: aiCat } });
                                console.log(`[SCRAPER] Post-pass: "${p.name?.substring(0, 40)}" => ${aiCat}`);
                            }
                        } catch (e) {
                            console.error('[SCRAPER] Post-pass categorization failed:', e.message);
                        }
                    }
                }

                console.log(`[SCRAPER] ${websiteId}: Successfully saved ${savedCount} products to database.`);


                // --- Notification & Email System ---
                if (userId) {
                    try {
                        const { sendScrapingNotification } = require('./emailService');
                        const user = await prisma.user.findUnique({
                            where: { id: userId },
                            select: { email: true }
                        });

                        // 1. Create In-App Notification
                        await prisma.notification.create({
                            data: {
                                userId: userId,
                                title: "Scraping Completed",
                                message: `Successfully scraped ${items.length} items from ${url}`,
                                type: "success"
                            }
                        });
                        console.log(`[Notification] Created in-app notification for user ${userId}`);

                        // 2. Send Email
                        if (user && user.email) {
                            console.log(`Sending email notification to ${user.email}...`);
                            await sendScrapingNotification(user.email, url, items);
                        }
                    } catch (notifyErr) {
                        console.error("Failed to process notifications:", notifyErr);
                    }
                }
                // --- End Notification System ---

                resolve(data);
            } catch (err) {
                console.error(`[SCRAPER] Error processing output for ${websiteId}:`, err);
                reject(new Error(`Failed to process scraper results: ${err.message}`));
            }
        });
    });
}

module.exports = {
    scrapeWebsiteTask
};

