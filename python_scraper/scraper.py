import sys
import os
sys.path.append(os.path.join(os.path.dirname(__file__), 'libs'))
import json
import time
import requests
from bs4 import BeautifulSoup
from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.chrome.options import Options
from webdriver_manager.chrome import ChromeDriverManager
import datetime
import urllib.parse
import re
import os
from dotenv import load_dotenv
from supabase import create_client, Client

# Load environment variables
# Try loading from backend .env
load_dotenv(os.path.join(os.path.dirname(__file__), '../.env'))

# Configuration
SUPABASE_URL = os.getenv('SUPABASE_URL') or os.getenv('NEXT_PUBLIC_SUPABASE_URL')
SUPABASE_KEY = os.getenv('SUPABASE_SERVICE_ROLE_KEY') or os.getenv('NEXT_PUBLIC_SUPABASE_ANON_KEY')

SITE_CONFIGS = {
    "tunisianet.com.tn": {
        "name": ["h1", "h1.page-title"],
        "price": ["span[itemprop='price']", ".current-price span", "span.price"],
        "reference": [".product-reference span", "span.editable"],
        "overview": ["#description", ".product-description", ".product-information"],
        "category": [".breadcrumb", "nav.breadcrumb"]
    },
    "mytek.tn": {
        "name": ["h1", "span.base"],
        "price": ["span.price", ".price-wrapper span.price"],
        "reference": ["div[itemprop='sku']", ".sku span"],
        "overview": [".product.attribute.overview", ".product-item-details", "#description"],
        "category": [".breadcrumbs", "ul.items"]
    }
}

LIST_CONFIGS = {
    "tunisianet.com.tn": {
        "card": ".product-miniature",
        "name": ".product-title a",
        "price": ".price",
        "url": ".product-title a",
        "img": ".product-thumbnail img",
        "reference": ".product-reference",
        "next": "a.next"
    },
    "mytek.tn": {
        "card": ".product-container",
        "name": ".product-item-link",
        "price": ".price-box",
        "url": ".product-item-link",
        "img": "img",
        "reference": ".sku",
        "next": "a.action.next"
    }
}

def parse_price(price_str):
    """Extracts numeric value from price string. Handles TND format (e.g. '1,099,000 DT' = 1099.000)."""
    if not price_str: return 0.0
    try:
        # Pre-clean: remove all whitespace including non-breaking spaces
        clean_str = re.sub(r'[\s\u00A0\u1680\u180E\u2000-\u200B\u202F\u205F\u3000]', '', price_str.strip())
        
        # Remove non-numeric except commas and dots
        clean = re.sub(r'[^\d.,]', '', clean_str)
        if not clean: return 0.0
        
        # Count commas and dots
        comma_count = clean.count(',')
        dot_count = clean.count('.')
        
        if comma_count >= 1 and dot_count >= 1:
            # Format: 1.099,000 or 1,099.00
            if clean.rfind(',') > clean.rfind('.'):
                # , is decimal: 1.099,000 -> 1099.000
                clean = clean.replace('.', '').replace(',', '.')
            else:
                # . is decimal: 1,099.00 -> 1099.00
                clean = clean.replace(',', '')
        elif comma_count > 0:
            # Single or many commas
            parts = clean.split(',')
            if len(parts) == 2 and len(parts[1]) == 3:
                # TND Millimes: 849,000 -> 849.0
                clean = parts[0] + '.' + parts[1]
            else:
                # Standard decimal or thousand separator
                if comma_count == 1:
                    clean = clean.replace(',', '.')
                else:
                    clean = clean.replace(',', '')
        elif dot_count > 0:
            # Only dots
            if dot_count > 1:
                clean = clean.replace('.', '')
            else:
                parts = clean.split('.')
                if len(parts[1]) == 3:
                    # 849.000 remains 849.000
                    pass
                else:
                    # 19.99 remains 19.99
                    pass

        val = float(clean)
        
        # Final safety check for TND (if value is in millimes like 1150000 instead of 1150.0)
        if val > 50000:
            val = val / 1000.0
            
        return val
    except:
        pass
    return 0.0

def extract_reference_from_url(url, domain):
    if not url: return None
    ref = None
    try:
        clean_url = url.split('?')[0]
        if "mytek.tn" in domain:
            filename = clean_url.split('/')[-1]
            slug = filename.replace('.html', '')
            parts = slug.split('-')
            if parts:
                candidate = parts[-1]
                if len(candidate) <= 2 and len(parts) > 1:
                    candidate = parts[-2] + "-" + candidate
                ref = candidate
        elif "wiki.tn" in domain:
            filename = clean_url.split('/')[-1]
            slug = filename.replace('.html', '')
            parts = slug.split('-')
            for p in reversed(parts):
                if any(c.isdigit() for c in p) and any(c.isalpha() for c in p) and len(p) > 5:
                    ref = p
                    break
    except:
        pass
    return ref

