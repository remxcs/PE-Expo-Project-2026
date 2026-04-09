import httpx
import time
import json
import re
import trafilatura
from bs4 import BeautifulSoup
from urllib.parse import urljoin

RATE_LIMIT = 1.5
USER_AGENT = "SwimSetDatasetBot/1.0 (ethical research)"
FOCUS_CERTAINTY_THRESHOLD = 0.60
DISTANCE_UNIT_PATTERN = r"(m|meter|meters|metre|metres|yd|yds|yard|yards)"

visited = set()

dataset = {
    "sets": []
}

STROKE_KEYWORDS = {
    "freestyle": "Freestyle",
    "free": "Freestyle",
    "front crawl": "Front Crawl",
    "crawl": "Crawl",
    "backstroke": "Backstroke",
    "back": "Backstroke",
    "breaststroke": "Breaststroke",
    "breast": "Breaststroke",
    "butterfly": "Butterfly",
    "fly": "Butterfly",
    "im": "Individual Medley",
    "medley": "Individual Medley",
}

STROKE_ABBREVIATIONS = {
    "f/c": "Front Crawl",
    "b/c": "Back Crawl",
}


# -----------------------
# HTTP Fetch
# -----------------------
def fetch(url):
    time.sleep(RATE_LIMIT)

    headers = {
        "User-Agent": USER_AGENT
    }

    r = httpx.get(url, headers=headers, timeout=20)
    r.raise_for_status()

    return r.text


# -----------------------
# Extract Links
# -----------------------
def extract_links(html, base_url):
    soup = BeautifulSoup(html, "html.parser")
    links = []

    for a in soup.find_all("a", href=True):
        href = urljoin(base_url, a["href"])

        if base_url in href:
            links.append(href)

    return links


# -----------------------
# Detect Set Type
# -----------------------
def detect_type(text):
    t = text.lower()

    if "main set" in t:
        return "main"

    if re.search(r"\b(cool[\s-]*down|warm[\s-]*down)\b", t):
        return "cooldown"

    if re.search(r"\bwarm\s*up\b", t):
        return "warmup"

    if "kick" in t:
        return "kick"

    if "pull" in t:
        return "pull"

    if "drill" in t:
        return "drill"

    if "sprint" in t:
        return "sprint"

    if "build" in t:
        return "preset"

    return "main"


# -----------------------
# Estimate Distance
# -----------------------
def estimate_distance(text):
    # match 10x100
    match = re.search(r"(\d+)\s*x\s*(\d+)", text.lower())
    if match:
        return int(match.group(1)) * int(match.group(2))

    # fallback single distance
    match = re.search(r"\b(\d{2,4})\b", text)
    if match:
        return int(match.group(1))

    return None


# -----------------------
# Detect intensity
# -----------------------
def detect_intensity(text):
    t = text.lower()

    if "steady" in t:
        return "steady"

    if "faster than" in t:
        return "moderate"

    if "easy" in t:
        return "easy"

    if "moderate" in t:
        return "moderate"

    if "threshold" in t:
        return "threshold"

    if "sprint" in t:
        return "sprint"

    if "fast" in t and "faster than" not in t:
        return "fast"

    return None


def detect_equipment(text):
    t = text.lower()
    equipment = []
    equipment_keywords = {
        "kickboard": "Kickboard",
        "float": "Float",
        "pull buoy": "Pull Buoy",
        "paddles": "Paddles",
        "fins": "Fins",
        "snorkel": "Snorkel",
    }

    for key, label in equipment_keywords.items():
        if key in t and label not in equipment:
            equipment.append(label)

    return equipment


