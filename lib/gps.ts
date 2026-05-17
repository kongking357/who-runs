// GPS utilities for run tracking

export type GPSPoint = { lat: number; lng: number; timestamp: number }

// Haversine formula — distance between two GPS points in km
export function distanceKm(a: GPSPoint, b: GPSPoint): number {
  const R = 6371
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const sinLat = Math.sin(dLat / 2)
  const sinLng = Math.sin(dLng / 2)
  const chord =
    sinLat * sinLat +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinLng * sinLng
  return R * 2 * Math.atan2(Math.sqrt(chord), Math.sqrt(1 - chord))
}

function toRad(deg: number) {
  return (deg * Math.PI) / 180
}

// Rough square meters covered by a polyline (buffer ~10m on each side)
export function estimateSqm(points: GPSPoint[]): number {
  if (points.length < 2) return 0
  let total = 0
  for (let i = 1; i < points.length; i++) {
    total += distanceKm(points[i - 1], points[i])
  }
  return Math.round(total * 1000 * 20) // 20m wide corridor
}

export function formatPace(paceSecondsPerKm: number): string {
  if (!isFinite(paceSecondsPerKm) || paceSecondsPerKm <= 0) return '--:--'
  const m = Math.floor(paceSecondsPerKm / 60)
  const s = Math.floor(paceSecondsPerKm % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

export function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
}
