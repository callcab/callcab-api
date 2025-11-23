// pages/api/weather.js
// Comprehensive weather data optimized for voice AI

export default async function handler(req, res) {
  // CORS headers
  const ALLOW_ORIGIN = '*';
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', ALLOW_ORIGIN);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(200).end();
  }
  res.setHeader('Access-Control-Allow-Origin', ALLOW_ORIGIN);

  try {
    if (req.method !== 'GET' && req.method !== 'POST') {
      return res.status(405).json({ ok: false, error: 'Method not allowed' });
    }

    const { lat, lng, address } = (req.method === 'GET' ? req.query : req.body) || {};
    
    if (!lat || !lng) {
      return res.status(400).json({ 
        ok: false, 
        error: 'Missing lat or lng',
        details: 'Both latitude and longitude are required' 
      });
    }

    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ ok: false, error: 'No Weather API key configured' });
    }

    // Call Google Weather API v1
    const url = new URL('https://weather.googleapis.com/v1/forecast/days:lookup');
    url.searchParams.set('key', apiKey);
    url.searchParams.set('location.latitude', lat);
    url.searchParams.set('location.longitude', lng);
    url.searchParams.set('days', '1');
    url.searchParams.set('unitsSystem', 'IMPERIAL'); // Fahrenheit, mph

    const weatherRes = await fetch(url.toString());
    
    if (!weatherRes.ok) {
      const errorData = await weatherRes.json();
      console.error('[weather] Google API error:', errorData);
      return res.status(weatherRes.status).json({
        ok: false,
        error: 'GOOGLE_WEATHER_API_ERROR',
        status: weatherRes.status,
        details: errorData
      });
    }

    const weatherData = await weatherRes.json();

    // Parse the forecast data
    const forecastDays = weatherData.forecastDays || [];
    if (!forecastDays.length) {
      return res.status(200).json({
        ok: false,
        error: 'NO_FORECAST_DATA',
        message: 'No weather data available for this location'
      });
    }

    const today = forecastDays[0];
    const current = today.currentConditions || {};
    const daytime = today.daytimeForecast || {};
    const overnight = today.overnightForecast || {};

    // Determine if it's day or night
    const now = new Date();
    const sunrise = today.sunrise ? new Date(today.sunrise) : null;
    const sunset = today.sunset ? new Date(today.sunset) : null;
    
    let daypart = 'day';
    if (sunrise && sunset) {
      daypart = (now >= sunrise && now < sunset) ? 'day' : 'night';
    }

    // Select appropriate forecast (day vs night)
    const activeForecast = daypart === 'day' ? daytime : overnight;

    // Extract condition
    const conditionObj = current.weatherCondition || activeForecast.weatherCondition || {};
    const condition = conditionObj.description?.text || conditionObj.text || 'Unknown';
    const conditionCode = conditionObj.code || 0;

    // Extract temperatures
    const temperature = current.temperature?.value || activeForecast.temperature?.value || null;
    const feelsLike = current.apparentTemperature?.value || activeForecast.apparentTemperature?.value || null;
    const high = daytime.maxTemperature?.value || null;
    const low = overnight.minTemperature?.value || null;

    // Extract wind
    const wind = current.wind || activeForecast.wind || {};
    const windSpeed = wind.speed?.value || 0;
    const windDirection = wind.direction || 'Variable';
    const windGust = wind.gust?.value || null;

    // Extract precipitation
    const precip = activeForecast.precipitation || {};
    const precipProb = precip.probability || 0;
    const precipAmount = precip.amount?.value || 0;
    const precipType = precip.type || null; // 'rain', 'snow', etc.

    // Snow accumulation (if applicable)
    const snowAccum = activeForecast.snowAccumulation?.value || 0;

    // Visibility
    const visibility = current.visibility?.value || activeForecast.visibility?.value || 10;

    // Humidity
    const humidity = current.relativeHumidity || activeForecast.relativeHumidity || null;

    // UV Index
    const uvIndex = daytime.uvIndex || 0;

    // Air Quality
    const airQuality = current.airQualityIndex || null;

    // Extract any weather advisories
    let advisory = null;
    const alerts = weatherData.alerts || [];
    if (alerts.length > 0) {
      advisory = alerts.map(a => a.headline || a.event).join('; ');
    }

    // Build speakable summary for voice AI
    const speakableSummary = buildSpeakableSummary({
      condition,
      temperature,
      feelsLike,
      high,
      low,
      daypart,
      precipProb,
      precipType,
      snowAccum,
      windSpeed,
      advisory
    });

    // Format times for local timezone
    const sunriseLocal = sunrise ? formatTime(sunrise) : null;
    const sunsetLocal = sunset ? formatTime(sunset) : null;

    // Build comprehensive response
    const response = {
      ok: true,
      address: address || null,
      
      // Current conditions
      condition: condition,
      condition_code: conditionCode,
      temperature: temperature ? Math.round(temperature) : null,
      feels_like: feelsLike ? Math.round(feelsLike) : null,
      
      // Daily highs/lows
      high: high ? Math.round(high) : null,
      low: low ? Math.round(low) : null,
      
      // Time of day
      daypart: daypart,
      sunrise_local: sunriseLocal,
      sunset_local: sunsetLocal,
      
      // Wind
      wind_mph: Math.round(windSpeed),
      wind_direction: windDirection,
      wind_gust_mph: windGust ? Math.round(windGust) : null,
      
      // Precipitation
      precip_prob_pct: Math.round(precipProb * 100),
      precip_type: precipType,
      precip_amount_in: Math.round(precipAmount * 100) / 100,
      snow_accum_in: Math.round(snowAccum * 10) / 10,
      
      // Other conditions
      visibility_miles: Math.round(visibility),
      humidity_pct: humidity ? Math.round(humidity * 100) : null,
      uv_index: uvIndex,
      air_quality_index: airQuality,
      
      // Advisories
      advisory: advisory,
      
      // Voice-optimized summary
      speakable_summary: speakableSummary,
      
      // Raw data (optional, for debugging)
      _raw: process.env.NODE_ENV === 'development' ? weatherData : undefined
    };

    return res.status(200).json(response);

  } catch (err) {
    console.error('[weather] error:', err);
    return res.status(500).json({ 
      ok: false, 
      error: 'WEATHER_FETCH_FAILED', 
      message: err?.message || 'Unknown error' 
    });
  }
}

