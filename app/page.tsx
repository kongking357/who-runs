'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import dynamic from 'next/dynamic'
import { supabase } from '@/lib/supabase'
import { distanceKm, formatPace, formatTime, GPSPoint } from '@/lib/gps'

const RunMap = dynamic(() => import('@/components/RunMap'), { ssr: false })

type Screen = 'idle' | 'running' | 'post' | 'history'

interface RunStats {
  distanceKm: number
  durationSec: number
  pace: number
  sqm: number
}

interface SavedRun {
  id: string
  started_at: string
  ended_at?: string
  distance_km: number
  duration_seconds: number
  pace_per_km: number
  sqm_covered: number
  route?: [number, number][]
  location_name?: string
}

interface TeamRunner {
  user_id: string
  display_name: string | null
  latitude: number
  longitude: number
  updated_at: string
}

// ── Auth helpers ──────────────────────────────────────────────────────────────

function getUserId(session: any): string {
  if (session?.user?.id) return session.user.id
  if (typeof window === 'undefined') return 'anon'
  let id = localStorage.getItem('whoRuns_userId')
  if (!id) { id = 'runner_' + Math.random().toString(36).slice(2, 10); localStorage.setItem('whoRuns_userId', id) }
  return id
}

function getDisplayName(session: any): string {
  if (session?.user) {
    return session.user.user_metadata?.full_name || session.user.user_metadata?.name || session.user.email?.split('@')[0] || 'Runner'
  }
  if (typeof window === 'undefined') return 'Runner'
  let name = localStorage.getItem('whoRuns_displayName')
  if (!name) {
    const adj = ['Fast', 'Swift', 'Bold', 'Iron', 'Neon', 'Wild', 'Dark', 'Storm']
    const noun = ['Stride', 'Pace', 'Dash', 'Bolt', 'Runner', 'Track', 'Miles', 'Route']
    name = adj[Math.floor(Math.random() * adj.length)] + noun[Math.floor(Math.random() * noun.length)]
    localStorage.setItem('whoRuns_displayName', name)
  }
  return name
}

// ── Geo helpers ───────────────────────────────────────────────────────────────

const CLOSE_THRESHOLD_M = 50

function computeClosedArea(points: GPSPoint[]): { sqm: number; closed: boolean } {
  if (points.length < 6) return { sqm: 0, closed: false }
  const first = points[0], last = points[points.length - 1]
  if (distanceKm(first, last) * 1000 > CLOSE_THRESHOLD_M) return { sqm: 0, closed: false }
  const avgLat = points.reduce((s, p) => s + p.lat, 0) / points.length
  const mLat = 111320, mLng = 111320 * Math.cos((avgLat * Math.PI) / 180)
  let area = 0
  for (let i = 0; i < points.length; i++) {
    const j = (i + 1) % points.length
    area += points[i].lng * mLng * points[j].lat * mLat
    area -= points[j].lng * mLng * points[i].lat * mLat
  }
  return { sqm: Math.round(Math.abs(area) / 2), closed: true }
}

function routeCenter(route: [number, number][]): [number, number] {
  if (!route.length) return [0, 0]
  return [route.reduce((s, p) => s + p[0], 0) / route.length, route.reduce((s, p) => s + p[1], 0) / route.length]
}

async function reverseGeocode(lat: number, lng: number): Promise<string> {
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`)
    const data = await res.json()
    return data.address?.city || data.address?.town || data.address?.village || data.address?.suburb || data.address?.county || 'Unknown'
  } catch {
    return 'Unknown'
  }
}

function runLabel(locationName: string | undefined, startedAt: string): string {
  const d = new Date(startedAt)
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const city = locationName && locationName !== 'Unknown' ? locationName : 'Run'
  return `${city} Run//${dd}-${mm}`
}

// ─────────────────────────────────────────────────────────────────────────────

