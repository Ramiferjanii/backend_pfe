/**
 * reviewService.js
 * ----------------
 * Orchestrates the Amazon review scraping + VADER sentiment pipeline.
 *
 * Flow:
 *  1.  Look up the product by ID in the database (get its reference field).
 *  2.  Spawn the Python script amazon_review_scraper.py.
 *  3.  Parse the JSON output from Python.
 *  4.  Upsert each review into the `Review` table, linked to the product.
 *  5.  Return a summary object to the caller.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const prisma = require('../lib/prisma');

// ─── Resolve Python executable ──────────────────────────────────────────────
function resolvePythonPath() {
    const venvWin = path.join(__dirname, '../../.venv/Scripts/python.exe');
    const venvUnix = path.join(__dirname, '../../.venv/bin/python');
    if (fs.existsSync(venvWin)) return venvWin;
    if (fs.existsSync(venvUnix)) return venvUnix;
    return 'python';   // system fallback
}

const SCRAPER_SCRIPT = path.join(
    __dirname,
    '../python_scraper/amazon_review_scraper.py'
);

// ─── Main Function ───────────────────────────────────────────────────────────

/**
 * Fetch Amazon reviews for a product, run VADER analysis, and persist to DB.
 *
 * @param {string} productId   - UUID of the product in our database
 * @param {object} options
 * @param {number} [options.maxReviews=20]  - Maximum reviews to scrape
 * @param {string} [options.asin]           - Skip search if you already know the ASIN
 * @returns {Promise<{productId, asin, summary, savedCount, reviews}>}
 */
async function fetchAndSaveReviews(productId, options = {}) {
    const { maxReviews = 20, asin = null } = options;

    // ── 1. Load product from DB ────────────────────────────────────────────
    const product = await prisma.product.findUnique({
        where: { id: productId },
        select: { id: true, name: true, reference: true, domain: true },
    });

    if (!product) {
        throw new Error(`Product not found: ${productId}`);
    }

    // Use product name as the primary search query, since local references/SKUs often fail on Amazon.
    // If name is strangely empty, fall back to reference.
    const searchQuery = (product.name && product.name.trim())
        ? product.name.trim()
        : (product.reference ? product.reference.trim() : '');

    console.log(
        `[ReviewService] Starting review pipeline for product "${product.name}" (ID: ${productId}), query: "${searchQuery}"`
    );

    // ── 2. Run Python scraper ──────────────────────────────────────────────
    const pythonResult = await runPythonScraper({
        reference: searchQuery,
        productId,
        maxReviews,
        asin,
    });

    if (!pythonResult.success) {
        throw new Error(pythonResult.error || 'Python scraper returned an error');
    }

    const { reviews: rawReviews, asin: resolvedAsin, summary } = pythonResult;

    console.log(
        `[ReviewService] Python returned ${rawReviews.length} reviews for ASIN ${resolvedAsin}`
    );

    // ── 3. Persist reviews to database ─────────────────────────────────────
    let savedCount = 0;

    for (const review of rawReviews) {
        try {
            await prisma.review.upsert({
                where: {
                    // Unique constraint: same product + same review body (hash-like)
                    // We use productId + first 200 chars of body as a composite key,
                    // handled by a helper below.
                    id: await resolveReviewId(productId, review),
                },
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
                    asin: resolvedAsin || null,
                },
                create: {
                    id: await resolveReviewId(productId, review),
                    productId,
                    asin: resolvedAsin || null,
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
            savedCount++;
        } catch (err) {
            console.error(`[ReviewService] Failed to save review: ${err.message}`);
        }
    }

    console.log(
        `[ReviewService] Saved ${savedCount}/${rawReviews.length} reviews for product ${productId}`
    );

    return {
        productId,
        asin: resolvedAsin,
        summary,
        savedCount,
        reviews: rawReviews,
    };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Generate a deterministic review ID based on productId + body snippet.
 * This prevents duplicate rows on re-runs.
 */
async function resolveReviewId(productId, review) {
    const crypto = require('crypto');
    const key = `${productId}::${(review.body || '').slice(0, 200)}`;
    const hash = crypto.createHash('sha1').update(key).digest('hex');
    // Format as UUID-like: keep it 36 chars
    return [
        hash.slice(0, 8),
        hash.slice(8, 12),
        hash.slice(12, 16),
        hash.slice(16, 20),
        hash.slice(20, 32),
    ].join('-');
}


/**
 * Spawn the Python scraper and return its parsed JSON output.
 */
function runPythonScraper({ reference, productId, maxReviews, asin }) {
    return new Promise((resolve, reject) => {
        const pythonPath = resolvePythonPath();
        const args = [
            SCRAPER_SCRIPT,
            reference,
            productId,
            '--max-reviews', String(maxReviews),
        ];
        if (asin) args.push('--asin', asin);

        console.log(`[ReviewService] Spawning: ${pythonPath} ${args.join(' ')}`);

        const proc = spawn(pythonPath, args);

        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (d) => { stdout += d.toString(); });
        proc.stderr.on('data', (d) => {
            const txt = d.toString();
            stderr += txt;
            // Mirror Python's log lines to Node console
            process.stderr.write(`[PY] ${txt}`);
        });

        proc.on('error', (err) => {
            reject(new Error(`Failed to start Python process: ${err.message}`));
        });

        proc.on('close', (code) => {
            console.log(`[ReviewService] Python exited with code ${code}`);

            // Extract last valid JSON line from stdout
            const lines = stdout.trim().split('\n');
            let result = null;

            for (let i = lines.length - 1; i >= 0; i--) {
                const line = lines[i].trim();
                if (line.startsWith('{') && line.endsWith('}')) {
                    try {
                        result = JSON.parse(line);
                        break;
                    } catch (e) { /* keep looking */ }
                }
            }

            if (!result) {
                return reject(
                    new Error(`No valid JSON output from Python. Stderr: ${stderr.slice(0, 500)}`)
                );
            }

            resolve(result);
        });
    });
}

// ─── Batch helper ─────────────────────────────────────────────────────────────

/**
 * Fetch reviews for ALL products of a given website (or all user products).
 *
 * @param {string[]} productIds - Array of product IDs to process
 * @param {object}   options    - Same options as fetchAndSaveReviews
 * @returns {Promise<object[]>} - Array of results per product
 */
async function fetchAndSaveReviewsBatch(productIds, options = {}) {
    const results = [];
    for (const productId of productIds) {
        try {
            console.log(`[ReviewService] [Batch] Processing product ${productId}…`);
            const result = await fetchAndSaveReviews(productId, options);
            results.push({ productId, status: 'success', ...result });
        } catch (err) {
            console.error(`[ReviewService] [Batch] Failed for ${productId}: ${err.message}`);
            results.push({ productId, status: 'error', error: err.message });
        }
    }
    return results;
}

module.exports = {
    fetchAndSaveReviews,
    fetchAndSaveReviewsBatch,
};
