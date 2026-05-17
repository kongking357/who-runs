'use client';
import { useEffect, useRef, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';

export type TrackPoint = { lat: number; lng: number; ts: number };

function haversineKm(a: TrackPoint, b: TrackPoint) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const sin2 =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) *
      Math.cos((b.lat * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(sin2));
}

export function useRunTracker(userId: string, teamId: string | null, username: string) {
  const [isRunning, setIsRunning] = useState(false);
  const [position, setPosition] = useState<{ lat: number; lng: number } | null>(null);
  const [track, setTrack] = useState<TrackPoint[]>([]);
  const [distanceKm, setDistanceKm] = useState(0);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [paceSec, setPaceSec] = useState(0);

  const watchRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef<number>(0);
  const lastTrackRef = useRef<TrackPoint[]>([]);
  const lastDistRef = useRef(0);

  // Always watch position (even when not running) so map shows user location
  useEffect(() => {
    if (!navigator.geolocation) return;
    const id = navigator.geolocation.watchPosition(
      (pos) => {
        const pt = { lat: pos.coords.latitude, lng: pos.coords.longitude, ts: Date.now() };
        setPosition({ lat: pt.lat, lng: pt.lng });

        if (isRunning) {
          setTrack((prev) => {
            const next = [...prev, pt];
            lastTrackRef.current = next;

            // Accumulate distance
            if (prev.length > 0) {
              const added = haversineKm(prev[prev.length - 1], pt);
              if (added < 0.05) { // ignore GPS jumps > 50m/update
                lastDistRef.current += added;
                setDistanceKm(lastDistRef.current);
              }
            }
            return next;
          });
        }
      },
      (err) => console.warn('GPS error:', err),
      { enableHighAccuracy: true, maximumAge: 3000, timeout: 10000 }
    );
    watchRef.current = id;
    return () => navigator.geolocation.clearWatch(id);
  }, [isRunning]);

  // Elapsed timer
  useEffect(() => {
    if (isRunning) {
      startTimeRef.current = Date.now() - elapsedSec * 1000;
      timerRef.current = setInterval(() => {
        const sec = Math.floor((Date.now() - startTimeRef.current) / 1000);
        setElapsedSec(sec);
        // pace = sec / km
        if (lastDistRef.current > 0.05) {
          setPaceSec(Math.round(sec / lastDistRef.current));
        }
      }, 1000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [isRunning]);

  // Supabase sync every 5 seconds when running
  useEffect(() => {
    if (!isRunning || !position) return;
    const syncInterval = setInterval(async () => {
      await supabase.from('runner_locations').upsert({
        user_id: userId,
        team_id: teamId,
        username,
        latitude: position.lat,
        longitude: position.lng,
        distance_km: lastDistRef.current,
        pace_sec_per_km: paceSec,
        elapsed_sec: elapsedSec,
        is_running: true,
        updated_at: new Date().toISOString(),
      });
    }, 5000);
    return () => clearInterval(syncInterval);
  }, [isRunning, position, userId, teamId, username, paceSec, elapsedSec]);

  const startRun = useCallback(() => {
    lastDistRef.current = 0;
    setDistanceKm(0);
    setElapsedSec(0);
    setPaceSec(0);
    setTrack([]);
    lastTrackRef.current = [];
    setIsRunning(true);
  }, []);

  const stopRun = useCallback(async () => {
    setIsRunning(false);
    // Mark as not running in DB
    await supabase.from('runner_locations').upsert({
      user_id: userId,
      team_id: teamId,
      username,
      latitude: position?.lat ?? 0,
      longitude: position?.lng ?? 0,
      distance_km: lastDistRef.current,
      pace_sec_per_km: paceSec,
      elapsed_sec: elapsedSec,
      is_running: false,
      updated_at: new Date().toISOString(),
    });
  }, [userId, teamId, username, position, paceSec, elapsedSec]);

  return { isRunning, position, track, distanceKm, elapsedSec, paceSec, startRun, stopRun };
}

export function formatTime(sec: number) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function formatPace(secPerKm: number) {
  if (!secPerKm || secPerKm > 1800) return '--:--';
  const m = Math.floor(secPerKm / 60);
  const s = secPerKm % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
