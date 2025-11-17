// Google Maps API utilities

export async function geocodeAddress(address, apiKey) {
  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
  url.searchParams.set('address', address);
  url.searchParams.set('key', apiKey);

  const response = await fetch(url.toString());
  const data = await response.json();

  if (data.status !== 'OK' || !data.results || data.results.length === 0) {
    return null;
  }

  const result = data.results[0];
  return {
    formatted_address: result.formatted_address,
    lat: result.geometry.location.lat,
    lng: result.geometry.location.lng,
    place_id: result.place_id
  };
}

export async function reverseGeocode(lat, lng, apiKey) {
  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
  url.searchParams.set('latlng', `${lat},${lng}`);
  url.searchParams.set('key', apiKey);

  const response = await fetch(url.toString());
  const data = await response.json();

  if (data.status !== 'OK' || !data.results || data.results.length === 0) {
    return null;
  }

  return data.results[0].formatted_address;
}