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
}

interface TeamRunner {
  user_id: string
  display_name: string | null
  latitude: number
  longitude: number
  updated_at: string
}

function generateUserId() {
  if (typeof window === 'undefined') return 'anon'
  let id = localStorage.getItem('whoRuns_userId')
  if (!id) {
    id = 'runner_' + Math.random().toString(36).slice(2, 10)
    localStorage.setItem('whoRuns_userId', id)
  }
  return id
}

function generateDisplayName() {
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

const CLOSE_THRESHOLD_M = 50

function computeClosedArea(points: GPSPoint[]): { sqm: number; closed: boolean } {
  if (points.length < 6) return { sqm: 0, closed: false }
  const first = points[0]
  const last = points[points.length - 1]
  if (distanceKm(first, last) * 1000 > CLOSE_THRESHOLD_M) return { sqm: 0, closed: false }
  const avgLat = points.reduce((s, p) => s + p.lat, 0) / points.length
  const mLat = 111320
  const mLng = 111320 * Math.cos((avgLat * Math.PI) / 180)
  let area = 0
  for (let i = 0; i < points.length; i++) {
    const j = (i + 1) % points.length
    area += points[i].lng * mLng * points[j].lat * mLat
    area -= points[j].lng * mLng * points[i].lat * mLat
  }
  return { sqm: Math.round(Math.abs(area) / 2), closed: true }
}

// Derive a route center from an array of [lat,lng] pairs
function routeCenter(route: [number, number][]): [number, number] {
  if (!route.length) return [0, 0]
  const lat = route.reduce((s, p) => s + p[0], 0) / route.length
  const lng = route.reduce((s, p) => s + p[1], 0) / route.length
  return [lat, lng]
}

export default function App() {
  const [screen, setScreen] = useState<Screen>('idle')
  const [activeTab, setActiveTab] = useState<'me' | 'team' | 'history'>('me')
  const [userId] = useState(generateUserId)
  const [displayName] = useState(generateDisplayName)

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
  const closedPolygonsRef = useRef<{ points: GPSPoint[]; sqm: number }[]>([])

  const [teamRunners, setTeamRunners] = useState<TeamRunner[]>([])

  // GPS watch
  useEffect(() => {
    if (!navigator.geolocation) { setGpsError('GPS not available'); return }
    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const pt: GPSPoint = { lat: pos.coords.latitude, lng: pos.coords.longitude, timestamp: Date.now() }
        setPosition(pt)
        setGpsError(null)
        if (!isRunningRef.current) return

        const updated = [...routeRef.current, pt]
        routeRef.current = updated

        let totalKm = 0
        for (let i = 1; i < updated.length; i++) totalKm += distanceKm(updated[i - 1], updated[i])
        const durSec = startTimeRef.current ? (Date.now() - startTimeRef.current) / 1000 : 0
        totalDistKmRef.current = totalKm
        const pace = totalKm > 0.01 ? durSec / totalKm : 0

        const { sqm, closed } = computeClosedArea(updated)
        if (closed && !lastClosedRef.current) {
          lastClosedRef.current = true
          const newPolygon = { points: [...updated], sqm }
          closedPolygonsRef.current = [...closedPolygonsRef.current, newPolygon]
          setClosedPolygons(closedPolygonsRef.current)
          const newTotal = totalSqmRef.current + sqm
          totalSqmRef.current = newTotal
          setLoopJustClosed(true)
          setTimeout(() => setLoopJustClosed(false), 1800)
          routeRef.current = [pt]
          setRoute([pt])
          setStats({ distanceKm: totalKm, durationSec: durSec, pace, sqm: newTotal })
          return
        }
        if (!closed) lastClosedRef.current = false
        setRoute([...updated])
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
    closedPolygonsRef.current = []
    totalSqmRef.current = 0
    totalDistKmRef.current = 0
    lastClosedRef.current = false
    startTimeRef.current = Date.now()
    isRunningRef.current = true
    setRoute([])
    setClosedPolygons([])
    setElapsed(0)
    setStats({ distanceKm: 0, durationSec: 0, pace: 0, sqm: 0 })
    setScreen('running')
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
        started_at: new Date(start).toISOString(),
        ended_at: new Date().toISOString(),
        route: routeRef.current.map((p) => [p.lat, p.lng]),
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
      .select('id, started_at, ended_at, distance_km, duration_seconds, pace_per_km, sqm_covered, route')
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

  // Convert live route to [lat,lng] pairs for summary
  const liveRoutePairs: [number, number][] = routeRef.current.map(p => [p.lat, p.lng])

  return (
    <div className="shell">
      {gpsError && <div className="gps-err">⚠ {gpsError}</div>}

      {/* IDLE */}
      {screen === 'idle' && activeTab === 'me' && (
        <div className="screen">
          <div className="map-fill">
            {mapCenter ? <RunMap center={mapCenter} myPosition={position} route={[]} teamRunners={[]} zoom={16} followUser closedPolygons={[]} /> : <Acquiring />}
          </div>
          <TopBar><Stat label="KM" value="—" /><Stat label="PACE" value="—" /><Stat label="TIME" value="—" /><Stat label="SQM" value="—" /></TopBar>
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

      {/* POST — full screen summary */}
      {screen === 'post' && finalStats && (
        <div className="screen">
          <RunSummary
            stats={finalStats}
            route={liveRoutePairs}
            myPosition={position}
            closedPolygons={closedPolygons}
            mode="post"
            onConfirm={confirmSave}
            onDiscard={discardRun}
          />
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
                  <div className="hrow-left">
                    <span className="hdate">{new Date(run.started_at).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</span>
                    <span className="htime-badge">{new Date(run.started_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}</span>
                  </div>
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

      {/* HISTORY DETAIL — run summary for a past run */}
      {activeTab === 'history' && selectedRun && (
        <div className="screen">
          <RunSummary
            stats={{
              distanceKm: selectedRun.distance_km,
              durationSec: selectedRun.duration_seconds,
              pace: selectedRun.pace_per_km,
              sqm: selectedRun.sqm_covered,
            }}
            route={selectedRun.route || []}
            myPosition={null}
            closedPolygons={[]}
            mode="history"
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
        .stop-wrap {
          position:absolute; bottom:40px; left:50%;
          transform:translateX(-50%); z-index:10;
        }
        .stop-btn {
          width:64px; height:64px; border-radius:50%;
          border:1px solid rgba(255,68,85,.5); background:rgba(255,68,85,.08);
          display:flex; align-items:center; justify-content:center;
          cursor:pointer; transition:.15s;
        }
        .stop-btn:active { transform:scale(.93); background:rgba(255,68,85,.18); }
        .stop-sq { width:22px; height:22px; background:var(--red); border-radius:3px; box-shadow:0 0 14px rgba(255,68,85,.5); }
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
        /* History list */
        .history-list {
          position:absolute; top:58px; bottom:56px; left:0; right:0;
          overflow-y:auto; z-index:10;
        }
        .history-empty {
          display:flex; flex-direction:column; align-items:center;
          justify-content:center; height:100%; gap:10px; color:var(--muted);
        }
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
        .hrow-left { display:flex; align-items:center; gap:8px; }
        .hdate { font-size:13px; font-weight:500; color:var(--text); letter-spacing:.03em; }
        .htime-badge {
          font-size:9px; letter-spacing:.1em; color:var(--muted);
          background:rgba(255,255,255,.05); padding:2px 6px; border-radius:3px;
        }
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

// ─── Run Summary (shared by post-run and history detail) ─────────────────────

interface RunSummaryProps {
  stats: RunStats
  route: [number, number][]
  myPosition: GPSPoint | null
  closedPolygons: { points: GPSPoint[]; sqm: number }[]
  mode: 'post' | 'history'
  date?: string
  onConfirm?: () => void
  onDiscard?: () => void
  onBack?: () => void
}

function RunSummary({ stats, route, myPosition, closedPolygons, mode, date, onConfirm, onDiscard, onBack }: RunSummaryProps) {
  const center: [number, number] = route.length > 0
    ? routeCenter(route)
    : myPosition ? [myPosition.lat, myPosition.lng] : [0, 0]

  const routeAsGPS: GPSPoint[] = route.map(([lat, lng]) => ({ lat, lng, timestamp: 0 }))
  const hasRoute = route.length > 1

  const pts = stats.sqm > 0 ? Math.round(stats.sqm * 0.074) : 0

  const displayDate = date
    ? new Date(date).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
    : new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
  const displayTime = date
    ? new Date(date).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
    : new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })

  return (
    <div className="summary">
      {/* Map — top half */}
      <div className="smap">
        {hasRoute || myPosition ? (
          <RunMap
            center={center}
            myPosition={mode === 'post' ? myPosition : null}
            route={routeAsGPS}
            teamRunners={[]}
            zoom={15}
            followUser={false}
            closedPolygons={closedPolygons}
          />
        ) : (
          <div className="no-map">No route recorded</div>
        )}
        {/* Back button for history mode */}
        {mode === 'history' && (
          <button className="back-btn" onClick={onBack}>‹ RUNS</button>
        )}
      </div>

      {/* Stats panel — bottom half */}
      <div className="spanel">
        {/* Date/time header */}
        <div className="sdate-row">
          <span className="sdate">{displayDate}</span>
          <span className="stime">{displayTime}</span>
        </div>

        {/* Primary stats row */}
        <div className="sprimary">
          <div className="sblock">
            <div className="sbig">{stats.distanceKm.toFixed(2)}</div>
            <div className="slabel">KILOMETERS</div>
          </div>
          <div className="svline" />
          <div className="sblock">
            <div className="sbig">{formatTime(stats.durationSec)}</div>
            <div className="slabel">DURATION</div>
          </div>
          <div className="svline" />
          <div className="sblock">
            <div className="sbig">{formatPace(stats.pace)}</div>
            <div className="slabel">PACE /KM</div>
          </div>
        </div>

        <div className="shline" />

        {/* Secondary stats row */}
        <div className="ssecondary">
          <div className="sblock2">
            <div className={`sbig2 ${stats.sqm > 0 ? 'cyan' : ''}`}>
              {stats.sqm > 0 ? (stats.sqm >= 1000 ? `${(stats.sqm / 1000).toFixed(1)}k` : String(Math.round(stats.sqm))) : '—'}
            </div>
            <div className="slabel">SQM CAPTURED</div>
          </div>
          <div className="svline" />
          <div className="sblock2">
            <div className={`sbig2 ${pts > 0 ? 'green' : ''}`}>{pts > 0 ? pts.toLocaleString() : '—'}</div>
            <div className="slabel">POINTS</div>
          </div>
          <div className="svline" />
          <div className="sblock2">
            <div className="sbig2">{stats.sqm > 0 ? '×2.25' : '—'}</div>
            <div className="slabel">BOOST</div>
          </div>
        </div>

        <div className="shline" />

        {/* Actions */}
        {mode === 'post' && (
          <div className="sactions">
            <button className="sact save" onClick={onConfirm}>
              <span className="sact-icon">✓</span>
              <span className="sact-label">SAVE RUN</span>
            </button>
            <div className="svline" />
            <button className="sact discard" onClick={onDiscard}>
              <span className="sact-icon">✕</span>
              <span className="sact-label">DISCARD</span>
            </button>
          </div>
        )}
        {mode === 'history' && (
          <div className="sactions">
            <button className="sact back-full" onClick={onBack}>
              <span className="sact-label">← BACK TO RUNS</span>
            </button>
          </div>
        )}
      </div>

      <style jsx>{`
        .summary { position:absolute; inset:0; display:flex; flex-direction:column; background:var(--bg); }
        .smap { flex:1; position:relative; min-height:0; }
        .no-map {
          position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
          color:var(--muted); font-size:10px; letter-spacing:.2em; background:var(--bg);
        }
        .back-btn {
          position:absolute; top:16px; left:16px; z-index:20;
          background:var(--panel); border:1px solid var(--line);
          color:var(--cyan); font-size:10px; letter-spacing:.16em;
          padding:7px 14px; border-radius:4px; cursor:pointer;
          backdrop-filter:blur(12px);
        }
        .spanel {
          flex-shrink:0;
          background:var(--panel);
          border-top:1px solid var(--line);
          backdrop-filter:blur(20px);
        }
        .sdate-row {
          display:flex; align-items:center; justify-content:space-between;
          padding:12px 20px 10px;
          border-bottom:1px solid var(--line);
        }
        .sdate { font-size:12px; font-weight:500; letter-spacing:.05em; color:var(--text); }
        .stime { font-size:10px; color:var(--muted); letter-spacing:.08em; }
        .sprimary { display:flex; align-items:stretch; }
        .sblock {
          flex:1; display:flex; flex-direction:column; align-items:flex-start;
          padding:14px 0 12px 18px;
        }
        .sbig { font-size:28px; font-weight:300; letter-spacing:.02em; color:var(--text); line-height:1; margin-bottom:5px; }
        .slabel { font-size:7px; font-weight:600; letter-spacing:.28em; color:var(--muted); text-transform:uppercase; }
        .svline { width:1px; background:var(--line); flex-shrink:0; }
        .shline { height:1px; background:var(--line); }
        .ssecondary { display:flex; align-items:stretch; }
        .sblock2 {
          flex:1; display:flex; flex-direction:column; align-items:flex-start;
          padding:12px 0 12px 18px;
        }
        .sbig2 { font-size:22px; font-weight:300; letter-spacing:.02em; color:var(--text); line-height:1; margin-bottom:5px; }
        .sbig2.cyan { color:var(--cyan); }
        .sbig2.green { color:var(--green); }
        .sactions { display:flex; align-items:stretch; min-height:60px; }
        .sact {
          flex:1; display:flex; align-items:center; justify-content:center; gap:8px;
          background:none; border:none; cursor:pointer; transition:.15s;
        }
        .sact-icon { font-size:16px; color:var(--muted); }
        .sact-label { font-size:9px; letter-spacing:.28em; color:var(--muted); }
        .save:hover, .save:active { background:rgba(68,255,170,.06); }
        .save:hover .sact-icon, .save:hover .sact-label, .save:active .sact-icon, .save:active .sact-label { color:var(--green); }
        .discard:hover, .discard:active { background:rgba(255,68,85,.06); }
        .discard:hover .sact-icon, .discard:hover .sact-label, .discard:active .sact-icon, .discard:active .sact-label { color:var(--red); }
        .back-full:hover .sact-label { color:var(--cyan); }
      `}</style>
    </div>
  )
}

// ─── Shared primitives ───────────────────────────────────────────────────────

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
        .s {
          display:flex; flex-direction:column; justify-content:center;
          padding:0 0 0 14px; border-right:1px solid var(--line);
        }
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
        .dock {
          position:absolute; bottom:90px; left:50%;
          transform:translateX(-50%); z-index:10;
          display:flex; flex-direction:column; align-items:center; gap:12px;
        }
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
        .tab {
          display:flex; align-items:center; justify-content:center;
          font-size:9px; font-weight:600; letter-spacing:.32em;
          color:var(--muted); background:none; border:none;
          border-right:1px solid var(--line); cursor:pointer; transition:.15s;
        }
        .tab:last-child { border-right:none; }
        .tab.on { color:var(--text); }
      `}</style>
    </div>
  )
}