def detect_training_focus(text, parsed_distance=None, intensity=None):
    t = text.lower()
    focuses = []
    certainty_scores = {}

    # Internal certainty gate with cumulative scoring.
    # Multiple weak hits can cross the threshold.
    focus_rules = {
        "lactate": {
            "strong": [
                "lactate", "anaerobic", "max effort", "all out",
                "race pace", "threshold"
            ],
            "weak": ["sprint", "descend", "hard", "fast"]
        },
        "breathing": {
            "strong": [
                "breathing", "breathe", "breath", "hypoxic",
                "bilateral", "every 3", "every 5", "every 7"
            ],
            "weak": []
        },
        "technique": {
            "strong": [
                "technique", "drill", "stroke count", "scull",
                "catch", "fingertip drag", "kickboard", "kick board",
                "float", "vertical", "hold"
            ],
            "weak": ["form", "timing", "control"]
        },
        "stamina": {
            "strong": ["endurance", "stamina", "aerobic"],
            "weak": ["steady", "distance"]
        },
    }

    for focus, rule in focus_rules.items():
        strong_matches = [k for k in rule["strong"] if k in t]
        weak_matches = [k for k in rule["weak"] if k in t]

        strong_hits = len(strong_matches)
        weak_hits = len(weak_matches)
        weak_bonus = max(0, weak_hits - 1) * 0.1
        certainty = min(1.0, (strong_hits * 0.85) + (weak_hits * 0.3) + weak_bonus)

        certainty_scores[focus] = round(certainty, 2)

        if certainty >= FOCUS_CERTAINTY_THRESHOLD:
            focuses.append(focus)

    # Inference rules from parsed set structure.
    if parsed_distance:
        reps = parsed_distance.get("reps")
        distance = parsed_distance.get("distance")

        # Stamina rule 1: high count of 100s (or longer).
        if reps is not None and reps >= 6 and distance is not None and distance >= 100:
            inferred = max(certainty_scores.get("stamina", 0.0), 0.85)
            certainty_scores["stamina"] = round(inferred, 2)
            if "stamina" not in focuses and inferred >= FOCUS_CERTAINTY_THRESHOLD:
                focuses.append("stamina")

        # Stamina rule 2: more than 3 reps of 250+.
        if reps is not None and reps > 3 and distance is not None and distance >= 250:
            inferred = max(certainty_scores.get("stamina", 0.0), 0.9)
            certainty_scores["stamina"] = round(inferred, 2)
            if "stamina" not in focuses and inferred >= FOCUS_CERTAINTY_THRESHOLD:
                focuses.append("stamina")

        # Lots of short reps with speed cues generally target lactate.
        speed_cue = (
            (intensity in {"fast", "sprint", "threshold"})
            or ("sprint" in t)
            or ("all out" in t)
            or ("max effort" in t)
            or ("race pace" in t)
            or ("fast" in t and "faster than" not in t)
        )
        if reps is not None and reps >= 6 and distance is not None and distance <= 75 and speed_cue:
            inferred = max(certainty_scores.get("lactate", 0.0), 0.85)
            certainty_scores["lactate"] = round(inferred, 2)
            if "lactate" not in focuses and inferred >= FOCUS_CERTAINTY_THRESHOLD:
                focuses.append("lactate")

    if not focuses:
        focuses.append("general")

    return focuses, certainty_scores


def normalize_strokes(text):
    t = text.lower()
    found = []

    for short, full in STROKE_ABBREVIATIONS.items():
        if short in t and full not in found:
            found.append(full)

    for key, full in STROKE_KEYWORDS.items():
        if re.search(rf"\b{re.escape(key)}\b", t) and full not in found:
            found.append(full)

    # If specific crawl styles were found, drop generic crawl label.
    if "Crawl" in found and ("Front Crawl" in found or "Back Crawl" in found):
        found = [s for s in found if s != "Crawl"]

    return found