// Build a natural-sounding weather summary for voice
function buildSpeakableSummary(data) {
  const {
    condition,
    temperature,
    feelsLike,
    high,
    low,
    daypart,
    precipProb,
    precipType,
    snowAccum,
    windSpeed,
    advisory
  } = data;

  let summary = [];

  // Main condition - adjust for day/night
  let mainCondition = condition;
  if (daypart === 'night') {
    if (condition.toLowerCase().includes('sunny') || condition.toLowerCase().includes('clear')) {
      mainCondition = 'Clear night';
    } else if (condition.toLowerCase().includes('partly cloudy')) {
      mainCondition = 'Partly cloudy night';
    }
  }

  summary.push(mainCondition);

  // Temperature
  if (temperature) {
    const tempStr = `${temperature} degrees`;
    if (feelsLike && Math.abs(temperature - feelsLike) > 5) {
      summary.push(`${tempStr}, feels like ${feelsLike}`);
    } else {
      summary.push(tempStr);
    }
  }

  // Precipitation
  if (precipProb > 30) {
    if (snowAccum > 0.5) {
      summary.push(`${Math.round(precipProb)}% chance of snow, expecting ${snowAccum} inches`);
    } else if (precipType === 'snow') {
      summary.push(`${Math.round(precipProb)}% chance of snow`);
    } else if (precipType === 'rain') {
      summary.push(`${Math.round(precipProb)}% chance of rain`);
    } else {
      summary.push(`${Math.round(precipProb)}% chance of precipitation`);
    }
  }

  // Wind
  if (windSpeed > 15) {
    summary.push(`Winds ${windSpeed} mph`);
  }

  // Advisory
  if (advisory) {
    summary.push(`Advisory: ${advisory}`);
  }

  return summary.join('. ') + '.';
}

// Format time to local 12-hour format
function formatTime(date) {
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const ampm = hours >= 12 ? 'PM' : 'AM';
  const displayHours = hours % 12 || 12;
  const displayMinutes = minutes.toString().padStart(2, '0');
  return `${displayHours}:${displayMinutes} ${ampm}`;
}