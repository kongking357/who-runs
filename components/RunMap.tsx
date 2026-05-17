'use client'

import { useEffect, useRef } from 'react'
import type { Map, Marker, Polyline } from 'leaflet'
import type { GPSPoint } from '@/lib/gps'

interface TeamRunner {
  user_id: string
  display_name: string | null
  latitude: number
  longitude: number
}

interface RunMapProps {
  center: [number, number]
  myPosition: GPSPoint | null
  route: GPSPoint[]
  teamRunners: TeamRunner[]
  zoom?: number
  followUser?: boolean
}

export default function RunMap({
  center,
  myPosition,
  route,
  teamRunners,
  zoom = 16,
  followUser = false,
}: RunMapProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<Map | null>(null)
  const myMarkerRef = useRef<Marker | null>(null)
  const routeLineRef = useRef<Polyline | null>(null)
  const teamMarkersRef = useRef<globalThis.Map<string, Marker>>(new globalThis.Map())

  // Initialize map once
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

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      maxZoom: 19,
    }).addTo(map)

    mapRef.current = map

    return () => {
      map.remove()
      mapRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Update my marker
  useEffect(() => {
    if (!mapRef.current || !myPosition) return
    const L = require('leaflet')

    const icon = L.divIcon({
      className: '',
      html: `<div style="
        width:16px;height:16px;border-radius:50%;
        background:#ff5a67;
        box-shadow:0 0 16px rgba(255,90,103,0.8);
        border:2px solid rgba(255,255,255,0.6);
      "></div>`,
      iconSize: [16, 16],
      iconAnchor: [8, 8],
    })

    if (myMarkerRef.current) {
      myMarkerRef.current.setLatLng([myPosition.lat, myPosition.lng])
    } else {
      myMarkerRef.current = L.marker([myPosition.lat, myPosition.lng], { icon }).addTo(mapRef.current)
    }

    if (followUser) {
      mapRef.current.setView([myPosition.lat, myPosition.lng], mapRef.current.getZoom())
    }
  }, [myPosition, followUser])

  // Draw route
  useEffect(() => {
    if (!mapRef.current || route.length < 2) return
    const L = require('leaflet')

    const coords = route.map((p) => [p.lat, p.lng] as [number, number])

    if (routeLineRef.current) {
      routeLineRef.current.setLatLngs(coords)
    } else {
      routeLineRef.current = L.polyline(coords, {
        color: '#00d8ff',
        weight: 3,
        opacity: 0.85,
      }).addTo(mapRef.current)
    }
  }, [route])

  // Update team markers
  useEffect(() => {
    if (!mapRef.current) return
    const L = require('leaflet')
    const markers = teamMarkersRef.current as unknown as globalThis.Map<string, Marker>

    const teamIcon = L.divIcon({
      className: '',
      html: `<div style="
        width:12px;height:12px;border-radius:50%;
        background:#00d8ff;
        box-shadow:0 0 10px rgba(0,216,255,0.6);
      "></div>`,
      iconSize: [12, 12],
      iconAnchor: [6, 6],
    })

    // Add / update markers
    teamRunners.forEach((runner) => {
      if (markers.has(runner.user_id)) {
        markers.get(runner.user_id)!.setLatLng([runner.latitude, runner.longitude])
      } else {
        const m = L.marker([runner.latitude, runner.longitude], { icon: teamIcon })
          .bindTooltip(runner.display_name || runner.user_id, { permanent: false })
          .addTo(mapRef.current!)
        markers.set(runner.user_id, m)
      }
    })

    // Remove stale markers
    const activeIds = new Set(teamRunners.map((r) => r.user_id))
    markers.forEach((marker, id) => {
      if (!activeIds.has(id)) {
        marker.remove()
        markers.delete(id)
      }
    })
  }, [teamRunners])

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: '100%',
        filter: 'brightness(0.72) contrast(1.08) saturate(0.9)',
      }}
    />
  )
}
