"""Live context for questions the camera can't answer: weather, tonight's sky, SpaceX launches, the ISS.

Free, keyless APIs: Open-Meteo (weather), Launch Library 2 (launches; the old SpaceX API is offline),
wheretheiss.at (ISS). The moon phase is computed locally. Every fetch has a timeout and a cache; a
stale value is served while a refresh runs behind it, and a failed source is left out of the note.
prefetch() warms the cache, so a question usually waits on nothing.

  python live.py                                         # self-check, no network
  python live.py fetch "what can I see in space tonight"  # real APIs, prints the note
"""
import asyncio
import logging
import math
import os
import re
import statistics
import time
from datetime import datetime, timezone

log = logging.getLogger("iris.live")

LAT = float(os.getenv("IRIS_LAT") or 42.2780)    # MHacks, Ann Arbor
LON = float(os.getenv("IRIS_LON") or -83.7382)
PLACE = os.getenv("IRIS_PLACE") or "Ann Arbor"
WAIT_S = 1.5        # longest a question waits on a cold source
FETCH_S = 4.0       # a refresh may keep going behind the question to fill the cache
TTL = {"weather": (600, 3 * 3600), "launch": (1800, 6 * 3600), "iss": (15, 0)}   # (fresh, servable stale) s
SOURCES = {"weather": "Open-Meteo", "launch": "Launch Library 2 (SpaceX)", "iss": "wheretheiss.at"}

TOPICS = {
    "weather": r"\b(weather|temperature|forecast|rain(?!coat)\w*|snow\w*|windy|sunny|cloudy|"
               r"how (hot|cold|warm) is it|is it (hot|cold|warm|nice) out)",
    "sky": r"\b(sky|stars|stargaz\w*|moon|sunset|sunrise|planets?|meteors?|aurora|northern lights)\b"
           r"|\btonight\b.*\b(see|look|space|sky|out|up)\b|\bspace\b.*\btonight\b",
    "launch": r"\b(spacex|launch(es)?|rockets?|falcon|starship|starlink|dragon capsule)\b",
    "iss": r"\b(iss|space station)\b",
}
# Things you carry for the weather. "Do I need an umbrella" is a weather question;
# "where did I leave my umbrella" is about the thing, and the forecast is noise in the answer.
GEAR = re.compile(r"\b(umbrella|jacket|raincoat)s?\b", re.I)
MISPLACED = re.compile(r"\b(where|when did i|did i (leave|see|put)|left my|lost my|find my)\b", re.I)
NEEDS = {"weather": {"weather"}, "sky": {"weather", "launch", "iss"}, "launch": {"launch"}, "iss": {"iss"}}

WMO = {0: "clear", 1: "mostly clear", 2: "partly cloudy", 3: "overcast", 45: "foggy", 48: "foggy",
       51: "light drizzle", 53: "drizzle", 55: "heavy drizzle", 56: "freezing drizzle", 57: "freezing drizzle",
       61: "light rain", 63: "rain", 65: "heavy rain", 66: "freezing rain", 67: "freezing rain",
       71: "light snow", 73: "snow", 75: "heavy snow", 77: "snow grains", 80: "rain showers",
       81: "rain showers", 82: "heavy rain showers", 85: "snow showers", 86: "heavy snow showers",
       95: "thunderstorms", 96: "thunderstorms with hail", 99: "thunderstorms with hail"}


def topics(question):
    q = question or ""
    found = {t for t, pattern in TOPICS.items() if re.search(pattern, q, re.I)}
    if GEAR.search(q) and not MISPLACED.search(q):
        found.add("weather")
    return found


# ---------- fetchers ----------

async def fetch_weather(http):
    r = await http.get("https://api.open-meteo.com/v1/forecast", timeout=FETCH_S, params=dict(
        latitude=LAT, longitude=LON, timezone="auto", forecast_days=2,
        temperature_unit="fahrenheit", wind_speed_unit="mph",
        current="temperature_2m,apparent_temperature,weather_code,wind_speed_10m",
        hourly="cloud_cover,precipitation_probability",
        daily="sunset,temperature_2m_max,temperature_2m_min,precipitation_probability_max"))
    r.raise_for_status()
    return r.json()


