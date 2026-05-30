'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import dynamic from 'next/dynamic'
import { supabase } from '@/lib/supabase'
import { distanceKm, formatPace, formatTime, GPSPoint } from '@/lib/gps'

const RunMap = dynamic(() => import('@/components/RunMap'), { ssr: false })

type Screen = 'idle' | 'running' | 'post'

interface RunStats {
  distanceKm: number
  durationSec: number
  pace: number
  sqm: number
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

// Shoelace formula — real polygon area in m²
// Only fires when route forms a closed loop (start ↔ end within closeThresholdM)
const CLOSE_THRESHOLD_M = 50

function computeClosedArea(points: GPSPoint[]): { sqm: number; closed: boolean } {
  if (points.length < 6) return { sqm: 0, closed: false }

  const first = points[0]
  const last = points[points.length - 1]
  const closingM = distanceKm(first, last) * 1000

  if (closingM > CLOSE_THRESHOLD_M) return { sqm: 0, closed: false }

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

export default function App() {
  const [screen, setScreen] = useState<Screen>('idle')
  const [activeTab, setActiveTab] = useState<'me' | 'team'>('me')
  const [userId] = useState(generateUserId)
  const [displayName] = useState(generateDisplayName)

  const [position, setPosition] = useState<GPSPoint | null>(null)
  const [gpsError, setGpsError] = useState<string | null>(null)
  const [route, setRoute] = useState<GPSPoint[]>([])
  const [closedPolygons, setClosedPolygons] = useState<{ points: GPSPoint[]; sqm: number }[]>([])
  const [totalSqm, setTotalSqm] = useState(0)
  const [loopJustClosed, setLoopJustClosed] = useState(false)

  const [isRunning, setIsRunning] = useState(false)
  const [startTime, setStartTime] = useState<number | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [stats, setStats] = useState<RunStats>({ distanceKm: 0, durationSec: 0, pace: 0, sqm: 0 })
  const [finalStats, setFinalStats] = useState<RunStats | null>(null)
  const timerRef = useRef<NodeJS.Timeout | null>(null)
  const watchIdRef = useRef<number | null>(null)
  const lastClosedRef = useRef(false)

  const [teamRunners, setTeamRunners] = useState<TeamRunner[]>([])

  // GPS watch — always on so idle screen also follows position
  useEffect(() => {
    if (!navigator.geolocation) { setGpsError('GPS not available'); return }

    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const pt: GPSPoint = { lat: pos.coords.latitude, lng: pos.coords.longitude, timestamp: Date.now() }
        setPosition(pt)
        setGpsError(null)

        if (!isRunning) return

        setRoute((prev) => {
          const updated = [...prev, pt]

          // Distance
          let totalKm = 0
          for (let i = 1; i < updated.length; i++) totalKm += distanceKm(updated[i - 1], updated[i])

          const durSec = startTime ? (Date.now() - startTime) / 1000 : 0
          const pace = totalKm > 0 ? durSec / totalKm : 0

          // Check if loop just closed
          const { sqm, closed } = computeClosedArea(updated)
          if (closed && !lastClosedRef.current) {
            lastClosedRef.current = true
            setLoopJustClosed(true)
            setClosedPolygons((p) => [...p, { points: [...updated], sqm }])
            setTotalSqm((t) => {
              const next = t + sqm
              setStats({ distanceKm: totalKm, durationSec: durSec, pace, sqm: next })
              return next
            })
            setTimeout(() => setLoopJustClosed(false), 1800)
            // Reset route to continue from current point
            return [pt]
          }

          if (!closed) lastClosedRef.current = false

          setStats((s) => ({ ...s, distanceKm: totalKm, durationSec: durSec, pace, sqm: s.sqm }))
          return updated
        })

        supabase.from('runner_locations').upsert({
          user_id: userId, team_id: null, display_name: displayName,
          latitude: pt.lat, longitude: pt.lng, updated_at: new Date().toISOString(),
        })
      },
      (err) => setGpsError(`GPS: ${err.message}`),
      { enableHighAccuracy: true, maximumAge: 3000, timeout: 15000 }
    )

    return () => { if (watchIdRef.current !== null) navigator.geolocation.clearWatch(watchIdRef.current) }
  }, [isRunning, userId, displayName, startTime])

  // Timer
  useEffect(() => {
    if (isRunning) {
      timerRef.current = setInterval(
        () => setElapsed(startTime ? Math.floor((Date.now() - startTime) / 1000) : 0),
        1000
      )
    } else {
      if (timerRef.current) clearInterval(timerRef.current)
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [isRunning, startTime])

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
    setRoute([])
    setClosedPolygons([])
    setTotalSqm(0)
    setElapsed(0)
    lastClosedRef.current = false
    setStats({ distanceKm: 0, durationSec: 0, pace: 0, sqm: 0 })
    setStartTime(Date.now())
    setIsRunning(true)
    setScreen('running')
  }, [])

