// Utility functions

export function parseTime(timeStr) {
  if (!timeStr) return new Date();
  
  // Handle ISO strings
  if (timeStr.includes('T') || timeStr.includes('Z')) {
    return new Date(timeStr);
  }
  
  // Handle "now"
  if (timeStr.toLowerCase() === 'now') {
    return new Date();
  }
  
  // Handle "HH:MM" format
  const match = timeStr.match(/(\d{1,2}):(\d{2})/);
  if (match) {
    const now = new Date();
    now.setHours(parseInt(match[1]), parseInt(match[2]), 0, 0);
    return now;
  }
  
  return new Date();
}

export function isWithinTimeWindow(time, restrictions) {
  const hour = time.getHours();
  const minute = time.getMinutes();
  const timeMinutes = hour * 60 + minute;
  
  const [startHour, startMin] = restrictions.start.split(':').map(Number);
  const startMinutes = startHour * 60 + startMin;
  
  const [endHour, endMin] = restrictions.end.split(':').map(Number);
  let endMinutes = endHour * 60 + endMin;
  
  // Handle midnight (00:00)
  if (endMinutes === 0) endMinutes = 24 * 60;
  
  return timeMinutes >= startMinutes && timeMinutes <= endMinutes;
}

export function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    }
  });
}