async def fetch_launches(http):
    r = await http.get("https://ll.thespacedevs.com/2.3.0/launches/upcoming/", timeout=FETCH_S,
                       params={"limit": 3, "mode": "list", "lsp__name": "SpaceX"})
    r.raise_for_status()
    return r.json()


async def fetch_iss(http):
    r = await http.get("https://api.wheretheiss.at/v1/satellites/25544", timeout=FETCH_S)
    r.raise_for_status()
    return r.json()


FETCH = {"weather": fetch_weather, "launch": fetch_launches, "iss": fetch_iss}
_cache = {}      # key -> (fetched_at, json)
_inflight = {}   # key -> task, so a question and a prefetch share one request


async def _refresh(key, http):
    try:
        _cache[key] = (time.time(), await FETCH[key](http))
        return _cache[key][1]
    except Exception as e:  # noqa: BLE001
        log.warning("live %s failed: %s", key, e)
        return None


def _start(key, http):
    if key not in _inflight:
        t = _inflight[key] = asyncio.create_task(_refresh(key, http))
        t.add_done_callback(lambda _: _inflight.pop(key, None))
    return _inflight[key]


async def get(key, http):
    """Fresh value, or a servable stale one (refreshing behind it), or wait up to WAIT_S. None on failure."""
    fresh, stale = TTL[key]
    hit = _cache.get(key)
    age = time.time() - hit[0] if hit else None
    if hit and age < fresh:
        return hit[1]
    task = _start(key, http)
    if hit and age < stale:
        return hit[1]
    try:
        return await asyncio.wait_for(asyncio.shield(task), WAIT_S)
    except asyncio.TimeoutError:
        return None


async def prefetch(http):
    await asyncio.gather(get("weather", http), get("launch", http))


# ---------- notes ----------

def clock(t):
    return t.strftime("%I:%M %p").lstrip("0")


def when(t, now):
    days = (t.date() - now.date()).days
    day = "today" if days == 0 else "tomorrow" if days == 1 else t.strftime("%a %b %d").replace(" 0", " ")
    return f"{day} at {clock(t)}"


def weather_note(j):
    c, d, h = j["current"], j["daily"], j["hourly"]
    i = next((n for n, t in enumerate(h["time"]) if t[:13] == c["time"][:13]), 0)
    soon = max(h["precipitation_probability"][i:i + 3] or [0])
    return (f"Weather in {PLACE} now: {round(c['temperature_2m'])}F, feels like {round(c['apparent_temperature'])}F, "
            f"{WMO.get(c['weather_code'], 'unknown sky')}, wind {round(c['wind_speed_10m'])} mph. "
            f"Today: high {round(d['temperature_2m_max'][0])}F, low {round(d['temperature_2m_min'][0])}F, "
            f"{d['precipitation_probability_max'][0]}% chance of rain; {soon}% in the next 3 hours.")


def sky_note(j):
    sunset = j["daily"]["sunset"][0]
    h = j["hourly"]
    i = next((n for n, t in enumerate(h["time"]) if t[:13] == sunset[:13]), None)
    night = h["cloud_cover"][i + 1:i + 7] if i is not None else []
    line = f"Tonight in {PLACE}: sunset {clock(datetime.fromisoformat(sunset))}"
    if night:
        avg = round(statistics.mean(night))
        verdict = "clear, good for stargazing" if avg < 30 else "partly cloudy" if avg < 70 else "cloudy, stars mostly hidden"
        line += f", about {avg}% cloud cover after dark ({verdict})"
    return line + "."


def moon_note(now):
    """Moon phase from the mean synodic month; good to about a day, plenty for 'is the moon out'."""
    syn = 29.530588853
    ref = datetime(2000, 1, 6, 18, 14, tzinfo=timezone.utc)   # a known new moon
    age = ((now - ref).total_seconds() / 86400) % syn
    lit = round(100 * (1 - math.cos(2 * math.pi * age / syn)) / 2)
    names = ["new moon", "waxing crescent", "first quarter", "waxing gibbous",
             "full moon", "waning gibbous", "last quarter", "waning crescent", "new moon"]
    return f"Moon: {names[int((age / syn) * 8 + 0.5)]}, {lit}% lit."