def parse_reps_distance(text):
    t = text.lower()

    def normalize_distance_unit(unit):
        if not unit:
            return None
        u = unit.lower()
        if u in {"m", "meter", "meters", "metre", "metres"}:
            return "m"
        if u in {"yd", "yds", "yard", "yards"}:
            return "yd"
        return u

    # ex: 300 Free 300 Free 300 Free -> 3 x 300m
    repeated_simple_sets = re.findall(
        rf"\b(\d{{2,4}})\s*{DISTANCE_UNIT_PATTERN}?\s*(free|freestyle|front crawl|backstroke|back|breaststroke|breast|fly|butterfly|im|medley)\b",
        t
    )
    if len(repeated_simple_sets) >= 2:
        first_distance, first_unit, first_stroke = repeated_simple_sets[0]
        all_same = all(
            d == first_distance and (u or "") == (first_unit or "") and s == first_stroke
            for d, u, s in repeated_simple_sets
        )
        if all_same:
            reps = len(repeated_simple_sets)
            distance = int(first_distance)
            unit = normalize_distance_unit(first_unit) if first_unit else "m"
            return {
                "reps": reps,
                "distance": distance,
                "distance_unit": unit,
                "total_distance": reps * distance
            }

    # ex: 450m1 x 50m (total then interval format from scraped text)
    total_then_interval = re.search(
        rf"\b(\d{{2,4}})\s*{DISTANCE_UNIT_PATTERN}\s*(\d{{1,3}})\s*x\s*(\d{{1,4}})\s*{DISTANCE_UNIT_PATTERN}?\b",
        t
    )
    if total_then_interval:
        total_distance = int(total_then_interval.group(1))
        total_unit = normalize_distance_unit(total_then_interval.group(2))
        listed_reps = int(total_then_interval.group(3))
        interval_distance = int(total_then_interval.group(4))
        interval_unit = normalize_distance_unit(total_then_interval.group(5)) if total_then_interval.group(5) else total_unit
        computed_reps = total_distance // interval_distance if interval_distance else listed_reps
        if total_distance % interval_distance != 0:
            computed_reps = listed_reps

        return {
            "reps": computed_reps,
            "distance": interval_distance,
            "distance_unit": interval_unit,
            "total_distance": total_distance
        }

    # ex: 20x25m, 5 x 100 yd
    multi = re.search(rf"\b(\d{{1,3}})\s*x\s*(\d{{1,4}})\s*{DISTANCE_UNIT_PATTERN}?\b", t)
    if multi:
        reps = int(multi.group(1))
        distance = int(multi.group(2))
        unit = normalize_distance_unit(multi.group(3)) if multi.group(3) else None
        return {
            "reps": reps,
            "distance": distance,
            "distance_unit": unit,
            "total_distance": reps * distance
        }

    # ex: 100m, 100 yd, 100 meters, 100 yards
    single = re.search(rf"\b(\d{{2,4}})\s*{DISTANCE_UNIT_PATTERN}\b", t)
    if single:
        distance = int(single.group(1))
        unit = normalize_distance_unit(single.group(2)) if single.group(2) else None
        return {
            "reps": None,
            "distance": distance,
            "distance_unit": unit,
            "total_distance": distance
        }

    # ex: 100 Free @ 1:20 (no explicit unit, but clear set context)
    single_contextual = re.search(
        r"\b(\d{2,4})\b(?=\s*(?:free|freestyle|front crawl|back|backstroke|breast|breaststroke|fly|butterfly|im|medley|swim|kick|pull|drill|@|on\b))",
        t
    )
    if single_contextual:
        distance = int(single_contextual.group(1))
        return {
            "reps": None,
            "distance": distance,
            "distance_unit": None,
            "total_distance": distance
        }

    return {
        "reps": None,
        "distance": None,
        "distance_unit": None,
        "total_distance": None
    }


def parse_time_target(text):
    # Collect all time targets in written order.
    times = re.findall(r"\b(\d{1,2}:\d{2}(?:\.\d+)?)\b", text.lower())
    if not times:
        return None
    return times


def parse_rest(text):
    t = text.lower()

    # ex: "rest 20 sec", "20 sec rest", "rest 0:20", "0:15 rest"
    time_match = re.search(r"\brest\s*(?:for\s*)?(\d{1,3})\s*(?:s|sec|secs|second|seconds)\b", t)
    if not time_match:
        time_match = re.search(r"\b(\d{1,3})\s*(?:s|sec|secs|second|seconds)\s*rest\b", t)
    if not time_match:
        time_match = re.search(r"\brest\s*(?:for\s*)?(\d{1,2}:\d{2}(?:\.\d+)?)\b", t)
    if not time_match:
        for candidate in re.finditer(r"\b(\d{1,2}:\d{2}(?:\.\d+)?)\s*rest\b", t):
            token_start = candidate.start(1)
            prefix = t[max(0, token_start - 4):token_start]
            # Skip interval markers like "@ 1:00 rest" or "on 1:30 rest".
            if "@" in prefix or prefix.endswith("on "):
                continue
            time_match = candidate
            break

    if time_match:
        token = time_match.group(1)
        return {
            "raw": time_match.group(0).strip(),
            "type": "time",
            "value": token if ":" in token else f"{token}s"
        }

    # ex: "rest 50m easy", "50m easy between"
    distance_match = re.search(rf"\brest\s*(\d{{2,4}})\s*{DISTANCE_UNIT_PATTERN}\b", t)
    if distance_match:
        unit_raw = distance_match.group(2)
        unit = "m" if unit_raw in {"m", "meter", "meters", "metre", "metres"} else "yd"
        return {
            "raw": distance_match.group(0).strip(),
            "type": "distance",
            "value": int(distance_match.group(1)),
            "unit": unit
        }

    # ex: "rest 10 breaths"
    breaths_match = re.search(r"\brest\s*(\d{1,2})\s*breaths?\b", t)
    if breaths_match:
        return {
            "raw": breaths_match.group(0).strip(),
            "type": "breaths",
            "value": int(breaths_match.group(1))
        }

    return None


