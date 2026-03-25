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
        if data.get('request_info', {}).get('success') is False:
            log.error(f"API Error: {data['request_info'].get('message')}")
            return []

        top_reviews = data.get('product', {}).get('top_reviews', [])
        if not top_reviews:
            log.info("No more reviews found from API.")
            return []
            
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
        
    return reviews[:max_reviews]

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
        asin = args.asin or search_rainforest_for_asin(args.reference, api_key)

        if not asin:
            print(json.dumps({
                "success": False,
                "productId": args.product_id,
                "error": f"Could not find Amazon product for reference via API: {args.reference}",
            }))
            sys.exit(0)

        # ── 2. Fetch reviews ─────────────────────────────────────────────
        reviews = fetch_rainforest_reviews(asin, api_key, args.max_reviews)

        if not reviews:
            print(json.dumps({
                "success": False,
                "productId": args.product_id,
                "asin": asin,
                "error": "No reviews found for this ASIN on Amazon.",
            }))
            sys.exit(0)

        # ── 3. VADER sentiment ────────────────────────────────────────────
        enriched = analyze_sentiment(reviews)

        # ── 4. Build summary ──────────────────────────────────────────────
        summary = build_summary(enriched)

        print(json.dumps({
            "success":   True,
            "productId": args.product_id,
            "asin":      asin,
            "reviews":   enriched,
            "summary":   summary,
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