def launch_note(j, now):
    items = []
    for launch in j.get("results", [])[:3]:
        rocket, _, mission = launch["name"].partition("|")
        t = datetime.fromisoformat(launch["net"].replace("Z", "+00:00")).astimezone(now.tzinfo)
        exact = (launch.get("net_precision") or {}).get("name", "") in ("", "Second", "Minute", "Hour")
        at = when(t, now) if exact else "no earlier than " + t.strftime("%b %d").replace(" 0", " ")
        status = (launch.get("status") or {}).get("name", "")
        items.append(f"{mission.strip() or rocket.strip()} on {rocket.replace('Block 5', '').strip()}, {at}"
                     + (f" ({status})" if status else ""))
    return "Next SpaceX launches: " + "; ".join(items) + "." if items else ""


def iss_note(j):
    la, lo = math.radians(j["latitude"]), math.radians(j["longitude"])
    la0, lo0 = math.radians(LAT), math.radians(LON)
    km = 6371 * math.acos(min(1.0, math.sin(la) * math.sin(la0) + math.cos(la) * math.cos(la0) * math.cos(lo - lo0)))
    ns, ew = ("N" if j["latitude"] >= 0 else "S"), ("E" if j["longitude"] >= 0 else "W")
    lit = "in sunlight" if j.get("visibility") == "daylight" else "in Earth's shadow"
    return (f"ISS right now: over {abs(j['latitude']):.0f}{ns} {abs(j['longitude']):.0f}{ew}, "
            f"about {round(km, -2):,.0f} km from {PLACE}, at {round(j['altitude'])} km altitude, {lit}.")


async def note(question, http, now=None):
    """-> (text, sources). Empty when the question needs no live data. Never raises."""
    found = topics(question)
    if not found:
        return "", []
    now = now or datetime.now().astimezone()
    keys = sorted(set().union(*(NEEDS[t] for t in found)))
    data = dict(zip(keys, await asyncio.gather(*(get(k, http) for k in keys), return_exceptions=True)))
    parts = []
    if "sky" in found:
        parts += [("weather", lambda j: sky_note(j)), (None, lambda _: moon_note(now))]
    if "weather" in found:
        parts.append(("weather", weather_note))
    parts += [("launch", lambda j: launch_note(j, now)), ("iss", iss_note)]
    lines, sources = [], []
    for key, fmt in parts:
        j = data.get(key) if key else True
        if key and (j is None or isinstance(j, Exception)):
            continue
        try:
            line = fmt(j)
        except Exception as e:  # noqa: BLE001 - an API changed shape; leave that source out
            log.warning("live %s note failed: %s", key, e)
            continue
        if line:
            lines.append(line)
            if key and SOURCES[key] not in sources:
                sources.append(SOURCES[key])
    return "\n".join(lines), sources