def is_probable_set(line):
    l = line.lower()
    return bool(
        re.search(rf"\b\d{{1,3}}\s*x\s*\d{{1,4}}\s*{DISTANCE_UNIT_PATTERN}?\b", l)
        or "@" in l
        or " on " in f" {l} "
        or any(k in l for k in ["swim", "kick", "pull", "drill", "free", "fly", "back", "breast", "im", "medley"])
    )


# -----------------------
# Parse atomic sets
# -----------------------
def extract_sets(text, source_url):
    lines = [l.strip() for l in text.split("\n") if l.strip()]

    for line in lines:
        if not is_probable_set(line):
            continue

        parsed_distance = parse_reps_distance(line)
        strokes = normalize_strokes(line)
        time_target = parse_time_target(line)
        rest = parse_rest(line)
        intensity = detect_intensity(line)
        training_focus, training_focus_certainty = detect_training_focus(
            line,
            parsed_distance=parsed_distance,
            intensity=intensity
        )

        # Hard requirement: keep only entries with a parsable distance.
        if parsed_distance["distance"] is None:
            continue

        core_signal_count = 0
        if strokes:
            core_signal_count += 1
        if parsed_distance["distance"] is not None or parsed_distance["reps"] is not None:
            core_signal_count += 1
        if time_target is not None:
            core_signal_count += 1
        if rest is not None:
            core_signal_count += 1
        if intensity is not None:
            core_signal_count += 1

        # keep only likely real sets
        if core_signal_count < 2:
            continue

        set_obj = {
            "text": line,
            "type": detect_type(line),
            "reps": parsed_distance["reps"],
            "distance": parsed_distance["distance"],
            "distance_unit": parsed_distance["distance_unit"],
            "total_distance": parsed_distance["total_distance"],
            "time_target": time_target,
            "rest": rest,
            "strokes": strokes,
            "equipment": detect_equipment(line),
            "training_focus": training_focus,
            "training_focus_certainty": training_focus_certainty,
            "intensity": intensity,
            "source": source_url,
            "tags": []
        }

        dataset["sets"].append(set_obj)


# -----------------------
# Crawl site
# -----------------------
def crawl(seed_urls, max_pages=30):

    for seed in seed_urls:

        try:
            html = fetch(seed)

            text = trafilatura.extract(html)

            if text:
                extract_sets(text, seed)

            links = extract_links(html, seed)

            for link in links[:max_pages]:

                if link in visited:
                    continue

                visited.add(link)

                try:
                    html = fetch(link)
                    text = trafilatura.extract(html)

                    if text:
                        extract_sets(text, link)

                except Exception:
                    continue

        except Exception:
            continue


# -----------------------
# Deduplicate
# -----------------------
def dedupe():
    unique = {}

    for s in dataset["sets"]:
        key = s["text"].lower().strip()
        unique[key] = s

    dataset["sets"] = list(unique.values())


# -----------------------
# Save JSON
# -----------------------
def save():
    with open("swim_set_library.json", "w", encoding="utf-8") as f:
        json.dump(dataset, f, indent=2, ensure_ascii=False)


# -----------------------
# Main
# -----------------------
if __name__ == "__main__":

    seed_urls = [
        "https://www.swimmingworldmagazine.com/news/six-swim-workout-sets-to-try-at-practice/",
        "https://betterme.world/articles/beginner-swim-sets/",
        "https://www.speedo.com/blog/swim-plan/best-30-minute-swim-workouts/",
        "https://shopzygo.com/blogs/blog/swimming-workouts",
        "https://swimswam.com/distance-swimming-workouts/",
        "https://www.yourswimlog.com/swimming-workouts/",
        "https://www.yourswimlog.com/swimming-workouts-for-beginners/",
        "https://blog.myswimpro.com/2021/11/16/top-4-swim-workouts-to-build-speed-power/",
        "https://swimswam.com/sprint-swim-workouts/"
    ]

    crawl(seed_urls)

    dedupe()

    save()

    print(f"Saved {len(dataset['sets'])} swim sets")