export default function App() {
  const [screen, setScreen] = useState<Screen>('idle')
  const [activeTab, setActiveTab] = useState<'me' | 'team' | 'history'>('me')

  // Auth
  const [session, setSession] = useState<any>(null)
  const [authReady, setAuthReady] = useState(false)
  const [showAuth, setShowAuth] = useState(false)

  const userId = getUserId(session)
  const displayName = getDisplayName(session)

  const [position, setPosition] = useState<GPSPoint | null>(null)
  const [gpsError, setGpsError] = useState<string | null>(null)
  const [route, setRoute] = useState<GPSPoint[]>([])
  const [closedPolygons, setClosedPolygons] = useState<{ points: GPSPoint[]; sqm: number }[]>([])
  const [loopJustClosed, setLoopJustClosed] = useState(false)

  const [elapsed, setElapsed] = useState(0)
  const [stats, setStats] = useState<RunStats>({ distanceKm: 0, durationSec: 0, pace: 0, sqm: 0 })
  const [finalStats, setFinalStats] = useState<RunStats | null>(null)
  const [savedRuns, setSavedRuns] = useState<SavedRun[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [selectedRun, setSelectedRun] = useState<SavedRun | null>(null)

  const isRunningRef = useRef(false)
  const startTimeRef = useRef<number | null>(null)
  const routeRef = useRef<GPSPoint[]>([])
  const totalSqmRef = useRef(0)
  const totalDistKmRef = useRef(0)
  const lastClosedRef = useRef(false)
  const timerRef = useRef<NodeJS.Timeout | null>(null)
  const watchIdRef = useRef<number | null>(null)
  const fullRouteRef = useRef<GPSPoint[]>([])
  const closedPolygonsRef = useRef<{ points: GPSPoint[]; sqm: number }[]>([])
  const locationNameRef = useRef<string>('Unknown')

  const [teamRunners, setTeamRunners] = useState<TeamRunner[]>([])

  // Auth init
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setAuthReady(true) })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => subscription.unsubscribe()
  }, [])

  // GPS watch
  useEffect(() => {
    if (!navigator.geolocation) { setGpsError('GPS not available'); return }
    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const pt: GPSPoint = { lat: pos.coords.latitude, lng: pos.coords.longitude, timestamp: Date.now() }
        setPosition(pt)
        setGpsError(null)
        if (!isRunningRef.current) return

        const activeUpdated = [...routeRef.current, pt]
        routeRef.current = activeUpdated

        const previousFullPoint = fullRouteRef.current[fullRouteRef.current.length - 1]
        if (previousFullPoint) totalDistKmRef.current += distanceKm(previousFullPoint, pt)
        const fullUpdated = [...fullRouteRef.current, pt]
        fullRouteRef.current = fullUpdated

        const totalKm = totalDistKmRef.current
        const durSec = startTimeRef.current ? (Date.now() - startTimeRef.current) / 1000 : 0
        const pace = totalKm > 0.01 ? durSec / totalKm : 0

        const { sqm, closed } = computeClosedArea(activeUpdated)
        if (closed && !lastClosedRef.current) {
          lastClosedRef.current = true
          const newPolygon = { points: [...activeUpdated], sqm }
          closedPolygonsRef.current = [...closedPolygonsRef.current, newPolygon]
          setClosedPolygons(closedPolygonsRef.current)
          const newTotal = totalSqmRef.current + sqm
          totalSqmRef.current = newTotal
          setLoopJustClosed(true)
          setTimeout(() => setLoopJustClosed(false), 1800)
          routeRef.current = [pt]
          setRoute(fullUpdated)
          setStats({ distanceKm: totalKm, durationSec: durSec, pace, sqm: newTotal })
          return
        }
        if (!closed) lastClosedRef.current = false
        setRoute(fullUpdated)
        setStats({ distanceKm: totalKm, durationSec: durSec, pace, sqm: totalSqmRef.current })

        supabase.from('runner_locations').upsert({
          user_id: userId, team_id: null, display_name: displayName,
          latitude: pt.lat, longitude: pt.lng, updated_at: new Date().toISOString(),
        })
      },
      (err) => setGpsError(`GPS: ${err.message}`),
      { enableHighAccuracy: true, maximumAge: 3000, timeout: 15000 }
    )
    return () => { if (watchIdRef.current !== null) navigator.geolocation.clearWatch(watchIdRef.current) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, displayName])

  // Timer
  useEffect(() => {
    if (screen === 'running') {
      timerRef.current = setInterval(() => {
        setElapsed(startTimeRef.current ? Math.floor((Date.now() - startTimeRef.current) / 1000) : 0)
      }, 1000)
    } else {
      if (timerRef.current) clearInterval(timerRef.current)
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [screen])

  // Realtime team
  useEffect(() => {
    const ch = supabase.channel('runner-locations')
      .on('postgres_changes' as any, { event: '*', schema: 'public', table: 'runner_locations' }, (payload: any) => {
        const r = payload.new as TeamRunner
        setTeamRunners((prev) => {
          const f = prev.filter((x) => x.user_id !== r.user_id)
          return payload.eventType === 'DELETE' ? f : [...f, r]
        })
      }).subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [])

  const startRun = useCallback(() => {
    routeRef.current = []
    fullRouteRef.current = []
    closedPolygonsRef.current = []
    totalSqmRef.current = 0
    totalDistKmRef.current = 0
    lastClosedRef.current = false
    locationNameRef.current = 'Unknown'
    startTimeRef.current = Date.now()
    isRunningRef.current = true
    setRoute([])
    setClosedPolygons([])
    setElapsed(0)
    setStats({ distanceKm: 0, durationSec: 0, pace: 0, sqm: 0 })
    setScreen('running')
    // Reverse geocode start position
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition((pos) => {
        reverseGeocode(pos.coords.latitude, pos.coords.longitude).then((name) => {
          locationNameRef.current = name
        })
      })
    }
  }, [])

  const stopRun = useCallback(() => {
    isRunningRef.current = false
    const durSec = startTimeRef.current ? (Date.now() - startTimeRef.current) / 1000 : 0
    const distKm = totalDistKmRef.current
    const sqm = totalSqmRef.current
    const pace = distKm > 0.01 ? durSec / distKm : 0
    setFinalStats({ distanceKm: distKm, durationSec: durSec, pace, sqm })
    setScreen('post')
  }, [])

  const confirmSave = useCallback(async () => {
    const s = finalStats
    const start = startTimeRef.current
    if (s && start) {
      const { error } = await supabase.from('run_sessions').insert({
        user_id: userId, team_id: null,
        distance_km: s.distanceKm,
        duration_seconds: Math.round(s.durationSec),
        pace_per_km: s.pace,
        sqm_covered: s.sqm,
        location_name: locationNameRef.current,
        started_at: new Date(start).toISOString(),
        ended_at: new Date().toISOString(),
        route: fullRouteRef.current.map((p) => [p.lat, p.lng]),
      })
      if (error) console.error('Save error:', error)
    }
    await supabase.from('runner_locations').delete().eq('user_id', userId)
    setScreen('idle')
    setActiveTab('me')
    setStats({ distanceKm: 0, durationSec: 0, pace: 0, sqm: 0 })
    setElapsed(0)
  }, [finalStats, userId])

  const discardRun = useCallback(async () => {
    await supabase.from('runner_locations').delete().eq('user_id', userId)
    setScreen('idle')
    setActiveTab('me')
    setStats({ distanceKm: 0, durationSec: 0, pace: 0, sqm: 0 })
    setElapsed(0)
  }, [userId])

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true)
    const { data } = await supabase
      .from('run_sessions')
      .select('id, started_at, ended_at, distance_km, duration_seconds, pace_per_km, sqm_covered, route, location_name')
      .eq('user_id', userId)
      .order('started_at', { ascending: false })
      .limit(50)
    setSavedRuns((data as SavedRun[]) || [])
    setHistoryLoading(false)
  }, [userId])

  const handleTabChange = useCallback((t: 'me' | 'team' | 'history') => {
    setActiveTab(t)
    if (t === 'history') loadHistory()
  }, [loadHistory])

  const mapCenter: [number, number] | null = position ? [position.lat, position.lng] : null
  if (!authReady) return null

  return (
    <div className="shell">
      {gpsError && <div className="gps-err">⚠ {gpsError}</div>}

      {/* AUTH MODAL */}
      {showAuth && (
        <AuthModal
          onClose={() => setShowAuth(false)}
          onDone={() => setShowAuth(false)}
        />
      )}

      {/* IDLE */}
      {screen === 'idle' && activeTab === 'me' && (
        <div className="screen">
          <div className="map-fill">
            {mapCenter ? <RunMap center={mapCenter} myPosition={position} route={[]} teamRunners={[]} zoom={16} followUser closedPolygons={[]} /> : <Acquiring />}
          </div>
          <TopBar>
            <Stat label="KM" value="—" />
            <Stat label="PACE" value="—" />
            <Stat label="TIME" value="—" />
            <Stat label="SQM" value="—" />
          </TopBar>
          {/* User badge */}
          <div className="user-badge" onClick={() => setShowAuth(true)}>
            {session ? (
              <><span className="ub-dot on" /><span className="ub-name">{displayName}</span></>
            ) : (
              <><span className="ub-dot" /><span className="ub-name">SIGN IN</span></>
            )}
          </div>
          <StartButton onStart={startRun} hasGps={!!position} />
          <BottomBar activeTab={activeTab} onTabChange={handleTabChange} />
        </div>
      )}

      {/* RUNNING */}
      {screen === 'running' && (
        <div className="screen">
          <div className="map-fill">
            {mapCenter && <RunMap center={mapCenter} myPosition={position} route={route} teamRunners={[]} zoom={17} followUser closedPolygons={closedPolygons} loopFlash={loopJustClosed} />}
          </div>
          <TopBar>
            <Stat label="KM" value={stats.distanceKm > 0 ? stats.distanceKm.toFixed(2) : '0.00'} accent />
            <Stat label="PACE" value={formatPace(stats.pace)} />
            <Stat label="TIME" value={formatTime(elapsed)} />
            <Stat label="SQM" value={stats.sqm > 0 ? (stats.sqm >= 1000 ? `${(stats.sqm / 1000).toFixed(1)}k` : String(stats.sqm)) : '—'} />
          </TopBar>
          <div className="elapsed">{formatTime(elapsed)}</div>
          <div className="stop-wrap">
            <button className="stop-btn" onClick={stopRun}><div className="stop-sq" /></button>
          </div>
        </div>
      )}

      {/* POST — original WHO RUNS summary */}
      {screen === 'post' && finalStats && (
        <div className="screen">
          <div className="map-fill">
            {mapCenter && <RunMap center={mapCenter} myPosition={position} route={route} teamRunners={[]} zoom={15} closedPolygons={closedPolygons} />}
          </div>
          <PostScreen stats={finalStats} onConfirm={confirmSave} onDiscard={discardRun} />
        </div>
      )}

      {/* TEAM */}
      {activeTab === 'team' && screen !== 'running' && screen !== 'post' && (
        <div className="screen">
          <div className="map-fill">
            {mapCenter ? <RunMap center={mapCenter} myPosition={position} route={[]} teamRunners={teamRunners} zoom={15} closedPolygons={[]} /> : <Acquiring />}
          </div>
          <TopBar>
            <Stat label="ONLINE" value={String(teamRunners.length)} accent />
            <Stat label="AREA" value="BRC" />
            <Stat label="SQM" value={(teamRunners.length * 52000).toLocaleString()} />
            <Stat label="RANK" value="#1" />
          </TopBar>
          <div className="team-sheet">
            <p className="sheet-label">LIVE RUNNERS</p>
            {teamRunners.length === 0
              ? <p className="sheet-empty">No runners active</p>
              : teamRunners.map((r) => (
                <div key={r.user_id} className="runner-row">
                  <span className="rdot" />
                  <span className="rname">{r.display_name || r.user_id.slice(0, 10)}</span>
                  <span className="rtime">{Math.round((Date.now() - new Date(r.updated_at).getTime()) / 1000)}s ago</span>
                </div>
              ))}
          </div>
          <BottomBar activeTab={activeTab} onTabChange={handleTabChange} />
        </div>
      )}

      {/* HISTORY LIST */}
      {activeTab === 'history' && screen !== 'running' && screen !== 'post' && !selectedRun && (
        <div className="screen">
          <TopBar>
            <Stat label="RUNS" value={String(savedRuns.length)} accent />
            <Stat label="TOTAL KM" value={savedRuns.reduce((s, r) => s + r.distance_km, 0).toFixed(1)} />
            <Stat label="TOTAL SQM" value={(() => { const t = savedRuns.reduce((s, r) => s + (r.sqm_covered || 0), 0); return t >= 1000 ? `${(t / 1000).toFixed(1)}k` : String(t) })()} />
            <Stat label="AVG PACE" value={(() => { const runs = savedRuns.filter(r => r.pace_per_km > 0); if (!runs.length) return '—'; return formatPace(runs.reduce((s, r) => s + r.pace_per_km, 0) / runs.length) })()} />
          </TopBar>
          <div className="history-list">
            {historyLoading && <p className="sheet-empty loading">Loading…</p>}
            {!historyLoading && savedRuns.length === 0 && (
              <div className="history-empty">
                <div className="empty-icon">◎</div>
                <p>No runs saved yet</p>
                <p className="empty-sub">Complete a run and press SAVE to see it here</p>
              </div>
            )}
            {savedRuns.map((run) => (
              <button key={run.id} className="history-row" onClick={() => setSelectedRun(run)}>
                <div className="hrow-top">
                  <span className="hrun-label">{runLabel(run.location_name, run.started_at)}</span>
                  <span className="hchevron">›</span>
                </div>
                <div className="hrow-stats">
                  <span className="hstat"><span className="hval">{run.distance_km.toFixed(2)}</span><span className="hunit">km</span></span>
                  <span className="hdiv" />
                  <span className="hstat"><span className="hval">{formatTime(run.duration_seconds)}</span><span className="hunit">time</span></span>
                  <span className="hdiv" />
                  <span className="hstat"><span className="hval">{formatPace(run.pace_per_km)}</span><span className="hunit">/km</span></span>
                  {run.sqm_covered > 0 && (<>
                    <span className="hdiv" />
                    <span className="hstat accent"><span className="hval">{run.sqm_covered >= 1000 ? `${(run.sqm_covered / 1000).toFixed(1)}k` : String(Math.round(run.sqm_covered))}</span><span className="hunit">sqm</span></span>
                  </>)}
                </div>
              </button>
            ))}
          </div>
          <BottomBar activeTab={activeTab} onTabChange={handleTabChange} />
        </div>
      )}

      {/* HISTORY DETAIL */}
      {activeTab === 'history' && selectedRun && (
        <div className="screen">
          <RunSummary
            stats={{ distanceKm: selectedRun.distance_km, durationSec: selectedRun.duration_seconds, pace: selectedRun.pace_per_km, sqm: selectedRun.sqm_covered }}
            route={selectedRun.route || []}
            label={runLabel(selectedRun.location_name, selectedRun.started_at)}
            date={selectedRun.started_at}
            onBack={() => setSelectedRun(null)}
          />
        </div>
      )}

      <style jsx>{`
        .shell { position:fixed; inset:0; background:var(--bg); isolation:isolate; }
        .screen { position:relative; width:100%; height:100%; overflow:hidden; }
        .map-fill { position:absolute; inset:0; z-index:0; }
        .gps-err {
          position:fixed; top:0; left:0; right:0; z-index:999;
          background:var(--red); color:#fff; text-align:center;
          padding:5px 12px; font-size:11px; letter-spacing:.12em;
        }
        .elapsed {
          position:absolute; left:50%; top:42%; transform:translate(-50%,-50%);
          font-size:48px; font-weight:300; letter-spacing:.06em;
          color:var(--text); z-index:10; pointer-events:none;
        }
        .stop-wrap { position:absolute; bottom:40px; left:50%; transform:translateX(-50%); z-index:10; }
        .stop-btn {
          width:64px; height:64px; border-radius:50%;
          border:1px solid rgba(255,68,85,.5); background:rgba(255,68,85,.08);
          display:flex; align-items:center; justify-content:center; cursor:pointer; transition:.15s;
        }
        .stop-btn:active { transform:scale(.93); background:rgba(255,68,85,.18); }
        .stop-sq { width:22px; height:22px; background:var(--red); border-radius:3px; box-shadow:0 0 14px rgba(255,68,85,.5); }
        /* User badge */
        .user-badge {
          position:absolute; bottom:70px; right:18px; z-index:10;
          display:flex; align-items:center; gap:6px;
          background:var(--panel); border:1px solid var(--line);
          padding:6px 12px; border-radius:20px; cursor:pointer;
          backdrop-filter:blur(12px);
        }
        .ub-dot { width:6px; height:6px; border-radius:50%; background:var(--muted); }
        .ub-dot.on { background:var(--green); box-shadow:0 0 6px var(--green); }
        .ub-name { font-size:9px; letter-spacing:.18em; color:var(--muted); }
        /* Team */
        .team-sheet {
          position:absolute; bottom:56px; left:0; right:0;
          background:var(--panel); border-top:1px solid var(--line);
          backdrop-filter:blur(18px); z-index:10;
          padding:16px 20px 12px; max-height:220px; overflow-y:auto;
        }
        .sheet-label { font-size:9px; letter-spacing:.28em; color:var(--muted); margin-bottom:12px; }
        .sheet-empty { font-size:11px; color:var(--muted); padding:8px 20px; }
        .sheet-empty.loading { padding:24px 20px; text-align:center; letter-spacing:.1em; }
        .runner-row { display:flex; align-items:center; gap:10px; padding:8px 0; border-bottom:1px solid var(--line); }
        .runner-row:last-child { border-bottom:none; }
        .rdot { width:5px; height:5px; border-radius:50%; background:var(--cyan); box-shadow:0 0 5px var(--cyan); flex-shrink:0; }
        .rname { flex:1; font-size:12px; letter-spacing:.06em; color:var(--text); }
        .rtime { font-size:10px; color:var(--muted); }
        /* History */
        .history-list { position:absolute; top:58px; bottom:56px; left:0; right:0; overflow-y:auto; z-index:10; }
        .history-empty { display:flex; flex-direction:column; align-items:center; justify-content:center; height:100%; gap:10px; color:var(--muted); }
        .empty-icon { font-size:40px; opacity:.25; margin-bottom:6px; }
        .history-empty p { font-size:13px; letter-spacing:.06em; }
        .empty-sub { font-size:10px; letter-spacing:.04em; opacity:.6; }
        .history-row {
          width:100%; display:flex; flex-direction:column; gap:8px;
          padding:14px 20px; border-bottom:1px solid var(--line);
          background:none; border-left:none; border-right:none; border-top:none;
          cursor:pointer; text-align:left; transition:.12s;
        }
        .history-row:active { background:rgba(255,255,255,.03); }
        .hrow-top { display:flex; align-items:center; justify-content:space-between; }
        .hrun-label { font-size:13px; font-weight:500; color:var(--text); letter-spacing:.04em; }
        .hchevron { font-size:18px; color:var(--muted); line-height:1; }
        .hrow-stats { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
        .hstat { display:flex; align-items:baseline; gap:3px; }
        .hdiv { width:1px; height:12px; background:var(--line); flex-shrink:0; }
        .hval { font-size:15px; font-weight:400; color:var(--text); }
        .hunit { font-size:8px; letter-spacing:.18em; color:var(--muted); text-transform:uppercase; }
        .hstat.accent .hval { color:var(--cyan); }
        .hstat.accent .hunit { color:var(--cyan); opacity:.55; }
      `}</style>
    </div>
  )
}

