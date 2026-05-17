import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

export const supabase = createClient(supabaseUrl, supabaseAnonKey)

export type RunnerLocation = {
  id?: string
  user_id: string
  team_id: string | null
  latitude: number
  longitude: number
  display_name: string | null
  updated_at: string
}

export type RunSession = {
  id?: string
  user_id: string
  team_id: string | null
  distance_km: number
  duration_seconds: number
  pace_per_km: number
  sqm_covered: number
  started_at: string
  ended_at: string | null
  route: Array<[number, number]>
}
