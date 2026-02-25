const { spawn } = require('child_process');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

/**
 * Scrapes a website using the Python scraper script.
 * @param {string} websiteId - The ID of the website
 * @param {string} mode - 'static' or 'selenium'
 * @returns {Promise<Object>} - The updated data
 */
async function scrapeWebsiteTask(websiteId, mode = 'static', url, filters = {}, userId = null) {
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
        
        console.log(`Python args:`, args);
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
            errorOutput += data.toString();
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

                // 2. Update Website Document using Prisma (Success)
                const now = new Date();
                await prisma.website.update({
                    where: { id: websiteId },
                    data: {
                        scrapedData: data,
                        lastScraped: now
                    }
                });

                // 3. Create/Update Product using Prisma
                let savedCount = 0;
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


                        const productData = {
                            name: item.name || 'Unknown',
                            price: item.price || 'Not found',
                            priceAmount: parseFloat(item.priceAmount || 0.0), 
                            reference: item.reference || '',
                            overview: item.overview || '',
                            category: item.category || '',
                            image: item.image || '',
                            websiteId: websiteId,
                            scrapedAt: now,
                            userId: userId, 
                            domain: item.domain || data.domain
                        };

                        if (existingProduct) {
                            await prisma.product.update({
                                where: { id: existingProduct.id },
                                data: productData
                            });
                        } else {
                            await prisma.product.create({
                                data: {
                                    ...productData,
                                    url: itemUrl
                                }
                            });
                        }
                        savedCount++;
                    } catch (err) {
                        console.error(`[SCRAPER] Failed to save item "${item.name}":`, err.message);
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