// ─── Post Screen (original WHO RUNS design) ───────────────────────────────────

function PostScreen({
  stats,
  onConfirm,
  onDiscard,
  showActions = true,
}: {
  stats: RunStats
  onConfirm?: () => void
  onDiscard?: () => void
  showActions?: boolean
}) {
  return (
    <div className="post">
      <div className="wordmark">W H O &nbsp; R U N S</div>

      <div className="row">
        <Big value={stats.distanceKm.toFixed(2)} label="KM" />
        <div className="sep" />
        <Big value={formatTime(stats.durationSec)} label="DURATION" />
        <div className="sep" />
        <Big value={formatPace(stats.pace)} label="PACE" />
      </div>
      <div className="divh" />
      <div className="row">
        <Big value={stats.sqm > 0 ? `${(stats.sqm / 1000).toFixed(1)}k` : '—'} label="SQM" accent />
        <div className="sep" />
        <Big value={stats.sqm > 0 ? Math.round(stats.sqm * 0.074).toLocaleString() : '—'} label="POINTS" />
        <div className="sep" />
        <Big value="×2.25" label="BOOST" />
      </div>

      {showActions && <div className="actions">
        <button className="act confirm" onClick={onConfirm}>
          <span className="act-icon">✓</span>
          <span className="act-label">SAVE RUN</span>
        </button>
        <button className="act discard" onClick={onDiscard}>
          <span className="act-icon">✕</span>
          <span className="act-label">DISCARD</span>
        </button>
      </div>}

      <style jsx>{`
        .post {
          position:absolute; bottom:0; left:0; right:0; z-index:20;
          background:
            radial-gradient(circle at 50px 66px, rgba(0, 191, 245, .08), transparent 26%),
            radial-gradient(circle at calc(100% - 50px) 66px, rgba(0, 191, 245, .08), transparent 26%),
            linear-gradient(to bottom, rgba(5,8,13,0) 0%, rgba(5,8,13,.7) 46px, rgba(5,8,13,.7) 100%);
          padding-top:58px;
        }
        .wordmark {
          text-align:center; font-size:9px; font-weight:600;
          letter-spacing:.72em; color:#14d9ff; margin-bottom:30px;
          display:flex; align-items:center; justify-content:center; gap:10px;
          text-shadow:0 0 10px rgba(20,217,255,.9), 0 0 24px rgba(0,191,245,.45);
        }
        .wordmark::before,.wordmark::after {
          content:''; flex:1; max-width:184px; height:1px;
          background:linear-gradient(to right, transparent, #14d9ff);
          opacity:.72;
          box-shadow:0 0 12px rgba(20,217,255,.8);
        }
        .wordmark::after {
          background:linear-gradient(to right, #14d9ff, transparent);
        }
        .row { display:flex; align-items:stretch; }
        .sep { width:1px; background:var(--line); flex-shrink:0; }
        .divh { height:1px; background:rgba(255,255,255,.16); margin:10px 8%; }
        .actions {
          display:grid; grid-template-columns:1fr 1fr;
          border:1px solid rgba(255,255,255,.14);
          border-radius:6px;
          margin:28px 8% 20px;
          overflow:hidden;
          background:rgba(0,0,0,.18);
        }
        .act {
          height:118px; background:none; border:none;
          display:flex; flex-direction:column; align-items:center; justify-content:center;
          gap:4px; cursor:pointer; transition:.15s;
        }
        .act-icon { font-size:46px; font-weight:200; color:rgba(255,255,255,.82); line-height:1; text-shadow:0 0 18px rgba(255,255,255,.42), 0 0 42px rgba(20,217,255,.22); }
        .act-label { font-size:8px; letter-spacing:.28em; color:var(--muted); }
        .confirm { border-right:1px solid rgba(255,255,255,.18); }
        .confirm:hover { background:rgba(20,217,255,.06); }
        .confirm:hover .act-icon, .confirm:hover .act-label { color:#fff; }
        .discard:hover { background:rgba(255,68,85,.05); }
        .discard:hover .act-icon, .discard:hover .act-label { color:var(--red); }
      `}</style>
    </div>
  )
}

