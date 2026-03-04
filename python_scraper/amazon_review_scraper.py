"""
amazon_review_scraper.py
------------------------
Scrapes Amazon product reviews using:
  - requests + BeautifulSoup for the /dp/ product page (fast, no bot issues)
  - Selenium (headless Chrome) for /product-reviews/ pagination (bypasses anti-bot)

Usage:
    python amazon_review_scraper.py "<product_reference>" "<product_id>" [--max-reviews N] [--asin ASIN]

Output (last stdout line):
    JSON: { success, productId, asin, reviews, summary }
"""

import sys
import io

# Force UTF-8 stdout — prevents Windows cp1252 crashes on special chars in review text
if hasattr(sys.stdout, "buffer"):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

import json
import re
import time
import random
import argparse
import logging

import requests
from bs4 import BeautifulSoup
from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer

# ─── Logging ────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="[AMAZON_SCRAPER] %(levelname)s: %(message)s",
    stream=sys.stderr,
)
log = logging.getLogger(__name__)

# ─── Constants ──────────────────────────────────────────────────────────────
BASE_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/122.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Referer": "https://www.amazon.com/",
    "Connection": "keep-alive",
}

AMAZON_SEARCH_URL = "https://www.amazon.com/s"

# ─── Shared session ──────────────────────────────────────────────────────────
_session = None

def get_session() -> requests.Session:
    global _session
    if _session is None:
        _session = requests.Session()
        _session.headers.update(BASE_HEADERS)
        # Warm-up: get homepage cookies
        try:
            _session.get("https://www.amazon.com", timeout=15)
            log.info("Session warmed up with Amazon homepage cookies")
            time.sleep(random.uniform(1.5, 2.5))
        except Exception as e:
            log.warning(f"Homepage warm-up failed: {e}")
    return _session


# ─── ASIN / Search ───────────────────────────────────────────────────────────

def extract_asin_from_url(url: str) -> str | None:
    m = re.search(r"/(?:dp|gp/product|product)/([A-Z0-9]{10})", url)
    return m.group(1) if m else None


def search_amazon_for_asin(reference: str) -> str | None:
    """Search Amazon and return the first ASIN found."""
    log.info(f"Searching Amazon for: {reference}")
    session = get_session()
    try:
        resp = session.get(
            AMAZON_SEARCH_URL,
            params={"k": reference, "ref": "nb_sb_noss"},
            timeout=15,
        )
        resp.encoding = "utf-8"
    except Exception as e:
        log.error(f"Search request failed: {e}")
        return None

    soup = BeautifulSoup(resp.text, "html.parser")

    # Priority 1: data-asin on result divs
    for div in soup.find_all("div", attrs={"data-asin": True}):
        asin = div.get("data-asin", "").strip()
        if asin and len(asin) == 10:
            log.info(f"Found ASIN: {asin}")
            return asin

    # Priority 2: extract from product links
    for link in soup.select("h2 a[href]"):
        asin = extract_asin_from_url(link.get("href", ""))
        if asin:
            log.info(f"Found ASIN from link: {asin}")
            return asin

    log.warning("No ASIN found in search results")
    return None


# ─── Strategy 1: requests on /dp/ product page ───────────────────────────────

def scrape_reviews_from_product_page(asin: str) -> list[dict]:
    """
    Scrape the top reviews embedded in the Amazon product page (/dp/).
    Works reliably without Selenium (Amazon serves real HTML here).
    Returns up to ~13 reviews (the ones Amazon embeds on the product page).
    """
    log.info(f"[Strategy 1 - requests] Fetching product page for ASIN {asin}")
    session = get_session()
    try:
        time.sleep(random.uniform(1.0, 2.0))
        resp = session.get(
            f"https://www.amazon.com/dp/{asin}",
            timeout=20,
        )
        resp.encoding = "utf-8"
    except Exception as e:
        log.error(f"Product page request failed: {e}")
        return []

    soup = BeautifulSoup(resp.text, "html.parser")

    title_el = soup.find("title")
    page_title = title_el.get_text() if title_el else ""
    log.info(f"Product page title: {page_title[:80]}")

    if "Sign-In" in page_title or "ap/signin" in resp.url:
        log.warning("Redirected to sign-in on product page")
        return []

    return _parse_review_divs(soup, asin)


