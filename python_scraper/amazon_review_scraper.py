"""
amazon_review_scraper.py
------------------------
Fetches Amazon product reviews using Rainforest API (a dedicated Amazon data API),
ensuring 100% reliability by bypassing Amazon bot detection completely.

Requirements:
- RAINFOREST_API_KEY in the environment (.env file in backend)
"""

import os
import sys
import io
import json
import time
import argparse
import logging
import requests
from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer

# Force UTF-8 stdout
if hasattr(sys.stdout, "buffer"):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

logging.basicConfig(
    level=logging.INFO,
    format="[AMAZON_API] %(levelname)s: %(message)s",
    stream=sys.stderr,
)
log = logging.getLogger(__name__)

RAINFOREST_API_URL = "https://api.rainforestapi.com/request"

def search_rainforest_for_asin(reference: str, api_key: str) -> str | None:
    """Search Amazon via API and return the first ASIN."""
    log.info(f"Searching Rainforest API for: {reference}")
    params = {
        'api_key': api_key,
        'type': 'search',
        'amazon_domain': 'amazon.com',
        'search_term': reference
    }
    
    try:
        resp = requests.get(RAINFOREST_API_URL, params=params, timeout=20)
        data = resp.json()
        
        if 'search_results' in data and len(data['search_results']) > 0:
            asin = data['search_results'][0].get('asin')
            log.info(f"Found ASIN: {asin}")
            return asin
        
        if data.get('request_info', {}).get('success') == False:
            message = data['request_info'].get('message', 'Unknown API Error')
            log.error(f"Rainforest API Error: {message}")
            return f"ERROR: {message}"

        return None
    except Exception as e:
        log.error(f"Search API request failed: {e}")
        return None

def fetch_rainforest_reviews(asin: str, api_key: str, max_reviews: int) -> list[dict]:
    """Fetch reviews for a given ASIN using the Rainforest API product endpoint."""
    log.info(f"Fetching reviews for ASIN {asin} via API (max: {max_reviews})")
    
    reviews = []
    
    params = {
        'api_key': api_key,
        'type': 'product',
        'amazon_domain': 'amazon.com',
        'asin': asin
    }
    
    try:
        resp = requests.get(RAINFOREST_API_URL, params=params, timeout=30)
        data = resp.json()
        
        # Check if the API threw an internal error message
        if data.get('request_info', {}).get('success') == False:
            message = data['request_info'].get('message', 'Unknown API Error')
            log.error(f"API Error: {message}")
            return f"ERROR: {message}", None

        top_reviews = data.get('product', {}).get('top_reviews', [])
        
        # Grab Best Sellers Rank
        bestsellers_rank = data.get('product', {}).get('bestsellers_rank')
        bsr = None
        if bestsellers_rank and isinstance(bestsellers_rank, list) and len(bestsellers_rank) > 0:
            bsr = bestsellers_rank[0].get('rank')

        if not top_reviews:
            log.info("No more reviews found from API.")
            return [], bsr
            
        for r in top_reviews:
            reviews.append({
                "title":    r.get('title', ''),
                "body":     r.get('body', ''),
                "rating":   float(r.get('rating', 0.0)),
                "date":     r.get('date', {}).get('raw', ''),
                "author":   r.get('profile', {}).get('name', 'Anonymous'),
                "verified": r.get('verified_purchase', False),
                "asin":     asin,
            })
            if len(reviews) >= max_reviews:
                break
                
    except Exception as e:
        log.error(f"Review API request failed: {e}")
        
    return reviews[:max_reviews], bsr

def fetch_rainforest_stock(asin: str, api_key: str) -> dict | None:
    """Fetch current stock levels using Rainforest type=stock_estimation."""
    log.info(f"Requesting Rainforest Stock Estimation for: {asin}")
    params = {
        'api_key': api_key,
        'type': 'stock_estimation',
        'amazon_domain': 'amazon.com',
        'asin': asin
    }
    try:
        resp = requests.get(RAINFOREST_API_URL, params=params, timeout=30)
        data = resp.json()
        if data.get('request_info', {}).get('success'):
            return data.get('stock_estimation')
    except Exception as e:
        log.error(f"Stock API request failed: {e}")
    return None

def estimate_sales_from_bsr(rank: int) -> int:
    """Estimates monthly unit sales based on BSR using a standard power-law formula."""
    if not rank or rank <= 0: return 0
    # Formula derived from common Electronics/Home category trends
    # Sales ≈ a * (Rank ^ b)
    a = 280000 
    b = -0.78
    estimated = a * (rank ** b)
    return int(max(5, min(estimated, 50000))) # Realistic bounds

def analyze_sentiment(reviews: list[dict]) -> list[dict]:
    """Run VADER on each review. Adds: sentiment, compound, sentimentScores."""
    analyzer = SentimentIntensityAnalyzer()
    for review in reviews:
        text = f"{review.get('title', '')} {review.get('body', '')}".strip()
        scores = analyzer.polarity_scores(text)
        compound = scores["compound"]

        if compound >= 0.05:
            label = "positive"
        elif compound <= -0.05:
            label = "negative"
        else:
            label = "neutral"

        review["sentiment"] = label
        review["sentimentScores"] = scores
        review["compound"] = compound

    return reviews