  const stopRun = useCallback(async () => {
    setIsRunning(false)
    setFinalStats({ ...stats })
    setScreen('post')
    if (route.length > 1) {
      await supabase.from('run_sessions').insert({
        user_id: userId, team_id: null,
        distance_km: stats.distanceKm, duration_seconds: stats.durationSec,
        pace_per_km: stats.pace, sqm_covered: stats.sqm,
        started_at: new Date(startTime!).toISOString(), ended_at: new Date().toISOString(),
        route: route.map((p) => [p.lat, p.lng]),
      })
    }
    await supabase.from('runner_locations').delete().eq('user_id', userId)
  }, [stats, route, userId, startTime])

  const mapCenter: [number, number] | null = position ? [position.lat, position.lng] : null

  return (
    <div className="shell">
      {gpsError && <div className="gps-err">⚠ {gpsError}</div>}

      {/* IDLE */}
      {screen === 'idle' && activeTab === 'me' && (
        <div className="screen">
          <div className="map-fill">
            {mapCenter
              ? <RunMap center={mapCenter} myPosition={position} route={[]} teamRunners={[]} zoom={16} followUser closedPolygons={[]} />
              : <Acquiring />}
          </div>
          <TopBar><Stat label="KM" value="—" /><Stat label="PACE" value="—" /><Stat label="TIME" value="—" /><Stat label="SQM" value="—" /></TopBar>
          <StartButton onStart={startRun} hasGps={!!position} />
          <BottomBar activeTab={activeTab} onTabChange={setActiveTab} />
        </div>
      )}

      {/* RUNNING */}
      {screen === 'running' && (
        <div className="screen">
          <div className="map-fill">
            {mapCenter && (
              <RunMap center={mapCenter} myPosition={position} route={route} teamRunners={[]} zoom={17} followUser closedPolygons={closedPolygons} loopFlash={loopJustClosed} />
            )}
          </div>
          <TopBar>
            <Stat label="KM" value={stats.distanceKm.toFixed(2)} accent />
            <Stat label="PACE" value={formatPace(stats.pace)} />
            <Stat label="TIME" value={formatTime(elapsed)} />
            <Stat label="SQM" value={stats.sqm > 0 ? (stats.sqm >= 1000 ? `${(stats.sqm/1000).toFixed(1)}k` : String(stats.sqm)) : '—'} />
          </TopBar>
          <div className="elapsed">{formatTime(elapsed)}</div>
          <div className="stop-wrap">
            <button className="stop-btn" onClick={stopRun}>
              <div className="stop-sq" />
            </button>
          </div>
        </div>
      )}

      {/* POST */}
      {screen === 'post' && activeTab === 'me' && finalStats && (
        <div className="screen">
          <div className="map-fill">
            {mapCenter && <RunMap center={mapCenter} myPosition={position} route={route} teamRunners={[]} zoom={15} closedPolygons={closedPolygons} />}
          </div>
          <PostScreen stats={finalStats} onDone={() => { setScreen('idle'); setStats({ distanceKm:0,durationSec:0,pace:0,sqm:0 }); setElapsed(0) }} />
        </div>
      )}

      {/* TEAM */}
      {activeTab === 'team' && screen !== 'running' && (
        <div className="screen">
          <div className="map-fill">
            {mapCenter
              ? <RunMap center={mapCenter} myPosition={position} route={[]} teamRunners={teamRunners} zoom={15} closedPolygons={[]} />
              : <Acquiring />}
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
                  <span className="rname">{r.display_name || r.user_id.slice(0,10)}</span>
                  <span className="rtime">{Math.round((Date.now()-new Date(r.updated_at).getTime())/1000)}s</span>
                </div>
              ))}
          </div>
          <BottomBar activeTab={activeTab} onTabChange={setActiveTab} />
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
          position:absolute; left:50%; top:42%;
          transform:translate(-50%,-50%);
          font-size:48px; font-weight:300; letter-spacing:.06em;
          color:var(--text); z-index:10; pointer-events:none;
        }
        .stop-wrap {
          position:absolute; bottom:40px; left:50%;
          transform:translateX(-50%); z-index:10;
        }
        .stop-btn {
          width:64px; height:64px; border-radius:50%;
          border:1px solid rgba(255,68,85,.5);
          background:rgba(255,68,85,.08);
          display:flex; align-items:center; justify-content:center;
          cursor:pointer; transition:.15s;
        }
        .stop-btn:active { transform:scale(.93); background:rgba(255,68,85,.18); }
        .stop-sq {
          width:22px; height:22px; background:var(--red);
          border-radius:3px; box-shadow:0 0 14px rgba(255,68,85,.5);
        }
        .team-sheet {
          position:absolute; bottom:56px; left:0; right:0;
          background:var(--panel); border-top:1px solid var(--line);
          backdrop-filter:blur(18px); z-index:10;
          padding:16px 20px 12px; max-height:220px; overflow-y:auto;
        }
        .sheet-label {
          font-size:9px; letter-spacing:.28em; color:var(--muted);
          margin-bottom:12px;
        }
        .sheet-empty { font-size:11px; color:var(--muted); padding:8px 0; }
        .runner-row {
          display:flex; align-items:center; gap:10px;
          padding:8px 0; border-bottom:1px solid var(--line);
        }
        .runner-row:last-child { border-bottom:none; }
        .rdot {
          width:5px; height:5px; border-radius:50%;
          background:var(--cyan); box-shadow:0 0 5px var(--cyan); flex-shrink:0;
        }
        .rname { flex:1; font-size:12px; letter-spacing:.06em; color:var(--text); }
        .rtime { font-size:10px; color:var(--muted); }
      `}</style>
    </div>
  )
}

function Acquiring() {
  return (
    <div className="acq">
      <div className="acq-dot" />
      <span>ACQUIRING GPS</span>
      <style jsx>{`
        .acq {
          position:absolute; inset:0; display:flex; flex-direction:column;
          align-items:center; justify-content:center; gap:14px;
          background:var(--bg); color:var(--muted);
          font-size:9px; letter-spacing:.3em;
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
        .v {
          font-size:16px; font-weight:500; letter-spacing:.02em;
          color:var(--text); line-height:1; margin-bottom:4px;
        }
        .l {
          font-size:8px; font-weight:500; letter-spacing:.22em;
          text-transform:uppercase; color:var(--muted);
        }
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
        .btn {
          position:relative; width:76px; height:76px;
          border-radius:50%; border:none; background:transparent; cursor:pointer;
        }
        .btn.dim { opacity:.3; cursor:not-allowed; }
        .ring {
          position:absolute; border-radius:50%;
          border:1px solid rgba(0,200,240,.35);
          animation:pulse 2.2s infinite ease-in-out;
        }
        .r1 { inset:0; }
        .r2 { inset:9px; animation-duration:1.7s; }
        .core {
          position:absolute; inset:22px; border-radius:50%;
          background:var(--cyan); box-shadow:0 0 22px rgba(0,200,240,.65);
        }
        @keyframes pulse {
          0%,100%{opacity:.35;transform:scale(1)}
          50%{opacity:.85;transform:scale(1.05)}
        }
        .hint { font-size:8px; letter-spacing:.28em; color:var(--muted); }
      `}</style>
    </div>
  )
}

function PostScreen({ stats, onDone }: { stats: RunStats; onDone: () => void }) {
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
        <Big value={stats.sqm > 0 ? `${(stats.sqm/1000).toFixed(1)}k` : '—'} label="SQM" accent />
        <div className="sep" />
        <Big value={stats.sqm > 0 ? Math.round(stats.sqm * 0.074).toLocaleString() : '—'} label="POINTS" />
        <div className="sep" />
        <Big value="×2.25" label="BOOST" />
      </div>

      <div className="actions">
        <button className="act confirm" onClick={onDone}>✓</button>
        <button className="act discard" onClick={onDone}>✕</button>
      </div>

      <style jsx>{`
        .post {
          position:absolute; bottom:0; left:0; right:0; z-index:20;
          background:linear-gradient(to bottom,transparent 0%,rgba(10,13,18,.97) 16%,#0a0d12 100%);
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
        .row { display:flex; align-items:stretch; }
        .sep { width:1px; background:var(--line); flex-shrink:0; }
        .divh { height:1px; background:var(--line); }
        .actions {
          display:grid; grid-template-columns:1fr 1fr;
          border-top:1px solid var(--line); margin-top:2px;
        }
        .act {
          height:68px; background:none; border:none;
          font-size:20px; color:var(--muted); cursor:pointer; transition:.15s;
        }
        .confirm { border-right:1px solid var(--line); }
        .confirm:hover { background:rgba(68,255,170,.05); color:var(--green); }
        .discard:hover { background:rgba(255,68,85,.05); color:var(--red); }
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
        .big {
          flex:1; display:flex; flex-direction:column;
          align-items:flex-start; padding:14px 0 14px 20px;
        }
        .bv {
          font-size:32px; font-weight:300; letter-spacing:.02em;
          color:var(--text); line-height:1; margin-bottom:5px;
        }
        .bl { font-size:8px; font-weight:500; letter-spacing:.28em; color:var(--muted); }
        .a .bv { color:var(--cyan); }
      `}</style>
    </div>
  )
}

function BottomBar({ activeTab, onTabChange }: { activeTab:'me'|'team'; onTabChange:(t:'me'|'team')=>void }) {
  return (
    <div className="bar">
      <button className={`tab ${activeTab==='me'?'on':''}`} onClick={()=>onTabChange('me')}>ME</button>
      <button className={`tab ${activeTab==='team'?'on':''}`} onClick={()=>onTabChange('team')}>TEAM</button>
      <style jsx>{`
        .bar {
          position:absolute; bottom:0; left:0; right:0; height:56px;
          display:grid; grid-template-columns:1fr 1fr;
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