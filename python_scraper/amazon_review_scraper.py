"""
amazon_review_scraper.py
------------------------
Fetches Amazon product reviews using RapidAPI,
providing sentiment analysis.

Requirements:
- RAPIDAPI_KEY in the environment (.env file in backend)
"""


import os
import sys
import io
import json
import re
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

RAPIDAPI_HOST = "real-time-amazon-data.p.rapidapi.com"
RAPIDAPI_BASE_URL = f"https://{RAPIDAPI_HOST}"

def search_amazon_for_asin(reference: str, api_key: str) -> str | None:
    """Search Amazon via RapidAPI and return the first ASIN."""
    log.info(f"Searching RapidAPI for: {reference}")
    url = f"{RAPIDAPI_BASE_URL}/search"
    querystring = {"query": reference, "page": "1", "country": "US", "sort_by": "RELEVANCE"}
    headers = {
        "x-rapidapi-key": api_key,
        "x-rapidapi-host": RAPIDAPI_HOST
    }
    
    try:
        resp = requests.get(url, headers=headers, params=querystring, timeout=20)
        data = resp.json()
        
        if data.get('status') == 'OK' and 'data' in data and 'products' in data['data']:
            products = data['data']['products']
            if products:
                asin = products[0].get('asin')
                log.info(f"Found ASIN: {asin}")
                return asin
        
        log.error(f"RapidAPI Search Error: {data.get('message', 'Unknown Error')}")
        return None
    except Exception as e:
        log.error(f"Search API request failed: {e}")
        return None

def fetch_amazon_reviews(asin: str, api_key: str, max_reviews: int) -> list[dict]:
    """Fetch reviews for a given ASIN using RapidAPI."""
    log.info(f"Fetching reviews for ASIN {asin} via RapidAPI (max: {max_reviews})")
    
    url = f"{RAPIDAPI_BASE_URL}/product-reviews"
    querystring = {"asin": asin, "country": "US", "sort_by": "TOP_REVIEWS", "page": "1"}
    headers = {
        "x-rapidapi-key": api_key,
        "x-rapidapi-host": RAPIDAPI_HOST
    }
    
    reviews = []
    
    try:
        resp = requests.get(url, headers=headers, params=querystring, timeout=30)
        data = resp.json()
        
        if data.get('status') != 'OK':
            log.error(f"API Error: {data.get('message', 'Unknown error')}")
            return f"ERROR: {data.get('message', 'Unknown error')}", None

        review_data = data.get('data', {}).get('reviews', [])
        
        for r in review_data:
            # Safely extract rating which might be 'review_star_rating' like '4.5 out of 5 stars'
            raw_rating = r.get('review_star_rating') or r.get('review_rating') or r.get('rating') or 0.0
            parsed_rating = 0.0
            if isinstance(raw_rating, str):
                match = re.search(r'(\d+(\.\d+)?)', raw_rating)
                if match: parsed_rating = float(match.group(1))
            else:
                try: parsed_rating = float(raw_rating)
                except: pass

            reviews.append({
                "title":    r.get('review_title', ''),
                "body":     r.get('review_comment', ''),
                "rating":   parsed_rating,
                "date":     r.get('review_date', ''),
                "author":   r.get('review_author', 'Anonymous'),
                "verified": "Verified Purchase" in r.get('review_verified_purchase', ''),
                "asin":     asin,
            })
            if len(reviews) >= max_reviews:
                break
                
    except Exception as e:
        log.error(f"Review API request failed: {e}")
        
    return reviews[:max_reviews]


def fetch_amazon_stock(asin: str, api_key: str) -> dict | None:
    """Fetch product details (stock/price/rating) using RapidAPI product-details."""
    url = f"{RAPIDAPI_BASE_URL}/product-details"
    querystring = {"asin": asin, "country": "US"}
    headers = {
        "x-rapidapi-key": api_key,
        "x-rapidapi-host": RAPIDAPI_HOST
    }
    try:
        resp = requests.get(url, headers=headers, params=querystring, timeout=30)
        data = resp.json()
        if data.get('status') == 'OK':
            prod = data.get('data', {})
            return {
                "stock_level": prod.get('product_availability', 'In Stock'),
                "price": prod.get('product_price'),
                "rating": prod.get('product_star_rating'),
            }
    except Exception as e:
        log.error(f"Stock API request failed: {e}")
    return None


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

    api_key = os.environ.get("RAPIDAPI_KEY")
    if not api_key:
        print(json.dumps({
            "success": False,
            "productId": args.product_id,
            "error": "Missing RAPIDAPI_KEY in backend environment.",
        }))
        sys.exit(0)

    try:
        # ── 1. Resolve ASIN ───────────────────────────────────────────────
        search_query = args.reference
        if not args.asin:
            # Clean search query logic remains same
            words = args.reference.split(' ')
            if len(words) > 4:
                search_query = ' '.join(words[:4])
            noise = ["Avec", "Sacoche", "Offerte", "/", "-", "|", "Go", "SSD", "Windows"]
            for n in noise:
                search_query = search_query.replace(n, " ").strip()
            while "  " in search_query:
                search_query = search_query.replace("  ", " ")
            
            log.info(f"Cleaned search query: {search_query}")

        asin = args.asin or search_amazon_for_asin(search_query, api_key)

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
        reviews = fetch_amazon_reviews(asin, api_key, args.max_reviews)

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
                "error": "No reviews found for this ASIN on Amazon.",
            }))
            sys.exit(0)

        # ── 3. VADER sentiment ────────────────────────────────────────────
        enriched = analyze_sentiment(reviews)

        # ── 4. RapidAPI Stock/Details ─────────────────────────────────────
        stock_data = fetch_amazon_stock(asin, api_key)

        # ── 5. Build summary ──────────────────────────────────────────────
        summary = build_summary(enriched)

        print(json.dumps({
            "success":       True,
            "productId":     args.product_id,
            "asin":          asin,
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