def _parse_review_divs(soup: BeautifulSoup, asin: str) -> list[dict]:
    """Extract review data from BeautifulSoup parse tree."""
    reviews = []
    review_divs = soup.select("div[data-hook='review']")
    if not review_divs:
        review_divs = soup.select("div[id^='customer_review']")

    log.info(f"Found {len(review_divs)} review divs in HTML")

    for div in review_divs:
        # Title
        title_el = div.select_one("a[data-hook='review-title'] span:not([class]), [data-hook='review-title'] span")
        title = title_el.get_text(strip=True) if title_el else ""

        # Rating
        rating_el = div.select_one(
            "i[data-hook='review-star-rating'] span, "
            "i[data-hook='cmps-review-star-rating'] span, "
            "span[class*='a-star'] span.a-offscreen"
        )
        rating_str = rating_el.get_text(strip=True) if rating_el else "0"
        try:
            rating = float(re.search(r"[\d.]+", rating_str).group())
        except Exception:
            rating = 0.0

        # Body
        body_el = div.select_one(
            "span[data-hook='review-body'] span, "
            ".review-text-content span, "
            "[data-hook='review-body']"
        )
        body = body_el.get_text(strip=True) if body_el else ""

        # Date
        date_el = div.select_one("span[data-hook='review-date']")
        date_str = date_el.get_text(strip=True) if date_el else ""

        # Author
        author_el = div.select_one("span.a-profile-name")
        author = author_el.get_text(strip=True) if author_el else "Anonymous"

        # Verified purchase
        verified_el = div.select_one("span[data-hook='avp-badge']")
        verified = verified_el is not None

        if body:
            reviews.append({
                "title":    title,
                "body":     body,
                "rating":   rating,
                "date":     date_str,
                "author":   author,
                "verified": verified,
                "asin":     asin,
            })

    return reviews


# ─── Strategy 2: Selenium headless for /product-reviews/ pagination ──────────