function Big({ value, label, accent }: { value: string; label: string; accent?: boolean }) {
  return (
    <div className={`big ${accent ? 'a' : ''}`}>
      <div className="bv">{value}</div>
      <div className="bl">{label}</div>
      <style jsx>{`
        .big { flex:1; display:flex; flex-direction:column; align-items:flex-start; padding:14px 0 14px 20px; }
        .bv { font-size:32px; font-weight:300; letter-spacing:.02em; color:var(--text); line-height:1; margin-bottom:5px; }
        .bl { font-size:8px; font-weight:500; letter-spacing:.28em; color:var(--muted); }
        .a .bv { color:var(--cyan); }
      `}</style>
    </div>
  )
}

// ─── History Run Summary ──────────────────────────────────────────────────────

interface RunSummaryProps {
  stats: RunStats
  route: [number, number][]
  label: string
  date: string
  onBack: () => void
}

function RunSummary({ stats, route, label, date, onBack }: RunSummaryProps) {
  const center: [number, number] = route.length > 0 ? routeCenter(route) : [0, 0]
  const routeAsGPS: GPSPoint[] = route.map(([lat, lng]) => ({ lat, lng, timestamp: 0 }))
  const pts = stats.sqm > 0 ? Math.round(stats.sqm * 0.074) : 0
  const displayTime = new Date(date).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })

  return (
    <div className="summary">
      <div className="smap">
        {route.length > 1 ? (
          <RunMap center={center} myPosition={null} route={routeAsGPS} teamRunners={[]} zoom={15} followUser={false} closedPolygons={[]} />
        ) : (
          <div className="no-map">No route recorded</div>
        )}
        <button className="back-btn" onClick={onBack}>‹ RUNS</button>
      </div>

      <PostScreen stats={stats} showActions={false} />

      <div className="spanel">
        <div className="wordmark">W H O &nbsp; R U N S</div>
        <div className="sdate-row">
          <span className="srun-label">{label}</span>
          <span className="stime">{displayTime}</span>
        </div>

        <div className="sprimary">
          <div className="sblock"><div className="sbig">{stats.distanceKm.toFixed(2)}</div><div className="slabel">KM</div></div>
          <div className="svline" />
          <div className="sblock"><div className="sbig">{formatTime(stats.durationSec)}</div><div className="slabel">DURATION</div></div>
          <div className="svline" />
          <div className="sblock"><div className="sbig">{formatPace(stats.pace)}</div><div className="slabel">PACE</div></div>
        </div>

        <div className="shline" />

        <div className="ssecondary">
          <div className="sblock2"><div className={`sbig2 ${stats.sqm > 0 ? 'cyan' : ''}`}>{stats.sqm > 0 ? (stats.sqm >= 1000 ? `${(stats.sqm / 1000).toFixed(1)}k` : String(Math.round(stats.sqm))) : '—'}</div><div className="slabel">SQM</div></div>
          <div className="svline" />
          <div className="sblock2"><div className={`sbig2 ${pts > 0 ? 'green' : ''}`}>{pts > 0 ? pts.toLocaleString() : '—'}</div><div className="slabel">POINTS</div></div>
          <div className="svline" />
          <div className="sblock2"><div className="sbig2">{stats.sqm > 0 ? '×2.25' : '—'}</div><div className="slabel">BOOST</div></div>
        </div>

        <div className="shline" />

        <div className="sactions">
          <button className="sact" onClick={onBack}><span className="sact-label">← BACK TO RUNS</span></button>
        </div>
      </div>

      <style jsx>{`
        .summary { position:absolute; inset:0; display:flex; flex-direction:column; background:var(--bg); }
        .smap { flex:1; position:relative; min-height:0; }
        .no-map { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; color:var(--muted); font-size:10px; letter-spacing:.2em; background:var(--bg); }
        .back-btn {
          position:absolute; top:16px; left:16px; z-index:20;
          background:var(--panel); border:1px solid var(--line);
          color:var(--cyan); font-size:10px; letter-spacing:.16em;
          padding:7px 14px; border-radius:4px; cursor:pointer; backdrop-filter:blur(12px);
        }
        .spanel {
          display:none;
          flex-shrink:0;
          background:linear-gradient(to bottom,transparent 0%,rgba(10,13,18,.97) 16%,#0a0d12 100%);
          border-top:1px solid var(--line);
          backdrop-filter:blur(20px);
          padding-top:52px;
        }
        .wordmark {
          text-align:center; font-size:9px; font-weight:600;
          letter-spacing:.55em; color:var(--cyan); margin-bottom:24px;
          display:flex; align-items:center; justify-content:center; gap:10px;
        }
        .wordmark::before,.wordmark::after {
          content:''; flex:1; max-width:48px; height:1px;
          background:var(--cyan); opacity:.35;
        }
        .sdate-row { display:flex; align-items:center; justify-content:space-between; padding:12px 20px 10px; border-bottom:1px solid var(--line); }
        .srun-label { font-size:13px; font-weight:500; letter-spacing:.04em; color:var(--text); }
        .stime { font-size:10px; color:var(--muted); letter-spacing:.08em; }
        .sprimary { display:flex; align-items:stretch; }
        .sblock { flex:1; display:flex; flex-direction:column; align-items:flex-start; padding:14px 0 12px 18px; }
        .sbig { font-size:32px; font-weight:300; letter-spacing:.02em; color:var(--text); line-height:1; margin-bottom:5px; }
        .slabel { font-size:8px; font-weight:500; letter-spacing:.28em; color:var(--muted); text-transform:uppercase; }
        .svline { width:1px; background:var(--line); flex-shrink:0; }
        .shline { height:1px; background:var(--line); }
        .ssecondary { display:flex; align-items:stretch; }
        .sblock2 { flex:1; display:flex; flex-direction:column; align-items:flex-start; padding:12px 0 12px 18px; }
        .sbig2 { font-size:32px; font-weight:300; letter-spacing:.02em; color:var(--text); line-height:1; margin-bottom:5px; }
        .sbig2.cyan { color:var(--cyan); }
        .sbig2.green { color:var(--green); }
        .sactions { display:none; }
        .sact { flex:1; display:flex; align-items:center; justify-content:center; background:none; border:none; cursor:pointer; transition:.15s; }
        .sact-label { font-size:9px; letter-spacing:.28em; color:var(--muted); }
        .sact:hover .sact-label { color:var(--cyan); }
      `}</style>
    </div>
  )
}