if __name__ == "__main__":
    import sys

    import httpx

    if sys.argv[1:2] == ["fetch"]:
        async def show():
            async with httpx.AsyncClient() as http:
                t0 = time.monotonic()
                text, sources = await note(" ".join(sys.argv[2:]) or "what can I see in space tonight", http)
                print(f"{text or '(no live data needed)'}\nsources: {sources}  ({int((time.monotonic() - t0) * 1000)}ms)")
        asyncio.run(show())
        sys.exit()

    assert topics("how is the weather") == {"weather"}
    assert topics("what to expect to see in space tonight") == {"sky"}
    assert topics("when is the next SpaceX launch?") == {"launch"}
    assert topics("where is the ISS") == {"iss"}
    assert topics("how much protein is in this?") == set()
    assert topics("what are you doing tonight") == set()
    # Weather gear: asking whether to take it is a weather question, asking where it is isn't.
    for q in ("do I need an umbrella?", "should I take a jacket", "is this jacket warm enough", "raincoat today?"):
        assert topics(q) == {"weather"}, q
    for q in ("where did I leave my umbrella?", "where is my jacket", "where's my raincoat", "did I leave my umbrella here",
              "when did I see my jacket", "I lost my umbrella"):
        assert topics(q) == set(), q
    assert topics("where did I leave my umbrella, is it raining?") == {"weather"}   # still asks about the weather

    tz = timezone.utc
    now = datetime(2026, 10, 3, 17, 15, tzinfo=tz)
    meteo = {"current": {"time": "2026-10-03T17:15", "temperature_2m": 61.7, "apparent_temperature": 58.7,
                         "weather_code": 0, "wind_speed_10m": 5.0},
             "hourly": {"time": [f"2026-10-03T{h:02d}:00" for h in range(24)] + [f"2026-10-04T{h:02d}:00" for h in range(24)],
                        "cloud_cover": [10] * 48, "precipitation_probability": [0] * 17 + [40] + [0] * 30},
             "daily": {"sunset": ["2026-10-03T19:12"], "temperature_2m_max": [62.6], "temperature_2m_min": [45.4],
                       "precipitation_probability_max": [4]}}
    assert "62F" in weather_note(meteo) and "clear" in weather_note(meteo) and "40% in the next 3 hours" in weather_note(meteo)
    assert sky_note(meteo) == "Tonight in Ann Arbor: sunset 7:12 PM, about 10% cloud cover after dark (clear, good for stargazing)."
    assert moon_note(datetime(2024, 4, 8, 18, 0, tzinfo=tz)).startswith("Moon: new moon")      # eclipse day
    assert moon_note(datetime(2024, 4, 23, 23, 0, tzinfo=tz)).startswith("Moon: full moon")
    ll2 = {"results": [{"name": "Falcon 9 Block 5 | Starlink 12-3", "net": "2026-10-04T08:17:00Z",
                        "net_precision": {"name": "Minute"}, "status": {"name": "Go for Launch"}},
                       {"name": "Starship | Flight 14", "net": "2026-11-01T00:00:00Z", "net_precision": {"name": "Month"}}]}
    assert launch_note(ll2, now) == ("Next SpaceX launches: Starlink 12-3 on Falcon 9, tomorrow at 8:17 AM (Go for Launch); "
                                     "Flight 14 on Starship, no earlier than Nov 1.")
    assert "km from Ann Arbor" in iss_note({"latitude": 42.0, "longitude": -80.0, "altitude": 420, "visibility": "eclipsed"})

    async def check():
        calls = []

        async def ok(http):
            calls.append(1)
            return meteo

        async def slow(http):
            await asyncio.sleep(5)

        async def broken(http):
            raise RuntimeError("HTTP 500")

        FETCH.update(weather=ok, launch=broken, iss=slow)
        text, sources = await note("how's the weather", None, now)
        assert "62F" in text and sources == ["Open-Meteo"], (text, sources)
        assert await note("where did I leave my umbrella?", None, now) == ("", [])   # recall: no lookup, no source
        await note("is it going to rain", None, now)
        assert len(calls) == 1                                  # second question served from cache
        async def slow_ok(http):
            await asyncio.sleep(0.3)
            return await ok(http)

        _cache["weather"] = (time.time() - 700, meteo)          # stale but servable
        FETCH["weather"] = slow_ok
        t0 = time.monotonic()
        assert (await note("weather?", None, now))[0] and time.monotonic() - t0 < 0.2   # no wait on the refresh
        await asyncio.sleep(0.4)
        assert len(calls) == 2 and time.time() - _cache["weather"][0] < 1                # ...which ran behind it
        FETCH["weather"] = ok
        t0 = time.monotonic()
        text, sources = await note("what can I see in space tonight", None, now)
        assert time.monotonic() - t0 < WAIT_S + 0.5             # slow ISS waited at most WAIT_S
        assert "sunset" in text and "Moon:" in text and "ISS" not in text and "launches" not in text, text
        for t in list(_inflight.values()):
            t.cancel()

    asyncio.run(check())
    print("live ok")