def scrape_reviews_with_selenium(asin: str, max_reviews: int = 50) -> list[dict]:
    """
    Use Selenium headless Chrome to bypass Amazon's anti-bot on the
    /product-reviews/ endpoint and paginate through reviews.
    """
    log.info(f"[Strategy 2 - Selenium] Starting headless Chrome for ASIN {asin}")

    try:
        from selenium import webdriver
        from selenium.webdriver.chrome.options import Options
        from selenium.webdriver.chrome.service import Service
        from selenium.webdriver.common.by import By
        from selenium.webdriver.support.ui import WebDriverWait
        from selenium.webdriver.support import expected_conditions as EC
        from webdriver_manager.chrome import ChromeDriverManager
    except ImportError as e:
        log.error(f"Selenium/webdriver_manager not installed: {e}")
        return []

    options = Options()
    options.add_argument("--headless=new")
    options.add_argument("--no-sandbox")
    options.add_argument("--disable-dev-shm-usage")
    options.add_argument("--disable-blink-features=AutomationControlled")
    options.add_argument("--window-size=1920,1080")
    options.add_argument(
        "--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    )
    options.add_experimental_option("excludeSwitches", ["enable-automation"])
    options.add_experimental_option("useAutomationExtension", False)

    driver = None
    reviews = []

    try:
        service = Service(ChromeDriverManager().install())
        driver = webdriver.Chrome(service=service, options=options)

        # Mask webdriver fingerprint
        driver.execute_cdp_cmd(
            "Page.addScriptToEvaluateOnNewDocument",
            {"source": "Object.defineProperty(navigator, 'webdriver', {get: () => undefined})"},
        )

        # Step 1: Visit Amazon homepage first to get cookies
        log.info("Selenium: visiting Amazon homepage...")
        driver.get("https://www.amazon.com")
        time.sleep(random.uniform(2, 4))

        page = 1
        while len(reviews) < max_reviews:
            url = (
                f"https://www.amazon.com/product-reviews/{asin}"
                f"?pageNumber={page}&sortBy=recent&reviewerType=all_reviews"
            )
            log.info(f"Selenium: fetching reviews page {page} — {url}")
            driver.get(url)
            time.sleep(random.uniform(3, 5))

            # Wait for review divs or handle CAPTCHA/sign-in
            try:
                WebDriverWait(driver, 10).until(
                    EC.presence_of_element_located((By.CSS_SELECTOR, "div[data-hook='review']"))
                )
            except Exception:
                page_title = driver.title
                log.warning(f"No reviews loaded. Page title: {page_title}")
                # Check for CAPTCHA
                if "robot" in driver.page_source.lower() or "captcha" in driver.page_source.lower():
                    log.warning("CAPTCHA detected! Waiting 10s and retrying once...")
                    time.sleep(10)
                    driver.get(url)
                    time.sleep(5)
                else:
                    log.info("No (more) review divs on this page — stopping pagination")
                    break

            soup = BeautifulSoup(driver.page_source, "html.parser")
            page_reviews = _parse_review_divs(soup, asin)

            if not page_reviews:
                log.info(f"No reviews parsed on page {page} — stopping")
                break

            reviews.extend(page_reviews)
            log.info(f"Collected {len(reviews)} reviews so far (page {page})")

            # Check for "Next page" link
            next_btn = soup.select_one("li.a-last a, .a-pagination .a-last:not(.a-disabled) a")
            if not next_btn:
                log.info("No next page link — end of reviews")
                break

            page += 1

    except Exception as e:
        log.error(f"Selenium error: {e}")
    finally:
        if driver:
            try:
                driver.quit()
                log.info("Selenium: driver closed")
            except Exception:
                pass

    return reviews[:max_reviews]


# ─── Sentiment Analysis ───────────────────────────────────────────────────────

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

    positive = sum(1 for r in reviews if r["sentiment"] == "positive")
    neutral   = sum(1 for r in reviews if r["sentiment"] == "neutral")
    negative  = sum(1 for r in reviews if r["sentiment"] == "negative")
    avg_rating   = sum(r["rating"]   for r in reviews) / len(reviews)
    avg_compound = sum(r["compound"] for r in reviews) / len(reviews)

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


# ─── Entry Point ─────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Amazon Review Scraper with VADER Sentiment")
    parser.add_argument("reference",     help="Product reference / search query")
    parser.add_argument("product_id",    help="Internal product ID from our database")
    parser.add_argument("--max-reviews", type=int, default=20,
                        help="Max reviews to scrape (default: 20)")
    parser.add_argument("--asin",        default=None,
                        help="Skip search and use this ASIN directly")
    parser.add_argument("--mode",        choices=["auto", "requests", "selenium"],
                        default="auto",
                        help="Scraping mode: auto tries requests first, then Selenium")
    args = parser.parse_args()

    try:
        # ── 1. Resolve ASIN ───────────────────────────────────────────────
        asin = args.asin or search_amazon_for_asin(args.reference)

        if not asin:
            print(json.dumps({
                "success": False,
                "productId": args.product_id,
                "error": f"Could not find Amazon product for reference: {args.reference}",
            }))
            sys.exit(0)

        # ── 2. Scrape reviews ─────────────────────────────────────────────
        reviews = []

        if args.mode in ("auto", "requests"):
            # Strategy 1: fast requests on /dp/ product page
            reviews = scrape_reviews_from_product_page(asin)
            log.info(f"requests strategy returned {len(reviews)} reviews")

        # If requests didn't get enough, or mode is selenium, use Selenium
        if args.mode == "selenium" or (args.mode == "auto" and len(reviews) < args.max_reviews):
            needed = args.max_reviews - len(reviews)
            log.info(f"Selenium strategy needed for {needed} more reviews")
            selenium_reviews = scrape_reviews_with_selenium(asin, max_reviews=needed)
            # Deduplicate by body
            existing_bodies = {r["body"] for r in reviews}
            for r in selenium_reviews:
                if r["body"] not in existing_bodies:
                    reviews.append(r)
                    existing_bodies.add(r["body"])
            log.info(f"Total after Selenium: {len(reviews)} unique reviews")

        reviews = reviews[:args.max_reviews]

        if not reviews:
            print(json.dumps({
                "success": False,
                "productId": args.product_id,
                "asin": asin,
                "error": "No reviews found — product may have no reviews or Amazon blocked all requests.",
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
        log.exception("Unexpected error in amazon_review_scraper")
        print(json.dumps({
            "success":   False,
            "productId": getattr(args, "product_id", None),
            "error":     str(exc),
        }))
        sys.exit(1)


if __name__ == "__main__":
    main()
