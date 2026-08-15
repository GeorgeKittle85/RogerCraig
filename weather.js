// Weather via Open-Meteo — completely free, no API key required.
// Docs: https://open-meteo.com/

const WEATHER_CODES = {
  0: "Clear sky",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Fog",
  48: "Depositing rime fog",
  51: "Light drizzle",
  53: "Moderate drizzle",
  55: "Dense drizzle",
  61: "Slight rain",
  63: "Moderate rain",
  65: "Heavy rain",
  66: "Freezing rain (light)",
  67: "Freezing rain (heavy)",
  71: "Slight snow fall",
  73: "Moderate snow fall",
  75: "Heavy snow fall",
  77: "Snow grains",
  80: "Slight rain showers",
  81: "Moderate rain showers",
  82: "Violent rain showers",
  85: "Slight snow showers",
  86: "Heavy snow showers",
  95: "Thunderstorm",
  96: "Thunderstorm with slight hail",
  99: "Thunderstorm with heavy hail"
};

async function geocodeRaw(query) {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=1&language=en&format=json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Geocoding request failed: ${res.status}`);
  const data = await res.json();
  return data.results?.[0] ?? null;
}

// Resolve a free-text city name to coordinates using Open-Meteo's geocoding
// API. Open-Meteo matches on the "name" field only (city name), so a query
// like "bend oregon" (no separator) can fail where "Bend, Oregon" or plain
// "Bend" succeeds. To be forgiving of however someone types it, try the
// query as-is first, then fall back to just its first comma-separated (or
// first whitespace-separated) segment.
export async function geocodeCity(query) {
  let r = await geocodeRaw(query);

  if (!r) {
    const firstSegment = query.includes(",") ? query.split(",")[0].trim() : query.split(" ")[0].trim();
    if (firstSegment && firstSegment.toLowerCase() !== query.trim().toLowerCase()) {
      r = await geocodeRaw(firstSegment);
    }
  }

  if (!r) {
    throw new Error(`No location found matching "${query}". Try just the city name, e.g. "Bend" or "Bend, Oregon".`);
  }

  return {
    label: [r.name, r.admin1, r.country].filter(Boolean).join(", "),
    lat: r.latitude,
    lon: r.longitude,
    timezone: r.timezone
  };
}

// Approximate location from the network's public IP. Free, no key, coarse
// accuracy. Free-tier IP geolocation services rate-limit aggressively, so
// this tries a small chain of independent providers and falls through to
// the next on failure/429 rather than failing outright on the first one.
async function tryIpapiCo() {
  const res = await fetch("https://ipapi.co/json/");
  if (res.status === 429) throw new Error("rate-limited");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.reason || "lookup failed");
  return {
    label: [data.city, data.region, data.country_name].filter(Boolean).join(", "),
    lat: data.latitude,
    lon: data.longitude,
    timezone: data.timezone
  };
}

async function tryIpwhoIs() {
  const res = await fetch("https://ipwho.is/");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.success === false) throw new Error(data.message || "lookup failed");
  return {
    label: [data.city, data.region, data.country].filter(Boolean).join(", "),
    lat: data.latitude,
    lon: data.longitude,
    timezone: data.timezone?.id ?? null
  };
}

async function tryIpApiCom() {
  // Free tier is HTTP-only (no HTTPS without a paid plan).
  const res = await fetch("http://ip-api.com/json/");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.status !== "success") throw new Error(data.message || "lookup failed");
  return {
    label: [data.city, data.regionName, data.country].filter(Boolean).join(", "),
    lat: data.lat,
    lon: data.lon,
    timezone: data.timezone
  };
}

export async function geolocateByIp() {
  const providers = [tryIpapiCo, tryIpwhoIs, tryIpApiCom];
  const errors = [];

  for (const provider of providers) {
    try {
      return await provider();
    } catch (err) {
      errors.push(`${provider.name}: ${err.message}`);
    }
  }

  throw new Error(
    `All IP geolocation providers failed or are rate-limited (${errors.join("; ")}). Use /location set <city> instead.`
  );
}

export async function getWeather({ lat, lon, units = "imperial" }) {
  const tempUnit = units === "imperial" ? "fahrenheit" : "celsius";
  const windUnit = units === "imperial" ? "mph" : "kmh";
  const params = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    current: "temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,precipitation",
    daily: "temperature_2m_max,temperature_2m_min,weather_code",
    temperature_unit: tempUnit,
    wind_speed_unit: windUnit,
    timezone: "auto"
  });
  const url = `https://api.open-meteo.com/v1/forecast?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Weather request failed: ${res.status}`);
  const data = await res.json();

  const c = data.current;
  const d = data.daily;

  return {
    current: {
      temp: c.temperature_2m,
      feelsLike: c.apparent_temperature,
      humidity: c.relative_humidity_2m,
      wind: c.wind_speed_10m,
      precipitation: c.precipitation,
      condition: WEATHER_CODES[c.weather_code] ?? "Unknown",
      unit: units === "imperial" ? "F" : "C",
      windUnit: units === "imperial" ? "mph" : "km/h"
    },
    today: {
      high: d.temperature_2m_max[0],
      low: d.temperature_2m_min[0],
      condition: WEATHER_CODES[d.weather_code[0]] ?? "Unknown"
    }
  };
}

export function formatWeatherReport(location, weather) {
  const c = weather.current;
  const t = weather.today;
  const lines = [
    `Weather for ${location}`,
    `→ Currently: ${c.temp}°${c.unit}, ${c.condition} (feels like ${c.feelsLike}°${c.unit})`,
    `→ Humidity: ${c.humidity}%   Wind: ${c.wind} ${c.windUnit}`,
    `→ Today's range: ${t.low}°${c.unit} - ${t.high}°${c.unit}, ${t.condition}`
  ];
  return lines.join("\n");
}