def get_supabase_client():
    if not SUPABASE_URL or not SUPABASE_KEY:
        print("Error: SUPABASE_URL or SUPABASE_KEY not found in environment variables.", file=sys.stderr)
        return None
    try:
        return create_client(SUPABASE_URL, SUPABASE_KEY)
    except Exception as e:
        print(f"Error connecting to Supabase: {e}", file=sys.stderr)
        return None

def extract_specific_data(soup, domain):
    config = None
    for d, cfg in SITE_CONFIGS.items():
        if d in domain:
            config = cfg
            break
    if not config: return None
    data = {}
    meta_price = soup.find("meta", attrs={"property": "product:price:amount"}) or \
                 soup.find("meta", attrs={"itemprop": "price"}) or \
                 soup.find("meta", attrs={"name": "twitter:data1"})
    if meta_price and meta_price.get("content"):
        val = meta_price.get("content").strip()
        data["priceAmount"] = parse_price(val)
        if any(c.isdigit() for c in val):
            if "," not in val and "." not in val and len(val) > 4:
                 data["price"] = f"{val[:-3]} {val[-3:]} DT"
            else:
                 data["price"] = f"{val} DT"

    ref_el = None
    for s in config.get("reference", []):
        ref_el = soup.select_one(s)
        if ref_el and ref_el.get_text().strip():
            data["reference"] = ref_el.get_text().strip()
            break
            
    name_el = None
    for s in config.get("name", []):
        name_el = soup.select_one(s)
        if name_el and name_el.get_text().strip():
            data["name"] = name_el.get_text().strip()
            break

    anchor = ref_el or name_el
    for key in ["price", "overview", "category"]:
        if key in data and data[key] != "Not found": continue
        if anchor:
            curr = anchor
            for _ in range(6):
                for selector in config.get(key, []):
                    found = curr.select_one(selector)
                    if found and found.get_text().strip():
                        val = found.get_text().strip()
                        if key == "price" and (len(val) > 25 or not any(c.isdigit() for c in val)):
                            continue
                        if key == "price":
                            data["priceAmount"] = parse_price(val)
                        data[key] = val
                        break
                if key in data: break
                curr = curr.parent
                if not curr: break
        
        if key not in data or data[key] == "Not found":
            for selector in config.get(key, []):
                found = soup.select_one(selector)
                if found and found.get_text().strip():
                    val = found.get_text().strip()
                    if key == "price":
                        data["priceAmount"] = parse_price(val)
                    data[key] = val
                    break
    for key in ["name", "price", "reference", "overview", "category"]:
        if key not in data: data[key] = "Not found"
    return data

def extract_list_data(soup, domain, min_price=None, max_price=None, name_filter=None, reference_filter=None):
    config = None
    for d, cfg in LIST_CONFIGS.items():
        if d in domain: config = cfg; break
    if not config: return None
    items = []
    cards = soup.select(config["card"])
    print(f"Found {len(cards)} items on {domain}", file=sys.stderr)
    for card in cards:
        try:
            item = {}
            name_el = card.select_one(config["name"])
            if name_el:
                item["name"] = name_el.get_text().strip()
                if not item.get("url"): item["url"] = name_el.get("href")
            if config.get("url") and not item.get("url"):
                 url_el = card.select_one(config["url"])
                 if url_el: item["url"] = url_el.get("href")
            price_el = card.select_one(config["price"])
            if price_el:
                val = price_el.get_text().strip()
                item["price"] = val
                item["priceAmount"] = parse_price(val)
            if config.get("img"):
                img_el = card.select_one(config["img"])
                if img_el: item["image"] = img_el.get("src") or img_el.get("data-src")
            if config.get("reference"):
                ref_el = card.select_one(config["reference"])
                if ref_el: item["reference"] = ref_el.get_text().strip().strip('[]')
            if not item.get("reference") and item.get("url"):
                url_ref = extract_reference_from_url(item.get("url"), domain)
                if url_ref: item["reference"] = url_ref
            if item.get("name") and item.get("url"):
                items.append(item)
        except Exception as e:
            print(f"Error parsing card: {e}", file=sys.stderr); continue
    
    # ------------------
    # ACTUAL FILTERING
    # ------------------
    if min_price or max_price or name_filter or reference_filter:
        print(f"DEBUG: Filtering {len(items)} items...", file=sys.stderr)
        if name_filter: print(f"DEBUG: Name Filter: {name_filter}", file=sys.stderr)
        if reference_filter: print(f"DEBUG: Ref Filter: {reference_filter}", file=sys.stderr)

    final_items = []
    
    for item in items:
        valid = True
        
        # Price Filter
        if min_price is not None or max_price is not None:
             p_val = item.get("priceAmount", 0.0) or 0.0
             if min_price is not None and p_val < min_price: valid = False
             if max_price is not None and p_val > max_price: valid = False
        
        if not valid: 
            continue

        # Name Filter (Substring match)
        if name_filter:
            name = (item.get("name") or "").lower()
            if name_filter not in name: valid = False
            
        if not valid: 
            continue
            
        # Reference Filter (Substring match in Reference OR Name to be robust)
        if reference_filter:
            ref = (item.get("reference") or "").lower()
            name = (item.get("name") or "").lower()
            if reference_filter not in ref and reference_filter not in name: 
                valid = False
            
        if valid: final_items.append(item)
    
    if min_price or max_price or name_filter or reference_filter:
        print(f"Filtered from {len(items)} to {len(final_items)} items matching criteria", file=sys.stderr)
        return final_items
        
    return items