def build_summary(reviews: list[dict]) -> dict:
    if not reviews:
        return {
            "total": 0, "positive": 0, "neutral": 0, "negative": 0,
            "averageRating": 0.0, "averageCompound": 0.0, "overallSentiment": "neutral",
        }

    positive = sum(1 for r in reviews if r.get("sentiment") == "positive")
    neutral  = sum(1 for r in reviews if r.get("sentiment") == "neutral")
    negative = sum(1 for r in reviews if r.get("sentiment") == "negative")
    avg_rating   = sum(r.get("rating", 0.0) for r in reviews) / len(reviews)
    avg_compound = sum(r.get("compound", 0.0) for r in reviews) / len(reviews)

    if avg_compound >= 0.05:
        overall = "positive"
    elif avg_compound <= -0.05:
        overall = "negative"
    else:
        overall = "neutral"

    return {
        "total": len(reviews),
        "positive": positive,
        "neutral":  neutral,
        "negative": negative,
        "averageRating":   round(avg_rating,   2),
        "averageCompound": round(avg_compound, 4),
        "overallSentiment": overall,
    }

def main():
    parser = argparse.ArgumentParser(description="Amazon Review API fetcher with VADER Sentiment")
    parser.add_argument("reference",     help="Product reference / search query")
    parser.add_argument("product_id",    help="Internal product ID from our database")
    parser.add_argument("--max-reviews", type=int, default=20,
                        help="Max reviews to scrape (default: 20)")
    parser.add_argument("--asin",        default=None,
                        help="Skip search and use this ASIN directly")
    args, unknown = parser.parse_known_args()

    api_key = os.environ.get("RAINFOREST_API_KEY")
    if not api_key:
        print(json.dumps({
            "success": False,
            "productId": args.product_id,
            "error": "Missing RAINFOREST_API_KEY in backend environment. Please set it to use the rainforest API.",
        }))
        sys.exit(0)

    try:
        # ── 1. Resolve ASIN ───────────────────────────────────────────────
        # Clean the reference/search query to be more Amazon-friendly
        # Remove common Tunisian suffixes or long descriptions
        search_query = args.reference
        if not args.asin:
            # Take only the first 4 words for a much broader search
            words = args.reference.split(' ')
            if len(words) > 4:
                search_query = ' '.join(words[:4])
            
            # Remove noise like "Avec Sacoche Offerte" and model-specific noise
            noise = ["Avec", "Sacoche", "Offerte", "/", "-", "|", "Go", "SSD", "Windows"]
            for n in noise:
                search_query = search_query.replace(n, " ").strip()
            
            # Remove double spaces
            while "  " in search_query:
                search_query = search_query.replace("  ", " ")
            
            log.info(f"Cleaned search query (Aggressive): {search_query}")

        asin = args.asin or search_rainforest_for_asin(search_query, api_key)

        if not asin:
            print(json.dumps({
                "success": False,
                "productId": args.product_id,
                "error": f"Could not find Amazon product matching: {search_query}",
            }))
            sys.exit(0)
        
        if isinstance(asin, str) and asin.startswith("ERROR:"):
            print(json.dumps({
                "success": False,
                "productId": args.product_id,
                "error": asin.replace("ERROR: ", ""),
            }))
            sys.exit(0)

        # ── 2. Fetch reviews ─────────────────────────────────────────────
        result = fetch_rainforest_reviews(asin, api_key, args.max_reviews)
        if isinstance(result, tuple) and len(result) == 2:
            reviews, bsr = result
        else:
            reviews, bsr = result, None

        if isinstance(reviews, str) and reviews.startswith("ERROR:"):
            print(json.dumps({
                "success": False,
                "productId": args.product_id,
                "error": reviews.replace("ERROR: ", ""),
            }))
            sys.exit(0)

        if not reviews:
            print(json.dumps({
                "success": False,
                "productId": args.product_id,
                "asin": asin,
                "bsr": bsr,
                "error": "No reviews found for this ASIN on Amazon.",
            }))
            sys.exit(0)

        # ── 3. VADER sentiment ────────────────────────────────────────────
        enriched = analyze_sentiment(reviews)

        # ── 4. Rainforest Stock Estimation ────────────────────────────────
        stock_data = fetch_rainforest_stock(asin, api_key)
        
        # ── 5. Market Sales Calculation (BSR based) ───────────────────────
        monthly_sales = estimate_sales_from_bsr(bsr)

        # ── 6. Build summary ──────────────────────────────────────────────
        summary = build_summary(enriched)

        print(json.dumps({
            "success":       True,
            "productId":     args.product_id,
            "asin":          asin,
            "bsr":           bsr,
            "monthlySales":  monthly_sales,
            "stockInfo":     stock_data,
            "reviews":       enriched,
            "summary":       summary,
        }, ensure_ascii=False))

    except Exception as exc:
        log.exception("Unexpected error in API fetcher")
        print(json.dumps({
            "success":   False,
            "productId": getattr(args, "product_id", None),
            "error":     str(exc),
        }))
        sys.exit(1)

if __name__ == "__main__":
    main()