// ─── Auth Modal ───────────────────────────────────────────────────────────────

function AuthModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [mode, setMode] = useState<'choose' | 'email'>('choose')
  const [isSignUp, setIsSignUp] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  const handleGoogle = async () => {
    setLoading(true)
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin },
    })
    if (error) setError(error.message)
    setLoading(false)
  }

  const handleEmail = async () => {
    setLoading(true)
    setError('')
    if (isSignUp) {
      const { error } = await supabase.auth.signUp({
        email, password,
        options: {
          data: { full_name: name },
          emailRedirectTo: window.location.origin,
        },
      })
      if (error) setError(error.message)
      else setMessage('Check your email to confirm your account.')
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email, password })
      if (error) setError(error.message)
      else onDone()
    }
    setLoading(false)
  }

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    onDone()
  }

  // Check if already signed in
  const [session, setSession] = useState<any>(null)
  useEffect(() => { supabase.auth.getSession().then(({ data }) => setSession(data.session)) }, [])

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">W H O &nbsp; R U N S</div>

        {session ? (
          <>
            <p className="modal-signed">Signed in as</p>
            <p className="modal-email">{session.user.email}</p>
            <button className="mbtn danger" onClick={handleSignOut}>SIGN OUT</button>
            <button className="mbtn ghost" onClick={onClose}>CLOSE</button>
          </>
        ) : mode === 'choose' ? (
          <>
            <button className="mbtn google" onClick={handleGoogle} disabled={loading}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style={{marginRight:8}}>
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
              </svg>
              CONTINUE WITH GOOGLE
            </button>
            <div className="mor"><span>OR</span></div>
            <button className="mbtn outline" onClick={() => setMode('email')}>SIGN IN WITH EMAIL</button>
            {error && <p className="merr">{error}</p>}
          </>
        ) : (
          <>
            <button className="mback" onClick={() => setMode('choose')}>‹ BACK</button>
            <p className="modal-sub">{isSignUp ? 'CREATE ACCOUNT' : 'SIGN IN'}</p>
            {isSignUp && (
              <input className="minput" placeholder="Display name" value={name} onChange={e => setName(e.target.value)} />
            )}
            <input className="minput" placeholder="Email" type="email" value={email} onChange={e => setEmail(e.target.value)} />
            <input className="minput" placeholder="Password" type="password" value={password} onChange={e => setPassword(e.target.value)} />
            {error && <p className="merr">{error}</p>}
            {message && <p className="mok">{message}</p>}
            <button className="mbtn primary" onClick={handleEmail} disabled={loading || !email || !password}>
              {loading ? '...' : isSignUp ? 'CREATE ACCOUNT' : 'SIGN IN'}
            </button>
            <button className="mbtn ghost" onClick={() => setIsSignUp(!isSignUp)}>
              {isSignUp ? 'ALREADY HAVE AN ACCOUNT' : 'CREATE AN ACCOUNT'}
            </button>
          </>
        )}

        <style jsx>{`
          .modal-overlay {
            position:fixed; inset:0; z-index:100;
            background:rgba(0,0,0,.7); backdrop-filter:blur(6px);
            display:flex; align-items:flex-end; justify-content:center;
          }
          .modal {
            width:100%; max-width:440px;
            background:#0e1118; border-top:1px solid var(--line);
            border-radius:16px 16px 0 0; padding:28px 24px 40px;
            display:flex; flex-direction:column; gap:10px;
          }
          .modal-title {
            text-align:center; font-size:9px; font-weight:600;
            letter-spacing:.55em; color:var(--cyan); margin-bottom:8px;
          }
          .modal-sub { font-size:9px; letter-spacing:.3em; color:var(--muted); text-align:center; margin-bottom:4px; }
          .modal-signed { font-size:10px; letter-spacing:.15em; color:var(--muted); text-align:center; }
          .modal-email { font-size:14px; color:var(--text); text-align:center; margin-bottom:8px; }
          .mbtn {
            width:100%; height:46px; border-radius:6px; border:none;
            font-size:9px; font-weight:600; letter-spacing:.28em;
            cursor:pointer; transition:.15s; display:flex; align-items:center; justify-content:center;
          }
          .mbtn:disabled { opacity:.35; cursor:not-allowed; }
          .google { background:#fff; color:#1a1a1a; }
          .google:hover { background:#f0f0f0; }
          .outline { background:transparent; color:var(--text); border:1px solid var(--line); }
          .outline:hover { border-color:var(--cyan); color:var(--cyan); }
          .primary { background:var(--cyan); color:#0a0d12; }
          .primary:hover { filter:brightness(1.1); }
          .ghost { background:transparent; color:var(--muted); font-size:8px; }
          .ghost:hover { color:var(--text); }
          .danger { background:rgba(255,68,85,.12); color:var(--red); border:1px solid rgba(255,68,85,.25); }
          .mor { display:flex; align-items:center; gap:12px; }
          .mor::before,.mor::after { content:''; flex:1; height:1px; background:var(--line); }
          .mor span { font-size:9px; letter-spacing:.2em; color:var(--muted); }
          .minput {
            width:100%; height:44px; background:rgba(255,255,255,.04);
            border:1px solid var(--line); border-radius:6px;
            color:var(--text); font-size:13px; padding:0 14px;
            outline:none; font-family:var(--font);
          }
          .minput:focus { border-color:var(--cyan); }
          .minput::placeholder { color:var(--muted); }
          .merr { font-size:10px; color:var(--red); text-align:center; }
          .mok { font-size:10px; color:var(--green); text-align:center; }
          .mback { background:none; border:none; color:var(--cyan); font-size:10px; letter-spacing:.14em; cursor:pointer; text-align:left; padding:0; }
        `}</style>
      </div>
    </div>
  )
}

