/**
 * save_scraped_reviews.js
 * -----------------------
 * Reads the scraped review JSON from python_scraper/review_result.txt,
 * finds or creates a matching Product in the database,
 * then upserts all reviews into the Review table.
 *
 * Usage:
 *   node backend/scripts/save_scraped_reviews.js
 *
 * Pass a product ID override via env to link to an existing product:
 *   PRODUCT_ID=<uuid> node backend/scripts/save_scraped_reviews.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const prisma = require('../lib/prisma');

// ── Config ────────────────────────────────────────────────────────────────────
// Try the clean UTF-8 copy first, fall back to the original
const RESULT_FILE =
    fs.existsSync(path.join(__dirname, '../python_scraper/review_result_utf8.json'))
        ? path.join(__dirname, '../python_scraper/review_result_utf8.json')
        : path.join(__dirname, '../python_scraper/review_result.txt');

const OVERRIDE_PRODUCT_ID = process.env.PRODUCT_ID || null;

// ── Helpers ───────────────────────────────────────────────────────────────────
function makeReviewId(productId, body) {
    const key = `${productId}::${(body || '').slice(0, 200)}`;
    const hash = crypto.createHash('sha1').update(key).digest('hex');
    return [
        hash.slice(0, 8),
        hash.slice(8, 12),
        hash.slice(12, 16),
        hash.slice(16, 20),
        hash.slice(20, 32),
    ].join('-');
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
    console.log('=== BrandSight: Save Amazon Reviews to DB ===\n');

    // 1. Read the result file
    if (!fs.existsSync(RESULT_FILE)) {
        console.error(`ERROR: Result file not found at ${RESULT_FILE}`);
        console.error('Run the Python scraper first.');
        process.exit(1);
    }

    // Read with BOM stripping — handles UTF-8 BOM that PowerShell sometimes writes
    let raw = fs.readFileSync(RESULT_FILE, 'utf-8');
    // Strip UTF-8 BOM (\uFEFF) and UTF-16 BOM artifacts
    raw = raw.replace(/^\uFEFF/, '').replace(/^\xFF\xFE/, '');

    // Find the last JSON line (ignore log lines)
    const lines = raw.trim().split('\n');
    let parsed = null;
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (line.startsWith('{') && line.endsWith('}')) {
            try { parsed = JSON.parse(line); break; }
            catch (e) { /* keep looking */ }
        }
    }

    if (!parsed || !parsed.success) {
        console.error('ERROR: No valid success JSON found in result file.');
        console.error('Parsed:', parsed);
        process.exit(1);
    }

    const { asin, reviews, summary } = parsed;
    console.log(`ASIN:     ${asin}`);
    console.log(`Reviews:  ${reviews.length}`);
    console.log(`Summary:  ${JSON.stringify(summary)}\n`);

    // 2. Resolve productId — override, or find by ASIN, or create
    let productId = OVERRIDE_PRODUCT_ID;

    if (!productId) {
        // Try to find an existing product whose reference or name matches this ASIN
        let existing = await prisma.product.findFirst({
            where: {
                OR: [
                    { reference: asin },
                    { reference: { contains: 'MAXBOOK-X15PRO', mode: 'insensitive' } },
                    { name: { contains: 'MacBook Pro', mode: 'insensitive' } },
                ]
            },
            select: { id: true, name: true }
        });

        if (existing) {
            productId = existing.id;
            console.log(`Found existing product: "${existing.name}" (${productId})`);
        } else {
            // Create a placeholder website + product so the reviews have a valid foreign key
            console.log('No matching product found — creating placeholder records…');

            // Find or create a system website
            let website = await prisma.website.findFirst({
                where: { url: 'https://www.amazon.com' },
                select: { id: true }
            });

            if (!website) {
                website = await prisma.website.create({
                    data: {
                        name: 'Amazon',
                        url: 'https://www.amazon.com',
                        description: 'Amazon marketplace',
                        category: 'ecommerce',
                    }
                });
                console.log(`Created website: Amazon (${website.id})`);
            }

            const product = await prisma.product.create({
                data: {
                    name: 'Apple MacBook Pro M4 Pro 2024',
                    reference: 'MAXBOOK-X15PRO',
                    url: `https://www.amazon.com/dp/${asin}`,
                    domain: 'amazon.com',
                    category: 'laptops',
                    websiteId: website.id,
                    scrapedAt: new Date(),
                }
            });

            productId = product.id;
            console.log(`Created product: "${product.name}" (${productId})`);
        }
    } else {
        console.log(`Using provided PRODUCT_ID: ${productId}`);
    }

    // 3. Upsert each review
    console.log('\nSaving reviews…');
    let saved = 0;
    let updated = 0;
    let failed = 0;

    for (const review of reviews) {
        const reviewId = makeReviewId(productId, review.body);

        try {
            const result = await prisma.review.upsert({
                where: { id: reviewId },
                update: {
                    title: review.title || null,
                    body: review.body,
                    author: review.author || null,
                    rating: review.rating || null,
                    reviewDate: review.date || null,
                    verified: review.verified ?? false,
                    sentiment: review.sentiment,
                    compound: review.compound,
                    sentimentPos: review.sentimentScores?.pos ?? null,
                    sentimentNeu: review.sentimentScores?.neu ?? null,
                    sentimentNeg: review.sentimentScores?.neg ?? null,
                    asin: asin || null,
                },
                create: {
                    id: reviewId,
                    productId,
                    asin: asin || null,
                    title: review.title || null,
                    body: review.body,
                    author: review.author || null,
                    rating: review.rating || null,
                    reviewDate: review.date || null,
                    verified: review.verified ?? false,
                    sentiment: review.sentiment,
                    compound: review.compound,
                    sentimentPos: review.sentimentScores?.pos ?? null,
                    sentimentNeu: review.sentimentScores?.neu ?? null,
                    sentimentNeg: review.sentimentScores?.neg ?? null,
                },
            });

            // Prisma upsert doesn't tell us if it was a create or update —
            // we infer by checking if createdAt ~= updatedAt
            const isNew = Math.abs(
                result.createdAt.getTime() - (result.updatedAt?.getTime() ?? result.createdAt.getTime())
            ) < 1000;

            if (isNew) {
                saved++;
                console.log(`  ✅ SAVED   [${review.sentiment.padEnd(8)}] ${(review.author || 'anon').slice(0, 20).padEnd(20)} → "${(review.title || review.body).slice(0, 50)}"`);
            } else {
                updated++;
                console.log(`  🔄 UPDATED [${review.sentiment.padEnd(8)}] ${(review.author || 'anon').slice(0, 20).padEnd(20)} → "${(review.title || review.body).slice(0, 50)}"`);
            }
        } catch (err) {
            failed++;
            console.error(`  ❌ FAILED  ${(review.author || 'anon')}: ${err.message}`);
        }
    }

    console.log('\n=== Done ===');
    console.log(`  Saved:   ${saved}`);
    console.log(`  Updated: ${updated}`);
    console.log(`  Failed:  ${failed}`);
    console.log(`  Total:   ${reviews.length}`);
    console.log(`\nProduct ID: ${productId}`);
    console.log(`ASIN:       ${asin}`);
    console.log(`Sentiment:  ${summary.overallSentiment.toUpperCase()} (avg compound: ${summary.averageCompound})`);
    console.log(`  Positive: ${summary.positive} | Neutral: ${summary.neutral} | Negative: ${summary.negative}`);
}

main()
    .catch((err) => {
        console.error('\nFATAL ERROR:', err);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