def scrape_static(start_url, min_price=None, max_price=None, name_filter=None, reference_filter=None):
    print(f"Using Static Scraper for: {start_url}", file=sys.stderr)
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'fr-TN,fr;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Cache-Control': 'max-age=0',
    }
    domain = urllib.parse.urlparse(start_url).netloc
    config = None
    for d, cfg in LIST_CONFIGS.items():
        if d in domain: config = cfg; break
    all_list_data = []
    current_url = start_url
    visited_urls = set()
    page_count = 0
    MAX_PAGES = 50
    session = requests.Session()
    session.headers.update(headers)
    while current_url and current_url not in visited_urls and page_count < MAX_PAGES:
        print(f"Scraping page {page_count + 1}: {current_url}", file=sys.stderr)
        visited_urls.add(current_url)
        try:
            response = session.get(current_url, timeout=20, verify=False)
            response.raise_for_status()
            soup = BeautifulSoup(response.text, 'html.parser')
            list_data = extract_list_data(soup, domain, min_price, max_price, name_filter, reference_filter)
            if list_data is not None:
                if page_count == 0 and len(list_data) == 0:
                    # No products on first page — likely bot detection / CAPTCHA
                    print(f"WARNING: 0 items on first page for {current_url} — possible bot detection", file=sys.stderr)
                    return None  # Caller will fall back to Selenium
                all_list_data.extend(list_data)
                page_count += 1
                current_url = None
                if config and config.get("next"):
                    next_el = soup.select_one(config["next"])
                    if next_el and next_el.get("href"):
                        current_url = urllib.parse.urljoin(start_url, next_el.get("href"))
                        time.sleep(1)  # polite delay between pages
            else:
                if page_count == 0:
                     if min_price or max_price or name_filter or reference_filter: return None
                     specific_data = extract_specific_data(soup, domain)
                     data = {"title": soup.title.string.strip() if soup.title else "", "method": "static", "timestamp": datetime.datetime.now().isoformat(), "domain": domain, "type": "single"}
                     if specific_data: data.update(specific_data)
                     return data
                else: break
        except Exception as e:
            print(f"Error scraping {current_url}: {e}", file=sys.stderr); break
    if all_list_data:
         return {"type": "list", "data": all_list_data, "domain": domain, "url": start_url, "timestamp": datetime.datetime.now().isoformat()}
    return None