// ─── Shared primitives ────────────────────────────────────────────────────────

function Acquiring() {
  return (
    <div className="acq">
      <div className="acq-dot" />
      <span>ACQUIRING GPS</span>
      <style jsx>{`
        .acq {
          position:absolute; inset:0; display:flex; flex-direction:column;
          align-items:center; justify-content:center; gap:14px;
          background:var(--bg); color:var(--muted); font-size:9px; letter-spacing:.3em;
        }
        .acq-dot {
          width:8px; height:8px; border-radius:50%;
          background:var(--cyan); box-shadow:0 0 12px var(--cyan);
          animation:blink 1.1s infinite ease-in-out;
        }
        @keyframes blink { 0%,100%{opacity:.25} 50%{opacity:1} }
      `}</style>
    </div>
  )
}

function TopBar({ children }: { children: React.ReactNode }) {
  return (
    <div className="topbar">
      {children}
      <style jsx>{`
        .topbar {
          position:absolute; top:0; left:0; right:0; height:58px;
          display:grid; grid-template-columns:repeat(4,1fr);
          background:var(--panel); border-bottom:1px solid var(--line);
          backdrop-filter:blur(16px); z-index:10;
        }
      `}</style>
    </div>
  )
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={`s ${accent ? 'a' : ''}`}>
      <div className="v">{value}</div>
      <div className="l">{label}</div>
      <style jsx>{`
        .s { display:flex; flex-direction:column; justify-content:center; padding:0 0 0 14px; border-right:1px solid var(--line); }
        .s:last-child { border-right:none; }
        .v { font-size:16px; font-weight:500; letter-spacing:.02em; color:var(--text); line-height:1; margin-bottom:4px; }
        .l { font-size:8px; font-weight:500; letter-spacing:.22em; text-transform:uppercase; color:var(--muted); }
        .a .v { color:var(--cyan); }
        .a .l { color:var(--cyan); opacity:.55; }
      `}</style>
    </div>
  )
}

