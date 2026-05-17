'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import dynamic from 'next/dynamic'
import { supabase } from '@/lib/supabase'
import { distanceKm, estimateSqm, formatPace, formatTime, GPSPoint } from '@/lib/gps'

// Import map component dynamically (no SSR — Leaflet needs window)
const RunMap = dynamic(() => import('@/components/RunMap'), { ssr: false })

// ─── Types ───────────────────────────────────────────────────────────────────

type Screen = 'idle' | 'running' | 'post' | 'team'

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

// ─── Helpers ─────────────────────────────────────────────────────────────────

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
    const adjectives = ['Fast', 'Swift', 'Bold', 'Iron', 'Neon', 'Wild', 'Dark', 'Storm']
    const nouns = ['Stride', 'Pace', 'Dash', 'Bolt', 'Runner', 'Track', 'Miles', 'Route']
    name = adjectives[Math.floor(Math.random() * adjectives.length)] +
           nouns[Math.floor(Math.random() * nouns.length)]
    localStorage.setItem('whoRuns_displayName', name)
  }
  return name
}

// ─── Main App ─────────────────────────────────────────────────────────────────

export default function App() {
  const [screen, setScreen] = useState<Screen>('idle')
  const [activeTab, setActiveTab] = useState<'me' | 'team'>('me')
  const [userId] = useState(generateUserId)
  const [displayName] = useState(generateDisplayName)

  // GPS state
  const [position, setPosition] = useState<GPSPoint | null>(null)
  const [gpsError, setGpsError] = useState<string | null>(null)
  const [route, setRoute] = useState<GPSPoint[]>([])
  const watchIdRef = useRef<number | null>(null)

  // Run state
  const [isRunning, setIsRunning] = useState(false)
  const [startTime, setStartTime] = useState<number | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [stats, setStats] = useState<RunStats>({ distanceKm: 0, durationSec: 0, pace: 0, sqm: 0 })
  const [finalStats, setFinalStats] = useState<RunStats | null>(null)
  const timerRef = useRef<NodeJS.Timeout | null>(null)

  // Team state
  const [teamRunners, setTeamRunners] = useState<TeamRunner[]>([])

  // ── GPS watch ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!navigator.geolocation) {
      setGpsError('GPS not available on this device')
      return
    }

    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const pt: GPSPoint = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          timestamp: Date.now(),
        }
        setPosition(pt)
        setGpsError(null)

        if (isRunning) {
          setRoute((prev) => {
            const updated = [...prev, pt]
            // Recalculate stats
            let totalKm = 0
            for (let i = 1; i < updated.length; i++) {
              totalKm += distanceKm(updated[i - 1], updated[i])
            }
            const durSec = startTime ? (Date.now() - startTime) / 1000 : 0
            const pace = totalKm > 0 ? durSec / totalKm : 0
            setStats({
              distanceKm: totalKm,
              durationSec: durSec,
              pace,
              sqm: estimateSqm(updated),
            })
            return updated
          })

          // Push location to Supabase
          supabase.from('runner_locations').upsert({
            user_id: userId,
            team_id: null,
            display_name: displayName,
            latitude: pt.lat,
            longitude: pt.lng,
            updated_at: new Date().toISOString(),
          })
        }
      },
      (err) => {
        setGpsError(`GPS error: ${err.message}`)
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
    )

    return () => {
      if (watchIdRef.current !== null) {
        navigator.geolocation.clearWatch(watchIdRef.current)
      }
    }
  }, [isRunning, userId, displayName, startTime])

  // ── Timer ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (isRunning) {
      timerRef.current = setInterval(() => {
        setElapsed(startTime ? Math.floor((Date.now() - startTime) / 1000) : 0)
      }, 1000)
    } else {
      if (timerRef.current) clearInterval(timerRef.current)
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [isRunning, startTime])

  // ── Team realtime subscription ────────────────────────────────────────────
  useEffect(() => {
    // Load existing runners
    supabase.from('runner_locations').select('*').then(({ data }: { data: TeamRunner[] | null }) => {
      if (data) setTeamRunners(data as TeamRunner[])
    })

    // Subscribe to live changes
    const channel = supabase
      .channel('runner-locations')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'runner_locations' },
        (payload: { eventType: string; new: TeamRunner }) => {
          setTeamRunners((prev) => {
            const updated = prev.filter((r) => r.user_id !== (payload.new as TeamRunner).user_id)
            if (payload.eventType !== 'DELETE') {
              updated.push(payload.new as TeamRunner)
            }
            return updated
          })
        }
      )
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [])

  // ── Controls ──────────────────────────────────────────────────────────────
  const startRun = useCallback(() => {
    setRoute([])
    setElapsed(0)
    setStats({ distanceKm: 0, durationSec: 0, pace: 0, sqm: 0 })
    setStartTime(Date.now())
    setIsRunning(true)
    setScreen('running')
  }, [])

  const stopRun = useCallback(async () => {
    setIsRunning(false)
    setFinalStats({ ...stats })
    setScreen('post')

    // Save session to Supabase
    if (route.length > 1) {
      await supabase.from('run_sessions').insert({
        user_id: userId,
        team_id: null,
        distance_km: stats.distanceKm,
        duration_seconds: stats.durationSec,
        pace_per_km: stats.pace,
        sqm_covered: stats.sqm,
        started_at: new Date(startTime!).toISOString(),
        ended_at: new Date().toISOString(),
        route: route.map((p) => [p.lat, p.lng]),
      })
    }

    // Remove from live map
    await supabase.from('runner_locations').delete().eq('user_id', userId)
  }, [stats, route, userId, startTime])

  // ─────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div className="app-shell">
      {/* GPS Error Banner */}
      {gpsError && (
        <div className="gps-banner">
          <span>⚠ {gpsError}</span>
        </div>
      )}

      {/* ── IDLE SCREEN ── */}
      {(screen === 'idle' || screen === 'post') && activeTab === 'me' && (
        <div className="screen">
          <div className="map-fill">
            <RunMap
              center={position ? [position.lat, position.lng] : [33.89455, 35.50285]}
              myPosition={position}
              route={route}
              teamRunners={[]}
              zoom={16}
            />
          </div>

          <div className="top-strip">
            <StatCell label="KM" value={stats.distanceKm.toFixed(2)} accent />
            <StatCell label="Pace" value={formatPace(stats.pace)} />
            <StatCell label="Time" value={formatTime(elapsed)} />
            <StatCell label="SQM" value={stats.sqm.toLocaleString()} />
          </div>

          {screen === 'post' && finalStats ? (
            <PostRunOverlay stats={finalStats} onDone={() => {
              setScreen('idle')
              setStats({ distanceKm: 0, durationSec: 0, pace: 0, sqm: 0 })
              setElapsed(0)
            }} />
          ) : (
            <StartButton onStart={startRun} hasGps={!!position} />
          )}

          <BottomBar activeTab={activeTab} onTabChange={setActiveTab} />
        </div>
      )}

      {/* ── RUNNING SCREEN ── */}
      {screen === 'running' && (
        <div className="screen">
          <div className="map-fill">
            <RunMap
              center={position ? [position.lat, position.lng] : [33.89455, 35.50285]}
              myPosition={position}
              route={route}
              teamRunners={[]}
              zoom={17}
              followUser
            />
          </div>

          <div className="top-strip">
            <StatCell label="KM" value={stats.distanceKm.toFixed(2)} accent />
            <StatCell label="Pace" value={formatPace(stats.pace)} />
            <StatCell label="Time" value={formatTime(elapsed)} />
            <StatCell label="SQM" value={stats.sqm.toLocaleString()} />
          </div>

          <div className="time-readout">{formatTime(elapsed)}</div>

          <div className="stop-dock">
            <button className="stop-button" onClick={stopRun} aria-label="Stop run">
              <div className="stop-core" />
            </button>
          </div>
        </div>
      )}

      {/* ── TEAM SCREEN ── */}
      {activeTab === 'team' && screen !== 'running' && (
        <div className="screen">
          <div className="map-fill">
            <RunMap
              center={position ? [position.lat, position.lng] : [33.89455, 35.50285]}
              myPosition={position}
              route={[]}
              teamRunners={teamRunners}
              zoom={15}
            />
          </div>

          <div className="top-strip">
            <StatCell label="Online" value={String(teamRunners.length)} accent />
            <StatCell label="Area" value="BRC" />
            <StatCell label="SQM" value={(teamRunners.length * 52000).toLocaleString()} />
            <StatCell label="Rank" value="#1" />
          </div>

          <div className="team-panel">
            <div className="panel-head">
              <div>
                <div className="panel-title">Live Runners</div>
                <div className="panel-sub">real-time GPS positions</div>
              </div>
            </div>
            <div className="runner-list">
              {teamRunners.length === 0 && (
                <div className="runner-empty">No runners active right now</div>
              )}
              {teamRunners.map((r) => (
                <div key={r.user_id} className="runner-row">
                  <div className="runner-dot" />
                  <div className="runner-name">{r.display_name || r.user_id.slice(0, 12)}</div>
                  <div className="runner-time">
                    {Math.round((Date.now() - new Date(r.updated_at).getTime()) / 1000)}s ago
                  </div>
                </div>
              ))}
            </div>
          </div>

          <BottomBar activeTab={activeTab} onTabChange={setActiveTab} />
        </div>
      )}

      <style jsx>{`
        .app-shell {
          position: fixed;
          inset: 0;
          background: var(--bg);
          display: flex;
          flex-direction: column;
        }
        .screen {
          position: relative;
          width: 100%;
          height: 100%;
          overflow: hidden;
        }
        .map-fill {
          position: absolute;
          inset: 0;
        }
        .gps-banner {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          z-index: 999;
          background: var(--red);
          color: white;
          text-align: center;
          padding: 6px 12px;
          font-size: 11px;
          letter-spacing: 0.1em;
        }
        .top-strip {
          position: absolute;
          top: 0; left: 0; right: 0;
          height: 60px;
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          background: var(--panel);
          border-bottom: 1px solid var(--line);
          backdrop-filter: blur(14px);
          z-index: 10;
        }
        .time-readout {
          position: absolute;
          left: 50%;
          top: 38%;
          transform: translate(-50%, -50%);
          font-family: var(--font-display);
          font-size: 52px;
          font-weight: 800;
          color: var(--text);
          letter-spacing: -0.04em;
          text-shadow: 0 0 40px rgba(0,216,255,0.3);
          z-index: 10;
          pointer-events: none;
        }
        .stop-dock {
          position: absolute;
          bottom: 36px;
          left: 50%;
          transform: translateX(-50%);
          z-index: 10;
        }
        .stop-button {
          width: 72px;
          height: 72px;
          border-radius: 50%;
          border: 2px solid rgba(255,90,103,0.6);
          background: rgba(255,90,103,0.1);
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          transition: all 0.15s;
        }
        .stop-button:active {
          transform: scale(0.95);
          background: rgba(255,90,103,0.25);
        }
        .stop-core {
          width: 28px;
          height: 28px;
          background: var(--red);
          border-radius: 4px;
          box-shadow: 0 0 20px rgba(255,90,103,0.6);
        }
        .team-panel {
          position: absolute;
          bottom: 56px;
          left: 12px;
          right: 12px;
          background: var(--panel);
          border: 1px solid var(--line);
          border-radius: 16px;
          backdrop-filter: blur(20px);
          z-index: 10;
          padding: 14px 16px;
          max-height: 220px;
          overflow-y: auto;
        }
        .panel-head {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          margin-bottom: 10px;
        }
        .panel-title {
          font-family: var(--font-display);
          font-size: 14px;
          font-weight: 700;
          color: var(--text);
        }
        .panel-sub {
          font-size: 9px;
          letter-spacing: 0.2em;
          text-transform: uppercase;
          color: var(--muted);
          margin-top: 2px;
        }
        .runner-list { display: flex; flex-direction: column; gap: 6px; }
        .runner-empty { font-size: 11px; color: var(--muted); text-align: center; padding: 12px 0; }
        .runner-row {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 6px 0;
          border-bottom: 1px solid var(--line);
        }
        .runner-row:last-child { border-bottom: none; }
        .runner-dot {
          width: 8px; height: 8px;
          border-radius: 50%;
          background: var(--cyan);
          box-shadow: 0 0 8px var(--cyan);
          flex-shrink: 0;
        }
        .runner-name { flex: 1; font-size: 12px; color: var(--text); }
        .runner-time { font-size: 10px; color: var(--muted); }
      `}</style>
    </div>
  )
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatCell({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={`stat-cell ${accent ? 'accent' : ''}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      <style jsx>{`
        .stat-cell {
          display: flex;
          flex-direction: column;
          justify-content: center;
          padding-left: 14px;
          border-right: 1px solid var(--line);
        }
        .stat-cell:last-child { border-right: none; }
        .stat-label {
          font-size: 7px;
          letter-spacing: 0.2em;
          text-transform: uppercase;
          color: var(--muted);
          margin-bottom: 4px;
        }
        .stat-value {
          font-family: var(--font-display);
          font-size: 17px;
          font-weight: 700;
          letter-spacing: -0.03em;
          color: var(--text);
        }
        .accent .stat-label,
        .accent .stat-value { color: var(--cyan); }
      `}</style>
    </div>
  )
}

function StartButton({ onStart, hasGps }: { onStart: () => void; hasGps: boolean }) {
  return (
    <div className="start-dock">
      <button className={`start-button ${!hasGps ? 'no-gps' : ''}`} onClick={onStart} disabled={!hasGps}>
        <div className="start-ring r1" />
        <div className="start-ring r2" />
        <div className="start-core" />
      </button>
      {!hasGps && <div className="gps-hint">Waiting for GPS…</div>}
      <style jsx>{`
        .start-dock {
          position: absolute;
          bottom: 80px;
          left: 50%;
          transform: translateX(-50%);
          z-index: 10;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 12px;
        }
        .start-button {
          position: relative;
          width: 80px;
          height: 80px;
          border-radius: 50%;
          border: none;
          background: transparent;
          cursor: pointer;
        }
        .start-button.no-gps { opacity: 0.4; cursor: not-allowed; }
        .start-ring {
          position: absolute;
          border-radius: 50%;
          border: 1px solid rgba(0,216,255,0.5);
          animation: pulse 2.3s infinite ease-in-out;
        }
        .r1 { inset: 0; }
        .r2 { inset: 8px; animation-duration: 1.7s; }
        .start-core {
          position: absolute;
          inset: 22px;
          border-radius: 50%;
          background: var(--cyan);
          box-shadow: 0 0 24px rgba(0,216,255,0.8);
        }
        @keyframes pulse {
          0%, 100% { opacity: 0.5; transform: scale(1); }
          50% { opacity: 1; transform: scale(1.05); }
        }
        .gps-hint {
          font-size: 10px;
          letter-spacing: 0.15em;
          text-transform: uppercase;
          color: var(--muted);
        }
      `}</style>
    </div>
  )
}

function PostRunOverlay({ stats, onDone }: { stats: RunStats; onDone: () => void }) {
  return (
    <div className="post-overlay">
      <div className="wordmark">Who Runs</div>
      <div className="post-grid">
        <div className="post-metric">
          <div className="post-value">{stats.distanceKm.toFixed(2)}</div>
          <div className="post-label">KM</div>
        </div>
        <div className="post-metric">
          <div className="post-value">{formatPace(stats.pace)}</div>
          <div className="post-label">Pace</div>
        </div>
        <div className="post-metric">
          <div className="post-value">{formatTime(stats.durationSec)}</div>
          <div className="post-label">Time</div>
        </div>
        <div className="post-metric">
          <div className="post-value cyan">{stats.sqm.toLocaleString()}</div>
          <div className="post-label">SQM</div>
        </div>
      </div>
      <div className="post-actions">
        <button className="done-btn" onClick={onDone}>Done</button>
      </div>
      <style jsx>{`
        .post-overlay {
          position: absolute;
          bottom: 0; left: 0; right: 0;
          z-index: 20;
          padding: 32px 24px 80px;
          background: linear-gradient(180deg, transparent 0%, rgba(4,7,11,0.95) 40%, #04070b 100%);
        }
        .wordmark {
          font-family: var(--font-display);
          font-size: 11px;
          font-weight: 800;
          letter-spacing: 0.4em;
          text-transform: uppercase;
          color: var(--cyan);
          margin-bottom: 20px;
        }
        .post-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 16px;
          margin-bottom: 24px;
        }
        .post-metric { display: flex; flex-direction: column; gap: 4px; }
        .post-value {
          font-family: var(--font-display);
          font-size: 36px;
          font-weight: 800;
          letter-spacing: -0.04em;
          color: var(--text);
        }
        .post-value.cyan { color: var(--cyan); }
        .post-label {
          font-size: 9px;
          letter-spacing: 0.2em;
          text-transform: uppercase;
          color: var(--muted);
        }
        .post-actions { display: flex; gap: 12px; }
        .done-btn {
          flex: 1;
          padding: 14px;
          border-radius: 12px;
          background: var(--cyan);
          color: #04070b;
          border: none;
          font-family: var(--font-display);
          font-size: 13px;
          font-weight: 800;
          letter-spacing: 0.1em;
          text-transform: uppercase;
          cursor: pointer;
        }
      `}</style>
    </div>
  )
}

function BottomBar({
  activeTab,
  onTabChange,
}: {
  activeTab: 'me' | 'team'
  onTabChange: (tab: 'me' | 'team') => void
}) {
  return (
    <div className="bottom-bar">
      <button className={`tab ${activeTab === 'me' ? 'active' : ''}`} onClick={() => onTabChange('me')}>Me</button>
      <button className={`tab ${activeTab === 'team' ? 'active' : ''}`} onClick={() => onTabChange('team')}>Team</button>
      <style jsx>{`
        .bottom-bar {
          position: absolute;
          bottom: 0; left: 0; right: 0;
          height: 56px;
          display: grid;
          grid-template-columns: 1fr 1fr;
          background: var(--panel);
          border-top: 1px solid var(--line);
          backdrop-filter: blur(14px);
          z-index: 10;
        }
        .tab {
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 10px;
          letter-spacing: 0.28em;
          text-transform: uppercase;
          color: var(--muted);
          background: none;
          border: none;
          cursor: pointer;
          border-right: 1px solid var(--line);
        }
        .tab:last-child { border-right: none; }
        .tab.active { color: var(--text); background: rgba(255,255,255,0.02); }
      `}</style>
    </div>
  )
}