def scrape_selenium(url, min_price=None, max_price=None, name_filter=None, reference_filter=None):
    print(f"Using Selenium Scraper for: {url}", file=sys.stderr)
    chrome_options = Options()
    chrome_options.add_argument("--headless=new")
    chrome_options.add_argument("--no-sandbox")
    chrome_options.add_argument("--disable-dev-shm-usage")
    chrome_options.add_argument("--window-size=1920,1080")
    service = Service(ChromeDriverManager().install())
    driver = webdriver.Chrome(service=service, options=chrome_options)
    all_list_data = []
    page_count = 0
    MAX_PAGES = 10
    try:
        domain = urllib.parse.urlparse(url).netloc
        driver.get(url)
        from selenium.webdriver.common.by import By
        from selenium.webdriver.support.ui import WebDriverWait
        from selenium.webdriver.support import expected_conditions as EC
        config = None
        for d, cfg in LIST_CONFIGS.items():
            if d in domain: config = cfg; break
        while page_count < MAX_PAGES:
            print(f"Scraping page {page_count + 1}: {driver.current_url}", file=sys.stderr)
            try:
                WebDriverWait(driver, 10).until(EC.presence_of_element_located((By.TAG_NAME, "body")))
            except: break
            driver.execute_script("window.scrollTo(0, document.body.scrollHeight/2)")
            time.sleep(1.5)
            driver.execute_script("window.scrollTo(0, document.body.scrollHeight)")
            time.sleep(1.5)
            soup = BeautifulSoup(driver.page_source, 'html.parser')
            list_data = extract_list_data(soup, domain, min_price, max_price, name_filter, reference_filter)
            if list_data is not None:
                all_list_data.extend(list_data)
                page_count += 1
                if config and config.get("next"):
                    try:
                        next_btns = driver.find_elements(By.CSS_SELECTOR, config["next"])
                        if next_btns and next_btns[0].is_displayed():
                            driver.execute_script("arguments[0].scrollIntoView(true);", next_btns[0])
                            time.sleep(1)
                            driver.execute_script("arguments[0].click();", next_btns[0])
                            time.sleep(3)
                        else: break
                    except: break
                else: break
            else:
                if page_count == 0:
                     if min_price or max_price or name_filter or reference_filter: return None
                     specific_data = extract_specific_data(soup, domain)
                     data = {"title": driver.title, "method": "selenium", "timestamp": datetime.datetime.now().isoformat(), "domain": domain, "type": "single"}
                     if specific_data: data.update(specific_data)
                     return data
                else: break
        if all_list_data:
             return {"type": "list", "data": all_list_data, "domain": domain, "url": url, "timestamp": datetime.datetime.now().isoformat()}
        return None
    finally:
        driver.quit()

def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('website_id')
    parser.add_argument('mode', nargs='?', default='auto')
    parser.add_argument('url', nargs='?')
    parser.add_argument('--minPrice', type=float)
    parser.add_argument('--maxPrice', type=float)
    parser.add_argument('--nameFilter', type=str)
    parser.add_argument('--referenceFilter', type=str)
    args = parser.parse_args()
    min_price = args.minPrice
    max_price = args.maxPrice
    name_filter = args.nameFilter.lower() if args.nameFilter else None
    reference_filter = args.referenceFilter.lower() if args.referenceFilter else None
    
    supabase = get_supabase_client()
    # Priority: use URL passed directly as argument, then fall back to Supabase lookup
    url = args.url if args.url else None
    website_id = args.website_id if args.website_id else None
    
    if not url and supabase:
         # Fetch website URL from Supabase if URL not provided directly
         try:
             response = supabase.table('Website').select('*').eq('id', args.website_id).single().execute()
             if response.data:
                 website = response.data
                 url = website['url']
                 website_id = website['id']
         except Exception as e:
             print(f"Website fetch error: {e}", file=sys.stderr)
    
    if not url:
        url = args.website_id  # Last resort: use the websiteId as URL (direct URL mode)

    print(f"[SCRAPER DEBUG] website_id={args.website_id}", file=sys.stderr)
    print(f"[SCRAPER DEBUG] mode={args.mode}", file=sys.stderr)
    print(f"[SCRAPER DEBUG] url={url}", file=sys.stderr)

    try:
        scraped_data = None
        if args.mode == "auto":
            if "mytek.tn" in url:
                scraped_data = scrape_selenium(url, min_price, max_price, name_filter, reference_filter)
            else:
                try:
                    scraped_data = scrape_static(url, min_price, max_price, name_filter, reference_filter)
                except Exception as static_err:
                    print(f"[SCRAPER DEBUG] Static scrape failed: {static_err}, falling back to Selenium", file=sys.stderr)
                    scraped_data = scrape_selenium(url, min_price, max_price, name_filter, reference_filter)
        elif args.mode == "selenium":
            scraped_data = scrape_selenium(url, min_price, max_price, name_filter, reference_filter)
        else:
            scraped_data = scrape_static(url, min_price, max_price, name_filter, reference_filter)
        if not scraped_data:
            # Always return empty list result rather than an error, so Node can handle gracefully
            print(json.dumps({"success": True, "data": {"type": "list", "data": [], "count": 0, "domain": urllib.parse.urlparse(url).netloc, "url": url, "timestamp": datetime.datetime.now().isoformat()}}))
            return

        # NOTE: Database writes are handled by Node.js/Prisma (scraperService.js).
        # The Python scraper only scrapes and outputs JSON — do NOT write to DB here.
        # (Previous Supabase write code caused 'permission denied' errors that crashed output.)

        print(json.dumps({"success": True, "data": scraped_data}))
    except Exception as e:
        print(json.dumps({"error": str(e)}))

if __name__ == "__main__":
    main()