function StartButton({ onStart, hasGps }: { onStart: () => void; hasGps: boolean }) {
  return (
    <div className="dock">
      <button className={`btn ${!hasGps ? 'dim' : ''}`} onClick={onStart} disabled={!hasGps}>
        <div className="ring r1" /><div className="ring r2" />
        <div className="core" />
      </button>
      {!hasGps && <p className="hint">ACQUIRING GPS</p>}
      <style jsx>{`
        .dock { position:absolute; bottom:90px; left:50%; transform:translateX(-50%); z-index:10; display:flex; flex-direction:column; align-items:center; gap:12px; }
        .btn { position:relative; width:76px; height:76px; border-radius:50%; border:none; background:transparent; cursor:pointer; }
        .btn.dim { opacity:.3; cursor:not-allowed; }
        .ring { position:absolute; border-radius:50%; border:1px solid rgba(0,200,240,.35); animation:pulse 2.2s infinite ease-in-out; }
        .r1 { inset:0; }
        .r2 { inset:9px; animation-duration:1.7s; }
        .core { position:absolute; inset:22px; border-radius:50%; background:var(--cyan); box-shadow:0 0 22px rgba(0,200,240,.65); }
        @keyframes pulse { 0%,100%{opacity:.35;transform:scale(1)} 50%{opacity:.85;transform:scale(1.05)} }
        .hint { font-size:8px; letter-spacing:.28em; color:var(--muted); }
      `}</style>
    </div>
  )
}

function BottomBar({ activeTab, onTabChange }: { activeTab: 'me' | 'team' | 'history'; onTabChange: (t: 'me' | 'team' | 'history') => void }) {
  return (
    <div className="bar">
      <button className={`tab ${activeTab === 'me' ? 'on' : ''}`} onClick={() => onTabChange('me')}>ME</button>
      <button className={`tab ${activeTab === 'team' ? 'on' : ''}`} onClick={() => onTabChange('team')}>TEAM</button>
      <button className={`tab ${activeTab === 'history' ? 'on' : ''}`} onClick={() => onTabChange('history')}>RUNS</button>
      <style jsx>{`
        .bar {
          position:absolute; bottom:0; left:0; right:0; height:56px;
          display:grid; grid-template-columns:1fr 1fr 1fr;
          background:var(--panel); border-top:1px solid var(--line);
          backdrop-filter:blur(14px); z-index:10;
        }
        .tab { display:flex; align-items:center; justify-content:center; font-size:9px; font-weight:600; letter-spacing:.32em; color:var(--muted); background:none; border:none; border-right:1px solid var(--line); cursor:pointer; transition:.15s; }
        .tab:last-child { border-right:none; }
        .tab.on { color:var(--text); }
      `}</style>
    </div>
  )
}
