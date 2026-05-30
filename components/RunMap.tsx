'use client'

import { useEffect, useRef } from 'react'
import type { Map, Marker, Polyline, Polygon } from 'leaflet'
import type { GPSPoint } from '@/lib/gps'

interface TeamRunner {
  user_id: string
  display_name: string | null
  latitude: number
  longitude: number
}

interface ClosedPolygon {
  points: GPSPoint[]
  sqm: number
}

interface RunMapProps {
  center: [number, number]
  myPosition: GPSPoint | null
  route: GPSPoint[]
  teamRunners: TeamRunner[]
  zoom?: number
  followUser?: boolean
  closedPolygons: ClosedPolygon[]
  loopFlash?: boolean
}

export default function RunMap({
  center,
  myPosition,
  route,
  teamRunners,
  zoom = 16,
  followUser = false,
  closedPolygons,
  loopFlash = false,
}: RunMapProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<Map | null>(null)
  const myMarkerRef = useRef<Marker | null>(null)
  const routeGlowRef = useRef<Polyline | null>(null)
  const routeLineRef = useRef<Polyline | null>(null)
  const teamMarkersRef = useRef<globalThis.Map<string, Marker>>(new globalThis.Map())
  const polygonLayersRef = useRef<Polygon[]>([])

  // Init map once
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return
    const L = require('leaflet')

    const map = L.map(containerRef.current, {
      zoomControl: false,
      attributionControl: false,
      dragging: true,
      scrollWheelZoom: false,
      doubleClickZoom: false,
    }).setView(center, zoom)

    // Light map tile
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      maxZoom: 19,
    }).addTo(map)

    mapRef.current = map
    return () => { map.remove(); mapRef.current = null }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Follow user / re-center
  useEffect(() => {
    if (!mapRef.current || !myPosition) return
    if (followUser) mapRef.current.setView([myPosition.lat, myPosition.lng], mapRef.current.getZoom())
  }, [myPosition, followUser])

  // My marker
  useEffect(() => {
    if (!mapRef.current || !myPosition) return
    const L = require('leaflet')

    const icon = L.divIcon({
      className: '',
      html: `<div style="
        width:14px;height:14px;border-radius:50%;
        background:#ff4455;
        box-shadow:0 0 12px rgba(255,68,85,0.75);
        border:2px solid rgba(255,255,255,0.9);
      "></div>`,
      iconSize: [14, 14],
      iconAnchor: [7, 7],
    })

    if (myMarkerRef.current) {
      myMarkerRef.current.setLatLng([myPosition.lat, myPosition.lng])
    } else {
      myMarkerRef.current = L.marker([myPosition.lat, myPosition.lng], { icon }).addTo(mapRef.current)
    }
  }, [myPosition])

  // Route line
  useEffect(() => {
    if (!mapRef.current) return
    const L = require('leaflet')
    if (route.length < 2) {
      if (routeGlowRef.current) { routeGlowRef.current.remove(); routeGlowRef.current = null }
      if (routeLineRef.current) { routeLineRef.current.remove(); routeLineRef.current = null }
      return
    }
    const coords = route.map((p) => [p.lat, p.lng] as [number, number])
    if (routeGlowRef.current) {
      routeGlowRef.current.setLatLngs(coords)
    } else {
      routeGlowRef.current = L.polyline(coords, {
        color: '#00bff5',
        weight: 18,
        opacity: 0.72,
        lineCap: 'round',
        lineJoin: 'round',
        className: 'run-route-glow',
      }).addTo(mapRef.current)
    }
    if (routeLineRef.current) {
      routeLineRef.current.setLatLngs(coords)
    } else {
      routeLineRef.current = L.polyline(coords, {
        color: '#14d9ff',
        weight: 4.5,
        opacity: 1,
        lineCap: 'round',
        lineJoin: 'round',
        className: 'run-route-core',
      }).addTo(mapRef.current)
    }
  }, [route])

  // Closed polygons — draw filled area with flash animation
  useEffect(() => {
    if (!mapRef.current) return
    const L = require('leaflet')

    // Remove old polygon layers
    polygonLayersRef.current.forEach((p) => p.remove())
    polygonLayersRef.current = []

    closedPolygons.forEach(({ points }) => {
      const coords = points.map((p) => [p.lat, p.lng] as [number, number])
      const poly = L.polygon(coords, {
        color: '#14d9ff',
        weight: 4,
        opacity: 1,
        fillColor: '#00bff5',
        fillOpacity: loopFlash ? 0.2 : 0.1,
        lineCap: 'round',
        lineJoin: 'round',
        className: 'run-polygon-glow',
      }).addTo(mapRef.current!)
      polygonLayersRef.current.push(poly)
    })
  }, [closedPolygons, loopFlash])

  // Team markers
  useEffect(() => {
    if (!mapRef.current) return
    const L = require('leaflet')
    const markers = teamMarkersRef.current

    const icon = L.divIcon({
      className: '',
      html: `<div style="width:10px;height:10px;border-radius:50%;background:#00c8f0;box-shadow:0 0 8px rgba(0,200,240,0.6);"></div>`,
      iconSize: [10, 10], iconAnchor: [5, 5],
    })

    teamRunners.forEach((r) => {
      if (markers.has(r.user_id)) {
        markers.get(r.user_id)!.setLatLng([r.latitude, r.longitude])
      } else {
        const m = L.marker([r.latitude, r.longitude], { icon })
          .bindTooltip(r.display_name || r.user_id, { permanent: false })
          .addTo(mapRef.current!)
        markers.set(r.user_id, m)
      }
    })

    const active = new Set(teamRunners.map((r) => r.user_id))
    markers.forEach((m, id) => { if (!active.has(id)) { m.remove(); markers.delete(id) } })
  }, [teamRunners])

  return (
    <>
      <div
        ref={containerRef}
        style={{ width: "100%", height: "100%", position: "relative", zIndex: 0 }}
      />
      <style jsx global>{`
        .run-route-glow {
          animation: runRouteGlowPulse 1.45s ease-in-out infinite;
          filter:
            drop-shadow(0 0 6px rgba(20, 217, 255, .95))
            drop-shadow(0 0 18px rgba(0, 191, 245, .8))
            drop-shadow(0 0 42px rgba(0, 160, 240, .55));
          stroke: #00bff5;
          stroke-linecap: round;
          stroke-linejoin: round;
        }
        .run-route-core {
          animation: runRouteCorePulse 1.45s ease-in-out infinite;
          filter:
            drop-shadow(0 0 4px rgba(255, 255, 255, .85))
            drop-shadow(0 0 12px rgba(20, 217, 255, 1))
            drop-shadow(0 0 26px rgba(0, 191, 245, .9));
          stroke: #14d9ff;
          stroke-linecap: round;
          stroke-linejoin: round;
        }
        .run-polygon-glow {
          animation: runRouteCorePulse 1.45s ease-in-out infinite;
          filter:
            drop-shadow(0 0 8px rgba(20, 217, 255, .95))
            drop-shadow(0 0 22px rgba(0, 191, 245, .75))
            drop-shadow(0 0 46px rgba(0, 160, 240, .45));
          stroke-linecap: round;
          stroke-linejoin: round;
        }
        @keyframes runRouteGlowPulse {
          0%, 100% {
            opacity: .46;
          }
          50% {
            opacity: .9;
          }
        }
        @keyframes runRouteCorePulse {
          0%, 100% { opacity: .86; }
          50% { opacity: 1; }
        }
      `}</style>
    </>
  )
}
